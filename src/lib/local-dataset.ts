/**
 * @file local-dataset.ts
 * @module lib/local-dataset
 * @description High-performance in-memory dataset loader, parser, and indexer for local medical records.
 *
 * This module provides zero-dependency, zero-cloud data loading for the Healthcare Dashboard.
 * It reads the raw `Medical Records.csv` file (13,848 rows, 1,154 patients, 96 columns),
 * parses multiple date representations (including Excel serial dates and international formats),
 * normalizes 78 numeric biomarker measures across 14 clinical panels, and builds indexed
 * in-memory lookup structures for sub-millisecond cohort queries.
 *
 * @example
 * ```ts
 * // 1. Retrieve all unique patient identifiers and total visit counts
 * const { patientIds, totalReports } = getLocalPatients();
 *
 * // 2. Query longitudinal biomarker records for a specific patient or cohort
 * const result = queryLocalBiomarkers({
 *   dateFrom: "2018-08-24",
 *   dateTo: "2019-07-24",
 *   patientId: "560252",
 *   biomarkers: ["Hemoglobin", "Total_Cholesterol", "HbA1c"],
 *   rowLimit: 5000,
 * });
 * console.log(`Loaded ${result.rowCount} records across ${result.biomarkers.length} biomarkers`);
 * ```
 */

import fs from "fs";
import path from "path";
import type { BiomarkerRow } from "@/types";

/**
 * Internal representation of a normalized, unpivoted biomarker observation record.
 */
export type LocalDatasetRecord = {
  /** Unique patient identifier (e.g., '560252') */
  patient_id: string;
  /** ISO-8601 formatted visit date (YYYY-MM-DD) */
  visit_date: string;
  /** Normalized clinical biomarker name matching CLINICAL_RANGES */
  biomarker: string;
  /** Numeric measured observation value */
  value: number;
  /** Clinical panel group name (e.g., 'CBC', 'Lipid Profile', 'Liver Function') */
  group: string;
};

/**
 * Internal column mapping definition linking CSV column indices to clinical entities.
 */
type ColumnDef = {
  /** 0-indexed position in CSV header */
  idx: number;
  /** Original raw column header in CSV */
  rawName: string;
  /** Cleaned, standardized biomarker identifier */
  cleanName: string;
  /** Clinical category panel name */
  group: string;
};

/**
 * Mapping dictionary translating heterogeneous raw CSV column headers
 * into canonical clinical biomarker identifiers matching `CLINICAL_RANGES`.
 */
const COLUMN_MAPPING: Record<string, string> = {
  // ── CBC (Complete Blood Count) ──
  "Hemoglobin (g/dL)": "Hemoglobin",
  "RBC Count (mil/µL)": "RBC_Count",
  "Hematocrit %": "Hematocrit",
  "MCV (fL)": "MCV",
  "MCH (pg)": "MCH",
  "MCHC (g/dL)": "MCHC",
  "RDW-CV %": "RDW_CV",
  "RDW-SD (fL)": "RDW_SD",
  "WBC (cells/µL)": "WBC_Count",
  "Neutrophils %": "Neutrophils",
  "Lymphocytes %": "Lymphocytes",
  "Eosinophils %": "Eosinophils",
  "Monocytes %": "Monocytes",
  "Basophils %": "Basophils",
  "Abs Neutrophils": "Abs_Neutrophils",
  "Abs Lymphocytes": "Abs_Lymphocytes",
  "Abs Monocytes": "Abs_Monocytes",
  "Abs Eosinophils": "Abs_Eosinophils",
  "Abs Basophils": "Abs_Basophils",

  // ── Platelet Profile ──
  "Platelet Count (×10^3/µL)": "Platelet_Count",
  "MPV (fL)": "MPV",
  "Platelet RDW %": "Platelet_RDW",
  "PCT %": "PCT",
  "P-LCR %": "P_LCR",
  "IMG %": "IMG",
  "IMM %": "IMM",
  "IML %": "IML",
  "LIC %": "LIC",

  // ── Lipid Profile ──
  "Total Cholesterol (mg/dL)": "Total_Cholesterol",
  "HDL (mg/dL)": "HDL",
  "LDL (mg/dL)": "LDL",
  "VLDL (mg/dL)": "VLDL",
  "Triglycerides (mg/dL)": "Triglycerides",
  "Non-HDL (mg/dL)": "Non_HDL",
  "Total/HDL Ratio": "Total_HDL_Ratio",
  "LDL/HDL Ratio": "LDL_HDL_Ratio",
  "HDL/LDL Ratio": "HDL_LDL_Ratio",

  // ── Liver Function ──
  "Bilirubin Total (mg/dL)": "Bilirubin_Total",
  "Bilirubin Direct (mg/dL)": "Bilirubin_Direct",
  "Bilirubin Indirect (mg/dL)": "Bilirubin_Indirect",
  "ALP (U/L)": "ALP",
  "ALT/SGPT (U/L)": "ALT_SGPT",
  "AST/SGOT (U/L)": "AST_SGOT",
  "GGT (U/L)": "GGT",
  "Protein Total (g/dL)": "Protein_Total",
  "Albumin (g/dL)": "Albumin",
  "Globulin (g/dL)": "Globulin",
  "A/G Ratio": "A_G_Ratio",

  // ── Kidney Function ──
  "Creatinine (mg/dL)": "Creatinine",
  "Urea (mg/dL)": "Urea",
  "BUN (mg/dL)": "BUN",
  "BUN/Creatinine Ratio": "BUN_Creatinine_Ratio",
  "Sodium (mmol/L)": "Sodium",
  "Potassium (mmol/L)": "Potassium",
  "Chloride (mmol/L)": "Chloride",
  "Uric Acid (mg/dL)": "Uric_Acid",
  "eGFR (mL/min/1.73m²)": "eGFR",

  // ── Iron Profile ──
  "Iron (µg/dL)": "Iron",
  "UIBC (µg/dL)": "UIBC",
  "TIBC (µg/dL)": "TIBC",
  "Transferrin Saturation %": "Transferrin_Saturation",

  // ── HbA1c Panel ──
  "HbA1c %": "HbA1c",
  "Estimated Avg Glucose (mg/dL)": "Estimated_Avg_Glucose",
  "HbF %": "HbF",

  // ── Urine ACR Panel ──
  "Urine Albumin (mg/L)": "Urine_Albumin",
  "Urine Creatinine (mg/dL)": "Urine_Creatinine",
  "Albumin/Creatinine Ratio": "Albumin_Creatinine_Ratio",

  // ── Calcium & Phosphorus ──
  "Calcium (mg/dL)": "Calcium",
  "Phosphorus (mg/dL)": "Phosphorus",

  // ── Thyroid Profile ──
  "TT3 (ng/dL)": "TT3",
  "TT4 (µg/dL)": "TT4",
  "TSH (µIU/mL)": "TSH",

  // ── Glucose Panels ──
  "Fasting Glucose (mg/dL)": "Fasting_Glucose",
  "Postprandial Glucose (mg/dL)": "Postprandial_Glucose",
  "FBS (mg/dL)": "FBS",
  "PLBS (mg/dL)": "PLBS",

  // ── Urine General Analysis ──
  "Specific Gravity": "Specific_Gravity",
  "pH": "pH",
};

/**
 * Base date constant representing the Excel epoch (December 30, 1899).
 * Required because some rows in CSV exports represent dates as integer day offsets.
 */
const EXCEL_EPOCH = new Date(Date.UTC(1899, 11, 30));

/**
 * Parses diverse date formats into an ISO-8601 date string (YYYY-MM-DD).
 *
 * Handles:
 * - Integer strings representing Excel day serials (e.g. "43549" -> "2019-03-25")
 * - International date formats "DD/MM/YYYY" (e.g. "26/08/2018" -> "2018-08-26")
 * - Standard ISO strings "YYYY-MM-DD"
 *
 * @param raw - The raw date string from the CSV cell
 * @returns Standardized YYYY-MM-DD string or null if unparseable
 */
function parseCollectedDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // 1. Excel serial number format (e.g. 43549)
  if (/^\d+$/.test(s)) {
    const days = parseInt(s, 10);
    const d = new Date(EXCEL_EPOCH.getTime() + days * 86400000);
    return d.toISOString().slice(0, 10);
  }

  // 2. Delimited formats (DD/MM/YYYY or YYYY-MM-DD)
  const parts = s.split(/[\/\-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      // Format: YYYY-MM-DD
      return `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
    } else {
      // Format: DD/MM/YYYY
      return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
    }
  }

  return null;
}

/**
 * In-memory cached dataset container.
 */
interface LoadedDataset {
  /** Sorted list of unique patient identifiers (1,154 patients) */
  patientIds: string[];
  /** Total number of lab reports parsed (13,848 visits) */
  totalReports: number;
  /** Sorted list of all active biomarker names */
  biomarkers: string[];
  /** Panel-to-biomarker mapping dictionary */
  biomarkerGroups: Record<string, string[]>;
  /** Earliest recorded visit date in cohort */
  dateMin: string;
  /** Latest recorded visit date in cohort */
  dateMax: string;
  /** Flat unpivoted array of all observation rows */
  rows: LocalDatasetRecord[];
  /** Fast indexed map for patient-specific lookups */
  patientRowMap: Map<string, LocalDatasetRecord[]>;
}

/**
 * Singleton cache holding the parsed dataset in memory across API requests.
 */
let cachedDataset: LoadedDataset | null = null;

/**
 * Resolves the absolute or relative file path to `Medical Records.csv`.
 * Checks environment variable `LOCAL_DATASET_PATH` first, then default paths.
 *
 * @returns Absolute or relative resolved path to CSV file
 */
function resolveCsvPath(): string {
  const candidates = [
    process.env.LOCAL_DATASET_PATH,
    path.join(process.cwd(), "Dataset", "Medical Records.csv"),
    "/Users/sooyauming/Desktop/Intern/healthcare-dashboard/Dataset/Medical Records.csv",
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Fallback to default path relative to cwd
  return candidates[0] || path.join(process.cwd(), "Dataset", "Medical Records.csv");
}

/**
 * Loads, parses, and indexes the local medical records dataset into memory.
 * Implements a singleton pattern so the disk read and CSV parse occurs once only.
 *
 * Parsing logic:
 * 1. Reads Line 1 to identify clinical panel headers (CBC, Lipid Profile, etc.).
 * 2. Reads Line 2 to map column headers to standard biomarker names.
 * 3. Iterates over rows 3+, extracting patient ID, normalizing dates, and unpivoting numeric observations.
 * 4. Indexes rows into a per-patient lookup map for fast single-patient drilldowns.
 *
 * @throws Error if the CSV file cannot be located or is missing required columns.
 * @returns Loaded and indexed dataset container.
 */
export function loadLocalDataset(): LoadedDataset {
  if (cachedDataset) {
    return cachedDataset;
  }

  const csvPath = resolveCsvPath();
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Medical Records CSV file not found at path: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);

  if (lines.length < 3) {
    throw new Error("Medical Records CSV file is empty or corrupted.");
  }

  // Line 1: Group/Panel headers (e.g. Urine, CBC, Platelet Profile...)
  const line1 = lines[0].split(",");
  // Line 2: Specific test column headers (e.g. MedID, Collected, Hemoglobin (g/dL)...)
  const line2 = lines[1].split(",");

  // Extract column definitions and assign them to their respective panels
  let currentGroup = "";
  const columnDefs: ColumnDef[] = [];
  const biomarkerGroups: Record<string, string[]> = {};
  const allBiomarkersSet = new Set<string>();

  for (let i = 0; i < line2.length; i++) {
    const grp = line1[i]?.trim();
    if (grp) currentGroup = grp;

    const rawCol = line2[i]?.trim();
    if (!rawCol) continue;

    const clean = COLUMN_MAPPING[rawCol];
    if (clean) {
      const g = currentGroup || "General";
      columnDefs.push({
        idx: i,
        rawName: rawCol,
        cleanName: clean,
        group: g,
      });

      if (!biomarkerGroups[g]) {
        biomarkerGroups[g] = [];
      }
      if (!biomarkerGroups[g].includes(clean)) {
        biomarkerGroups[g].push(clean);
      }
      allBiomarkersSet.add(clean);
    }
  }

  const medIdIdx = line2.indexOf("MedID");
  const collectedIdx = line2.indexOf("Collected");

  if (medIdIdx === -1 || collectedIdx === -1) {
    throw new Error("CSV missing required header columns: 'MedID' or 'Collected'");
  }

  const patientIdSet = new Set<string>();
  const patientRowMap = new Map<string, LocalDatasetRecord[]>();
  const allRows: LocalDatasetRecord[] = [];
  let minDate = "9999-99-99";
  let maxDate = "0000-00-00";
  let totalVisits = 0;

  // Unpivot each visit row into discrete biomarker observation records
  for (let r = 2; r < lines.length; r++) {
    const rawLine = lines[r];
    const cols = rawLine.split(",");
    const pid = cols[medIdIdx]?.trim();
    const rawDate = cols[collectedIdx]?.trim();
    const isoDate = parseCollectedDate(rawDate);

    if (!pid || !isoDate) continue;

    totalVisits++;
    patientIdSet.add(pid);

    if (isoDate < minDate) minDate = isoDate;
    if (isoDate > maxDate) maxDate = isoDate;

    let pList = patientRowMap.get(pid);
    if (!pList) {
      pList = [];
      patientRowMap.set(pid, pList);
    }

    for (const c of columnDefs) {
      const rawVal = cols[c.idx]?.trim();
      // Skip non-numeric values and formula error artefacts
      if (!rawVal || rawVal === "#VALUE!" || rawVal === "#DIV/0!") continue;
      const num = parseFloat(rawVal);
      if (!isNaN(num)) {
        const record: LocalDatasetRecord = {
          patient_id: pid,
          visit_date: isoDate,
          biomarker: c.cleanName,
          value: num,
          group: c.group,
        };
        allRows.push(record);
        pList.push(record);
      }
    }
  }

  // Sort patient IDs numerically where possible, falling back to string comparison
  const sortedPatientIds = Array.from(patientIdSet).sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return a.localeCompare(b);
  });

  const sortedBiomarkers = Array.from(allBiomarkersSet).sort();

  cachedDataset = {
    patientIds: sortedPatientIds,
    totalReports: totalVisits,
    biomarkers: sortedBiomarkers,
    biomarkerGroups,
    dateMin: minDate !== "9999-99-99" ? minDate : "2018-08-24",
    dateMax: maxDate !== "0000-00-00" ? maxDate : "2019-07-24",
    rows: allRows,
    patientRowMap,
  };

  return cachedDataset;
}

/**
 * Retrieves the complete list of unique patient IDs and total report count.
 *
 * @returns Object containing sorted `patientIds` array and `totalReports` count.
 */
export function getLocalPatients(): { patientIds: string[]; totalReports: number } {
  const ds = loadLocalDataset();
  return {
    patientIds: ds.patientIds,
    totalReports: ds.totalReports,
  };
}

/**
 * Queries biomarker observations with flexible filtering parameters.
 *
 * @param params - Filter criteria including date range, optional patient ID, biomarker whitelist, and row limit.
 * @returns Formatted query response containing filtered rows, cohort metadata, and date boundaries.
 */
export function queryLocalBiomarkers(params: {
  dateFrom: string;
  dateTo: string;
  biomarkers?: string[];
  patientId?: string;
  rowLimit?: number;
}): {
  rows: BiomarkerRow[];
  biomarkers: string[];
  biomarkerGroups: Record<string, string[]>;
  dateRange: { min: string; max: string };
  rowCount: number;
} {
  const ds = loadLocalDataset();
  const { dateFrom, dateTo, patientId, biomarkers, rowLimit = 80000 } = params;

  // Use fast patient lookup if a specific patient ID is requested
  let baseRows: LocalDatasetRecord[];
  if (patientId && patientId.trim()) {
    baseRows = ds.patientRowMap.get(patientId.trim()) || [];
  } else {
    baseRows = ds.rows;
  }

  const hasBiomarkerFilter = Boolean(biomarkers && biomarkers.length > 0);
  const bmSet = hasBiomarkerFilter ? new Set(biomarkers) : null;

  const filtered: BiomarkerRow[] = [];
  for (const r of baseRows) {
    if (r.visit_date < dateFrom || r.visit_date > dateTo) continue;
    if (bmSet && !bmSet.has(r.biomarker)) continue;

    filtered.push({
      patient_id: r.patient_id,
      visit_date: r.visit_date,
      biomarker: r.biomarker,
      value: r.value,
      group: r.group,
    });

    if (filtered.length >= rowLimit) break;
  }

  // Sort rows chronologically, then by patient, then by biomarker
  filtered.sort(
    (a, b) =>
      a.visit_date.localeCompare(b.visit_date) ||
      a.patient_id.localeCompare(b.patient_id) ||
      a.biomarker.localeCompare(b.biomarker)
  );

  return {
    rows: filtered,
    biomarkers: ds.biomarkers,
    biomarkerGroups: ds.biomarkerGroups,
    dateRange: {
      min: ds.dateMin,
      max: ds.dateMax,
    },
    rowCount: filtered.length,
  };
}
