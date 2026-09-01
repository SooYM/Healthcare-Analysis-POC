/**
 * @file route.ts
 * @module app/api/patients/route
 * @description API endpoint retrieving distinct patient identifiers and cohort totals.
 *
 * Cascading provider resolution:
 * 1. BigQuery (when `DATA_SOURCE=bigquery` and GCP credentials configured)
 * 2. Local In-Memory Dataset (default: `Dataset/Medical Records.csv` with 1,154 patients)
 * 3. Synthetic Demo Fallback (48 mock patients `P0001`–`P0048`)
 *
 * @example
 * ```bash
 * curl -X GET http://localhost:3000/api/patients
 * # Returns: {"patientIds": ["100004", "100271", ...], "totalReports": 13848}
 * ```
 */

import { NextResponse } from "next/server";
import { getServerEnv, isDemoMode, parseBigQueryViewNames } from "@/lib/env";
import { queryDistinctPatients } from "@/lib/bigquery";
import { getLocalPatients } from "@/lib/local-dataset";

/**
 * Handles HTTP GET requests to list all unique patient identifiers in the active cohort.
 *
 * @returns JSON response containing `patientIds` array and `totalReports` count.
 */
export async function GET() {
  const env = getServerEnv();

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

  // 1. Attempt BigQuery if explicitly configured
  if (useBigQuery) {
    try {
      const patientIds = await queryDistinctPatients(env);
      return NextResponse.json({
        patientIds,
        totalReports: patientIds.length,
      });
    } catch (e) {
      console.warn("BigQuery error fetching patients, falling back to local dataset:", e);
    }
  }

  // 2. Preferred / Default: Local Medical Records CSV Engine
  try {
    const local = getLocalPatients();
    return NextResponse.json({
      patientIds: local.patientIds,
      totalReports: local.totalReports,
    });
  } catch (e) {
    console.error("Local dataset error, falling back to synthetic demo:", e);
  }

  // 3. Fallback to Synthetic Demo Cohort
  const patientIds = Array.from({ length: 48 }, (_, i) => `P${String(i + 1).padStart(4, "0")}`);
  return NextResponse.json({
    patientIds,
    totalReports: patientIds.length,
  });
}
