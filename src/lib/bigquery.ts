/**
 * @file bigquery.ts
 * @module lib/bigquery
 * @description Google Cloud BigQuery client and dynamic UNPIVOT / UNION ALL query engine.
 *
 * This module dynamically discovers numeric biomarker columns across 14 analytics views
 * using BigQuery's `INFORMATION_SCHEMA.COLUMNS`, generates SQL `UNPIVOT` branches on the fly,
 * and streams longitudinal biomarker observation records into standard `BiomarkerRow[]` format.
 *
 * @example
 * ```ts
 * import { queryBiomarkerLong, queryDistinctPatients } from "@/lib/bigquery";
 * import { getServerEnv } from "@/lib/env";
 *
 * const env = getServerEnv();
 * const patients = await queryDistinctPatients(env);
 * const rows = await queryBiomarkerLong(env, {
 *   dateFrom: "2018-08-24",
 *   dateTo: "2019-07-24",
 *   rowLimit: 10000,
 * });
 * ```
 */

import { BigQuery } from "@google-cloud/bigquery";
import type { BiomarkerRow } from "@/types";
import type { AppEnv } from "@/lib/env";
import { parseBigQueryViewNames } from "@/lib/env";

/** Regular expression validating dataset identifier safety to prevent SQL injection */
const datasetIdSafe = /^[A-Za-z0-9_]+$/;

/**
 * Validates that a BigQuery dataset identifier contains only alphanumeric characters and underscores.
 *
 * @param id - Dataset identifier to validate
 * @throws Error if the dataset identifier contains invalid characters
 */
function assertDatasetId(id: string) {
  if (!datasetIdSafe.test(id)) {
    throw new Error(`Invalid BIGQUERY_DATASET: ${id}`);
  }
}

/**
 * Queries BigQuery's `INFORMATION_SCHEMA.COLUMNS` to identify all numeric columns
 * across the specified view tables, excluding demographic and metadata columns.
 *
 * @param client - Authenticated BigQuery client instance
 * @param project - GCP Project ID
 * @param dataset - BigQuery Dataset name (e.g., 'A2')
 * @param viewNames - List of view table names to inspect
 * @param ignoreCols - Array of column names to exclude (e.g., patient ID, visit date)
 * @returns Dictionary mapping table name to array of numeric column names
 */
async function getNumericColumns(
  client: BigQuery,
  project: string,
  dataset: string,
  viewNames: string[],
  ignoreCols: string[]
): Promise<Record<string, string[]>> {
  if (viewNames.length === 0) return {};
  
  const sql = `
    SELECT table_name, column_name
    FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
    WHERE table_name IN UNNEST(@viewNames)
      AND data_type IN ('INT64', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC')
  `;
  
  const [job] = await client.createQueryJob({
    query: sql,
    params: { viewNames },
  });
  
  const [rows] = await job.getQueryResults();
  
  const ignoreSet = new Set(ignoreCols.map(c => c.toLowerCase()));
  const result: Record<string, string[]> = {};
  
  for (const row of rows) {
    const t = row.table_name;
    const c = row.column_name;
    if (!ignoreSet.has(c.toLowerCase())) {
      if (!result[t]) result[t] = [];
      result[t].push(c);
    }
  }
  
  return result;
}

/**
 * Constructs an SQL UNPIVOT query branch for a specific BigQuery table/view.
 * Transposes wide-format biomarker columns into long-format (patient_id, visit_date, biomarker, value).
 *
 * @param fullTableId - Fully qualified table path (`project.dataset.table`)
 * @param tableName - Short name of the view/table (used as group category)
 * @param cols - Array of numeric column names to unpivot
 * @param pid - Patient ID column alias
 * @param vd - Visit Date column alias
 * @param includeBiomarkerFilter - Whether to append biomarker whitelist filtering
 * @param hasPatientId - Whether to append patient ID equality filter
 * @returns Formatted SQL SELECT UNPIVOT branch string
 */
function buildUnpivotBranch(
  fullTableId: string,
  tableName: string,
  cols: string[],
  pid: string,
  vd: string,
  includeBiomarkerFilter: boolean,
  hasPatientId: boolean
): string {
  if (!cols || cols.length === 0) return '';
  
  const quotedCols = cols.map(c => `\`${c}\``).join(', ');
  const castCols = cols.map(c => `CAST(\`${c}\` AS FLOAT64) AS \`${c}\``).join(',\n      ');
  
  let branch = `
    SELECT
      CAST(\`${pid}\` AS STRING) AS patient_id,
      FORMAT_DATE('%Y-%m-%d', DATE(\`${vd}\`)) AS visit_date,
      CAST(biomarker AS STRING) AS biomarker,
      value,
      '${tableName}' AS \`group\`
    FROM (
      SELECT
        \`${pid}\`,
        \`${vd}\`,
        ${castCols}
      FROM \`${fullTableId}\`
    )
    UNPIVOT(
      value FOR biomarker IN (${quotedCols})
    )
    WHERE DATE(\`${vd}\`) BETWEEN @dateFrom AND @dateTo
  `;
  
  if (includeBiomarkerFilter) {
    branch += ` AND biomarker IN UNNEST(@biomarkers)`;
  }
  if (hasPatientId) {
    branch += ` AND CAST(\`${pid}\` AS STRING) = @patientId`;
  }
  
  return branch.trim();
}

/**
 * Queries BigQuery across multiple fact views using dynamic UNPIVOT and UNION ALL.
 *
 * @param env - Application configuration environment
 * @param params - Date boundaries, biomarker filters, row limits, and optional patient ID
 * @throws Error if GCP_PROJECT_ID is missing or view configuration is invalid
 * @returns Array of unpivoted `BiomarkerRow` objects
 */
export async function queryBiomarkerLong(
  env: AppEnv,
  params: {
    dateFrom: string;
    dateTo: string;
    biomarkers?: string[];
    rowLimit: number;
    patientId?: string;
  },
): Promise<BiomarkerRow[]> {
  const project = env.GCP_PROJECT_ID;
  if (!project) {
    throw new Error("GCP_PROJECT_ID is required");
  }

  const client = new BigQuery({
    projectId: project,
    location: env.BIGQUERY_LOCATION,
  });

  const pid = env.BQ_COL_PATIENT_ID;
  const vd = env.BQ_COL_VISIT_DATE;
  const ignoreCols = [pid, vd, 'First_Name', 'Last_Name', 'Gender', 'Age_Category'];

  let dataset = env.BIGQUERY_DATASET;
  let viewNames = parseBigQueryViewNames(env);
  let isSingleTable = false;
  let singleTableFqn = env.BIGQUERY_TABLE_FQN;

  if (viewNames.length === 0) {
    if (!singleTableFqn) {
      throw new Error("Set BIGQUERY_VIEW_NAMES or BIGQUERY_TABLE_FQN with GCP_PROJECT_ID for BigQuery");
    }
    // Parse dataset and table from FQN: project.dataset.table
    const parts = singleTableFqn.split('.');
    if (parts.length >= 2) {
      dataset = parts[parts.length - 2];
      viewNames = [parts[parts.length - 1]];
      isSingleTable = true;
    } else {
      throw new Error(`Invalid BIGQUERY_TABLE_FQN: ${singleTableFqn}. Must be project.dataset.table`);
    }
  } else {
    assertDatasetId(dataset);
  }

  const biomarkers = params.biomarkers?.filter(Boolean);
  const includeBm = Boolean(biomarkers?.length);
  const hasPatientId = Boolean(params.patientId?.trim());

  // Dynamically inspect column data types from INFORMATION_SCHEMA
  const tableColumns = await getNumericColumns(client, project, dataset, viewNames, ignoreCols);

  const branches: string[] = [];
  for (const name of viewNames) {
    const cols = tableColumns[name] || [];
    const fullId = isSingleTable ? singleTableFqn! : `${project}.${dataset}.${name}`;
    const branch = buildUnpivotBranch(fullId, name, cols, pid, vd, includeBm, hasPatientId);
    if (branch) branches.push(branch);
  }

  if (branches.length === 0) {
    return []; // No numeric columns found to unpivot
  }

  const sql = `
    SELECT * FROM (
      ${branches.join("\n    UNION ALL\n")}
    ) AS _union_all
    ORDER BY visit_date, patient_id, biomarker
    LIMIT @rowLimit
  `;

  const queryParams: Record<string, string | number | string[] | undefined> = {
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    rowLimit: params.rowLimit,
  };

  if (includeBm) {
    queryParams.biomarkers = biomarkers;
  }
  if (hasPatientId) {
    queryParams.patientId = params.patientId;
  }

  const [job] = await client.createQueryJob({
    query: sql,
    params: queryParams,
    maximumBytesBilled: "5000000000",
  });

  const [rows] = await job.getQueryResults();
  return rows.map((r) => ({
    patient_id: String(r.patient_id ?? ""),
    visit_date: String(r.visit_date ?? ""),
    biomarker: String(r.biomarker ?? ""),
    value: Number(r.value),
    group: r.group ? String(r.group) : undefined,
  }));
}

/**
 * Queries all distinct patient IDs from the primary BigQuery dataset view.
 *
 * @param env - Application configuration environment
 * @throws Error if GCP_PROJECT_ID is missing or view configuration is invalid
 * @returns Sorted array of unique patient ID strings
 */
export async function queryDistinctPatients(env: AppEnv): Promise<string[]> {
  const project = env.GCP_PROJECT_ID;
  if (!project) {
    throw new Error("GCP_PROJECT_ID is required");
  }

  const client = new BigQuery({
    projectId: project,
    location: env.BIGQUERY_LOCATION,
  });

  const pid = env.BQ_COL_PATIENT_ID;

  let dataset = env.BIGQUERY_DATASET;
  let viewNames = parseBigQueryViewNames(env);
  let isSingleTable = false;
  let singleTableFqn = env.BIGQUERY_TABLE_FQN;

  if (viewNames.length === 0) {
    if (!singleTableFqn) {
      throw new Error("Set BIGQUERY_VIEW_NAMES or BIGQUERY_TABLE_FQN with GCP_PROJECT_ID for BigQuery");
    }
    const parts = singleTableFqn.split('.');
    if (parts.length >= 2) {
      dataset = parts[parts.length - 2];
      viewNames = [parts[parts.length - 1]];
      isSingleTable = true;
    } else {
      throw new Error(`Invalid BIGQUERY_TABLE_FQN: ${singleTableFqn}`);
    }
  }

  if (viewNames.length === 0) return [];

  // Query distinct patients from first view table (all views share the cohort dimension)
  const name = viewNames[0];
  const fullId = isSingleTable ? singleTableFqn! : `${project}.${dataset}.${name}`;

  const sql = `
    SELECT DISTINCT CAST(\`${pid}\` AS STRING) AS patient_id
    FROM \`${fullId}\`
    WHERE \`${pid}\` IS NOT NULL
    ORDER BY 1
  `;

  const [job] = await client.createQueryJob({ query: sql });
  const [rows] = await job.getQueryResults();
  return rows.map((r) => String(r.patient_id));
}
