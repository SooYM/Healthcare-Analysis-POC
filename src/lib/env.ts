/**
 * @file env.ts
 * @module lib/env
 * @description Server-side environment variable validation and parsing using Zod.
 *
 * Provides typed, validated access to system configuration including:
 * - Data source selection (local CSV vs BigQuery vs synthetic demo)
 * - GCP BigQuery project, dataset, view names, and column alias overrides
 * - AI Provider settings (Gemini, Hugging Face MedGemma, OpenAI, Vertex AI)
 *
 * @example
 * ```ts
 * import { getServerEnv, isDemoMode, isLocalDataSource } from "@/lib/env";
 *
 * const env = getServerEnv();
 * if (isLocalDataSource()) {
 *   console.log("Using in-memory local CSV dataset");
 * }
 * ```
 */

import { z } from "zod";

/**
 * Zod schema defining all server-side environment variables and their default values.
 */
const envSchema = z.object({
  /** Data source provider: 'local' (default), 'bigquery', or 'demo' */
  DATA_SOURCE: z.enum(["local", "bigquery", "demo"]).default("local"),
  /** File path to local medical records CSV file */
  LOCAL_DATASET_PATH: z.string().optional(),
  /** GCP Project ID for BigQuery and Vertex AI */
  GCP_PROJECT_ID: z.string().optional(),
  /** BigQuery multi-region location (default: 'US') */
  BIGQUERY_LOCATION: z.string().default("US"),
  /** BigQuery dataset name containing fact views (default: 'A2') */
  BIGQUERY_DATASET: z.string().default("A2"),
  /** Comma-separated view names to UNION ALL in single query */
  BIGQUERY_VIEW_NAMES: z.string().optional(),
  /** Fully qualified table name (`project.dataset.table`) for single-table mode */
  BIGQUERY_TABLE_FQN: z.string().optional(),
  /** Column alias for Patient ID in BigQuery views */
  BQ_COL_PATIENT_ID: z.string().default("patient_id"),
  /** Column alias for Visit Date in BigQuery views */
  BQ_COL_VISIT_DATE: z.string().default("visit_date"),
  /** Column alias for Biomarker identifier in BigQuery views */
  BQ_COL_BIOMARKER: z.string().default("biomarker"),
  /** Column alias for numeric measured value in BigQuery views */
  BQ_COL_VALUE: z.string().default("value"),
  /** Vertex AI region */
  VERTEX_LOCATION: z.string().default("us-central1"),
  /** Vertex AI foundation model */
  VERTEX_MODEL: z.string().default("gemini-1.5-flash"),
  /** Google Gemini API Key for Explain assistant */
  GEMINI_API_KEY: z.string().optional(),
  /** Google Gemini Base URL */
  GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
  /** Google Gemini Model Name */
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  /** Hugging Face API Token */
  HUGGINGFACE_API_KEY: z.string().optional(),
  /** Hugging Face clinical model ID */
  HUGGINGFACE_MODEL: z.string().default("google/medgemma-27b-text-it"),
  /** OpenAI API Key */
  OPENAI_API_KEY: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Validates and returns the parsed server environment object.
 *
 * @returns Strongly typed `AppEnv` configuration object.
 */
export function getServerEnv(): AppEnv {
  return envSchema.parse({
    DATA_SOURCE: (process.env.DATA_SOURCE as "local" | "bigquery" | "demo") || (process.env.DEMO_MODE === "true" ? "demo" : "local"),
    LOCAL_DATASET_PATH: process.env.LOCAL_DATASET_PATH,
    GCP_PROJECT_ID: process.env.GCP_PROJECT_ID,
    BIGQUERY_LOCATION: process.env.BIGQUERY_LOCATION,
    BIGQUERY_DATASET: process.env.BIGQUERY_DATASET,
    BIGQUERY_VIEW_NAMES: process.env.BIGQUERY_VIEW_NAMES,
    BIGQUERY_TABLE_FQN: process.env.BIGQUERY_TABLE_FQN,
    BQ_COL_PATIENT_ID: process.env.BQ_COL_PATIENT_ID,
    BQ_COL_VISIT_DATE: process.env.BQ_COL_VISIT_DATE,
    BQ_COL_BIOMARKER: process.env.BQ_COL_BIOMARKER,
    BQ_COL_VALUE: process.env.BQ_COL_VALUE,
    VERTEX_LOCATION: process.env.VERTEX_LOCATION,
    VERTEX_MODEL: process.env.VERTEX_MODEL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN,
    HUGGINGFACE_MODEL: process.env.HUGGINGFACE_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  });
}

/**
 * Checks whether the application is running in forced synthetic demo mode.
 *
 * @returns True if `DEMO_MODE=true` is set in the environment.
 */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

/**
 * Checks whether the local CSV dataset provider is active.
 *
 * @returns True if local dataset mode is enabled and DEMO_MODE is not forced.
 */
export function isLocalDataSource(): boolean {
  if (isDemoMode()) return false;
  return process.env.DATA_SOURCE === "local" || !process.env.DATA_SOURCE;
}

/**
 * Parses and sanitizes comma-separated BigQuery view names from environment.
 * Ensures view names conform to SQL identifier conventions (`^[A-Za-z_][A-Za-z0-9_]*$`).
 *
 * @param env - Parsed server environment configuration
 * @returns Array of sanitized view names
 */
export function parseBigQueryViewNames(env: AppEnv): string[] {
  const raw = env.BIGQUERY_VIEW_NAMES;
  if (!raw?.trim()) return [];
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const safe = /^[A-Za-z_][A-Za-z0-9_]*$/;
  return names.filter((n) => {
    if (!safe.test(n)) {
      console.warn(`Skipping invalid BigQuery view name: ${n}`);
      return false;
    }
    return true;
  });
}
