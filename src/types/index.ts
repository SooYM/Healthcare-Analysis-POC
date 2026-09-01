/**
 * @file index.ts
 * @module types
 * @description Core TypeScript type definitions for the Healthcare Dashboard.
 */

/**
 * Long-format biomarker observation row representing a single lab test measurement.
 */
export type BiomarkerRow = {
  /** Unique patient identifier */
  patient_id: string;
  /** Observation date in ISO format (YYYY-MM-DD) */
  visit_date: string;
  /** Standardized biomarker identifier matching `CLINICAL_RANGES` */
  biomarker: string;
  /** Numeric test result measurement */
  value: number;
  /** Clinical panel group name (e.g., 'CBC', 'Lipid Profile', 'Liver Function') */
  group?: string;
};

/**
 * Structured API response envelope returned by `/api/data`.
 */
export type DataResponse = {
  /** Active data ingestion source */
  source: "bigquery" | "demo" | "local_csv" | "csv";
  /** Descriptive message explaining fallback reason if synthetic demo data is active */
  demoReason?: string;
  /** Array of long-format observation rows matching filter criteria */
  rows: BiomarkerRow[];
  /** Sorted list of all distinct biomarker names available in active cohort */
  biomarkers: string[];
  /** Clinical panel mapping dictionary `{ [groupName]: biomarkerNames[] }` */
  biomarkerGroups?: Record<string, string[]>;
  /** Earliest and latest observation dates present in dataset */
  dateRange: { min: string; max: string };
  /** Total count of rows returned in current slice */
  rowCount: number;
  /** Pairwise Pearson correlation matrix \(r \in [-1, 1]\) */
  correlation?: Record<string, Record<string, number>>;
  /** Cohort summary statistics for each biomarker */
  summary?: Record<
    string,
    { mean: number; std: number; min: number; max: number; n: number }
  >;
};
