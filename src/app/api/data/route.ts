/**
 * @file route.ts
 * @module app/api/data/route
 * @description Primary data streaming endpoint serving longitudinal biomarker records, Pearson correlation matrices, and summary statistics.
 *
 * Query execution flow:
 * 1. Validates incoming JSON payload (date bounds, biomarker list, patient ID, row limit) via Zod.
 * 2. Fetches matching records from the active data source (Local CSV -> BigQuery -> Demo).
 * 3. Extracts distinct biomarker lists and clinical panel groupings.
 * 4. Computes Pearson correlation matrix (\(N \times N\)) across same-visit biomarker pairs.
 * 5. Computes cohort summary statistics (mean, std, min, max, n) for each biomarker.
 * 6. Returns structured `DataResponse` payload.
 *
 * @example
 * ```bash
 * curl -X POST http://localhost:3000/api/data \
 *   -H "Content-Type: application/json" \
 *   -d '{"dateFrom": "2018-08-24", "dateTo": "2019-07-24", "rowLimit": 5000}'
 * ```
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getServerEnv,
  isDemoMode,
  parseBigQueryViewNames,
} from "@/lib/env";
import { queryBiomarkerLong } from "@/lib/bigquery";
import { queryLocalBiomarkers } from "@/lib/local-dataset";
import { generateDemoRows } from "@/lib/demo-data";
import { correlationMatrix, summaryStats } from "@/lib/stats";
import type { DataResponse } from "@/types";

/**
 * Validation schema for the POST request body.
 */
const bodySchema = z.object({
  /** Start date in YYYY-MM-DD format (inclusive) */
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid dateFrom format (expected YYYY-MM-DD)"),
  /** End date in YYYY-MM-DD format (inclusive) */
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid dateTo format (expected YYYY-MM-DD)"),
  /** Optional array of biomarker names to filter */
  biomarkers: z.array(z.string()).optional(),
  /** Maximum number of records to return (100 to 200,000, default 80,000) */
  rowLimit: z.number().int().min(100).max(200000).optional().default(80000),
  /** Optional specific patient ID to filter */
  patientId: z.string().optional(),
});

/**
 * Handles HTTP POST requests to query longitudinal biomarker observation data.
 *
 * @param req - HTTP Request containing JSON body matching `bodySchema`
 * @returns JSON response containing `DataResponse` object or validation error.
 */
export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { dateFrom, dateTo, biomarkers, rowLimit, patientId } = parsed.data;
  const env = getServerEnv();

  let rows;
  let source: DataResponse["source"] = "local_csv";
  let demoReason: string | undefined;
  let allBiomarkers: string[] | undefined;
  let biomarkerGroups: Record<string, string[]> | undefined;
  let minDate = dateFrom;
  let maxDate = dateTo;

  const viewNames = parseBigQueryViewNames(env);
  const hasUnion = viewNames.length > 0;
  const tableFqn = env.BIGQUERY_TABLE_FQN ?? "";
  const placeholderTable =
    tableFqn.includes("REPLACE_ME") || tableFqn.endsWith(".A2.");
  const hasSingle = Boolean(tableFqn) && !placeholderTable;

  const forceBigQuery = process.env.DATA_SOURCE === "bigquery";
  const useBigQuery =
    forceBigQuery &&
    !isDemoMode() &&
    Boolean(env.GCP_PROJECT_ID) &&
    (hasUnion || hasSingle);

  if (isDemoMode()) {
    demoReason = "DEMO_MODE=true — using synthetic demo data.";
    rows = generateDemoRows({ dateFrom, dateTo, biomarkerFilter: biomarkers, patientId });
    source = "demo";
  } else if (useBigQuery) {
    // Attempt BigQuery querying
    try {
      rows = await queryBiomarkerLong(env, {
        dateFrom,
        dateTo,
        biomarkers,
        rowLimit,
        patientId,
      });
      source = "bigquery";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("BigQuery query failed, falling back to local CSV dataset:", msg);
      try {
        const localRes = queryLocalBiomarkers({
          dateFrom,
          dateTo,
          biomarkers,
          patientId,
          rowLimit,
        });
        rows = localRes.rows;
        allBiomarkers = localRes.biomarkers;
        biomarkerGroups = localRes.biomarkerGroups;
        minDate = localRes.dateRange.min;
        maxDate = localRes.dateRange.max;
        source = "local_csv";
      } catch (localErr) {
        demoReason = `BigQuery and Local CSV failed: ${msg}`;
        rows = generateDemoRows({ dateFrom, dateTo, biomarkerFilter: biomarkers, patientId });
        source = "demo";
      }
    }
  } else {
    // Default / Preferred: Local Medical Records CSV Engine
    try {
      const localRes = queryLocalBiomarkers({
        dateFrom,
        dateTo,
        biomarkers,
        patientId,
        rowLimit,
      });
      rows = localRes.rows;
      allBiomarkers = localRes.biomarkers;
      biomarkerGroups = localRes.biomarkerGroups;
      minDate = localRes.dateRange.min;
      maxDate = localRes.dateRange.max;
      source = "local_csv";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Local CSV error, falling back to demo:", e);
      demoReason = `Local CSV query failed: ${msg}`;
      rows = generateDemoRows({ dateFrom, dateTo, biomarkerFilter: biomarkers, patientId });
      source = "demo";
    }
  }

  // Derive biomarker list and groups if not already provided by the loader
  if (!allBiomarkers) {
    const biomarkerSet = new Set(rows.map((r) => r.biomarker));
    allBiomarkers = Array.from(biomarkerSet).sort();
  }

  if (!biomarkerGroups) {
    biomarkerGroups = {};
    for (const r of rows) {
      if (r.group && r.biomarker) {
        if (!biomarkerGroups[r.group]) {
          biomarkerGroups[r.group] = [];
        }
        if (!biomarkerGroups[r.group].includes(r.biomarker)) {
          biomarkerGroups[r.group].push(r.biomarker);
        }
      }
    }
  }

  // Calculate correlation matrix and summary statistics across active markers
  const correlation = correlationMatrix(rows, allBiomarkers);
  const summary = summaryStats(rows, allBiomarkers);

  const payload: DataResponse = {
    source,
    ...(demoReason ? { demoReason } : {}),
    rows,
    biomarkers: allBiomarkers,
    biomarkerGroups: Object.keys(biomarkerGroups).length > 0 ? biomarkerGroups : undefined,
    dateRange: {
      min: minDate,
      max: maxDate,
    },
    rowCount: rows.length,
    correlation,
    summary,
  };

  return NextResponse.json(payload);
}
