/**
 * @file stats.ts
 * @module lib/stats
 * @description Statistical analysis and correlation matrix computation engine for healthcare biomarkers.
 *
 * This module computes:
 * 1. Pairwise Pearson correlation coefficients (\(r\)) across longitudinal visit records.
 * 2. Cohort-level descriptive summary statistics (mean, sample standard deviation, minimum, maximum, count \(n\)).
 *
 * @example
 * ```ts
 * import { correlationMatrix, summaryStats } from "@/lib/stats";
 *
 * const summary = summaryStats(rows, ["Hemoglobin", "Total_Cholesterol"]);
 * console.log(`Hemoglobin mean: ${summary["Hemoglobin"].mean}, std: ${summary["Hemoglobin"].std}`);
 *
 * const matrix = correlationMatrix(rows, ["Hemoglobin", "Total_Cholesterol"]);
 * console.log(`Correlation: ${matrix["Hemoglobin"]["Total_Cholesterol"]}`);
 * ```
 */

import type { BiomarkerRow } from "@/types";

/**
 * Computes the Pearson correlation coefficient (\(r\)) between two equal-length numerical arrays.
 *
 * Formula:
 * \[
 * r = \frac{n \sum xy - \sum x \sum y}{\sqrt{(n \sum x^2 - (\sum x)^2)(n \sum y^2 - (\sum y)^2)}}
 * \]
 *
 * Gotchas & Restrictions:
 * - Returns `null` if \(n < 2\).
 * - Returns `null` if the variance of either \(x\) or \(y\) is 0 (division by zero denominator).
 *
 * @param xs - Array of numerical observations for variable X
 * @param ys - Array of numerical observations for variable Y
 * @returns Pearson correlation coefficient between -1.0 and +1.0, or null if undefined
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;

  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));

  // Denominator is 0 when either series has zero variance (constant values)
  if (denominator === 0) return null;

  return numerator / denominator;
}

/**
 * Groups a collection of long-format biomarker rows by compound key `patient_id|visit_date`.
 * This associates all biomarkers collected during the same patient visit into a single dictionary.
 *
 * @param rows - Flat array of unpivoted biomarker observation rows
 * @returns Map where key is `patient_id|visit_date` and value is `{ [biomarkerName]: value }`
 */
export function groupedByPatientDate(rows: BiomarkerRow[]): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = `${r.patient_id}|${r.visit_date}`;
    let g = map.get(key);
    if (!g) {
      g = {};
      map.set(key, g);
    }
    g[r.biomarker] = r.value;
  }
  return map;
}

/**
 * Computes an \(N \times N\) Pearson correlation matrix across all specified biomarkers.
 * Uses same-visit pairing: an observation is only included if both biomarkers were measured
 * for the same patient on the same visit date.
 *
 * @param rows - Longitudinal biomarker records
 * @param biomarkers - Whitelist of biomarker names to include in the matrix
 * @returns 2D dictionary representing the symmetric correlation matrix
 */
export function correlationMatrix(
  rows: BiomarkerRow[],
  biomarkers: string[],
): Record<string, Record<string, number>> {
  const grouped = groupedByPatientDate(rows);
  const matrix: Record<string, Record<string, number>> = {};

  for (const a of biomarkers) {
    matrix[a] = {};
    for (const b of biomarkers) {
      // Self-correlation is always 1.0
      if (a === b) {
        matrix[a][b] = 1;
        continue;
      }

      // Collect paired values for same patient visit
      const xs: number[] = [];
      const ys: number[] = [];
      for (const rec of grouped.values()) {
        const va = rec[a];
        const vb = rec[b];
        if (va !== undefined && vb !== undefined) {
          xs.push(va);
          ys.push(vb);
        }
      }

      const r = pearson(xs, ys);
      matrix[a][b] = r ?? NaN;
    }
  }
  return matrix;
}

/**
 * Calculates cohort summary statistics for each biomarker in the requested list.
 * Computes sample mean, sample standard deviation (Bessel-corrected \(n-1\)), minimum, maximum, and sample count \(n\).
 *
 * @param rows - Flat array of biomarker rows
 * @param biomarkers - List of biomarker names to summarize
 * @returns Dictionary mapping biomarker name to its summary stats object
 */
export function summaryStats(
  rows: BiomarkerRow[],
  biomarkers: string[],
): Record<
  string,
  { mean: number; std: number; min: number; max: number; n: number }
> {
  const out: Record<
    string,
    { mean: number; std: number; min: number; max: number; n: number }
  > = {};

  for (const m of biomarkers) {
    const vals = rows.filter((r) => r.biomarker === m).map((r) => r.value);
    const n = vals.length;
    if (n === 0) {
      out[m] = { mean: NaN, std: NaN, min: NaN, max: NaN, n: 0 };
      continue;
    }

    const mean = vals.reduce((a, b) => a + b, 0) / n;
    // Sample variance using Bessel's correction (n - 1)
    const variance =
      vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(n - 1, 1);

    out[m] = {
      mean,
      std: Math.sqrt(variance),
      min: Math.min(...vals),
      max: Math.max(...vals),
      n,
    };
  }
  return out;
}
