/**
 * @file route.ts
 * @module app/api/explain/route
 * @description Clinical AI Assistant endpoint synthesizing biomarker data, reference ranges, and trend analysis.
 *
 * Architecture:
 * 1. Validates context payload (filters, active biomarker rows, correlation matrix, summary statistics).
 * 2. Enriches prompt with clinical reference ranges (`CLINICAL_RANGES`) and multi-biomarker pattern detection.
 * 3. Executes cascading LLM provider chain:
 *    - Google Gemini (`gemini-2.5-flash` / `gemini-2.0-flash`)
 *    - Hugging Face MedGemma (`google/medgemma-27b-text-it`)
 *    - OpenAI GPT (`gpt-5.5` / `gpt-4o`)
 *    - Local Structured Clinical Snapshot (offline fallback with normal range checks)
 *
 * @example
 * ```bash
 * curl -X POST http://localhost:3000/api/explain \
 *   -H "Content-Type: application/json" \
 *   -d '{"question": "Explain my HbA1c trend", "context": {"dataSource": "local_csv", "rowCount": 12}}'
 * ```
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/lib/env";
import { generateExplanationOpenAI } from "@/lib/openai";
import { generateExplanationHuggingFace } from "@/lib/huggingface";
import { generateExplanationGemini } from "@/lib/gemini";
import { annotateWithRanges, detectClinicalPatterns, CLINICAL_RANGES } from "@/lib/clinical-ranges";

/** JSON preprocess: transforms NaN values to null to ensure valid Zod numerical validation */
const finiteOrNull = z.preprocess(
  (v) =>
    typeof v === "number" && !Number.isFinite(v)
      ? null
      : v,
  z.union([z.number(), z.null()]),
);

/** Zod schema for individual biomarker summary statistics */
const summaryEntry = z.object({
  mean: finiteOrNull,
  std: finiteOrNull,
  min: finiteOrNull,
  max: finiteOrNull,
  n: z.number().int().nonnegative(),
});

/** Zod schema for individual observation records */
const biomarkerRowSchema = z.object({
  patient_id: z.string().optional(),
  visit_date: z.string(),
  biomarker: z.string(),
  value: z.number(),
});

/** Validation schema for the explain POST request body */
const bodySchema = z.object({
  /** User's natural language clinical question */
  question: z.string().min(1, "Question cannot be empty").max(8000),
  /** Dashboard analytics context to ground LLM reasoning */
  context: z.object({
    filters: z
      .object({
        dateFrom: z.string(),
        dateTo: z.string(),
        biomarkers: z.array(z.string()).optional(),
        patientId: z.string().optional(),
      })
      .optional(),
    dataSource: z.enum(["bigquery", "demo", "local_csv", "csv"]).or(z.string()),
    summary: z.record(z.string(), summaryEntry).optional(),
    correlation: z.record(
      z.string(),
      z.record(z.string(), z.union([z.number(), z.null()])),
    ).optional(),
    rows: z.array(biomarkerRowSchema).optional(),
    rowCount: z.number(),
    chartHint: z.string().optional(),
  }),
});

/** Formats a numeric value to 3 decimal places or 'n/a' if missing */
function fmt(n: number | null) {
  return n !== null && Number.isFinite(n) ? n.toFixed(3) : "n/a";
}

/**
 * Generates a deterministic offline structured clinical summary when external LLM APIs are unavailable.
 *
 * @param question - User's query
 * @param ctx - Dashboard analytics context
 * @returns Structured plain text summary
 */
function localStubAnswer(question: string, ctx: z.infer<typeof bodySchema>["context"]) {
  let dataLines: string[] = [];
  
  if (ctx.rows && ctx.rows.length > 0) {
    const selected = new Set(ctx.filters?.biomarkers || []);
    const filtered = selected.size > 0 ? ctx.rows.filter(r => selected.has(r.biomarker)) : ctx.rows;
    dataLines = filtered.slice(0, 10).map(r => `${r.visit_date} | ${r.biomarker}: ${fmt(r.value)}`);
    if (filtered.length > 10) dataLines.push(`... (${filtered.length - 10} more rows)`);
  } else if (ctx.summary) {
    const keys = Object.keys(ctx.summary).slice(0, 6);
    dataLines = keys.map((k) => {
      const s = ctx.summary![k];
      if (!s || !s.n) return `${k}: no samples`;
      return `${k}: mean ${fmt(s.mean)} (n=${s.n}), range [${fmt(s.min)}, ${fmt(s.max)}]`;
    });
  }

  return [
    "Offline mode (no LLM configured): here is a structured snapshot you can interpret.",
    `Data source: ${ctx.dataSource}. Rows in view: ${ctx.rowCount}.`,
    ctx.chartHint ? `Active view: ${ctx.chartHint}` : "",
    "Data snapshot:",
    ...dataLines,
    "",
    "Correlation matrix (Pearson on same patient+visit pairs) is included in context; values near 1 or -1 suggest linear association in this cohort.",
    "",
    `Your question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds an enriched prompt incorporating exact date-level measurements, reference ranges, and clinical alerts.
 *
 * @param question - User's clinical inquiry
 * @param context - Dashboard state snapshot
 * @returns Comprehensive clinical prompt string
 */
function buildEnrichedPrompt(
  question: string,
  context: z.infer<typeof bodySchema>["context"],
): string {
  // 1. Build date-level longitudinal records
  let dataContent = "";
  if (context.rows && context.rows.length > 0) {
    const selected = new Set(context.filters?.biomarkers || []);
    const filteredRows = selected.size > 0 
      ? context.rows.filter(r => selected.has(r.biomarker))
      : context.rows;
    
    const sorted = [...filteredRows].sort((a, b) => 
      a.visit_date.localeCompare(b.visit_date) || a.biomarker.localeCompare(b.biomarker)
    );

    const slice = sorted.slice(0, 250);
    dataContent = "── Date-level Biomarker Values ──\n" + 
      slice.map(r => {
        const ref = CLINICAL_RANGES[r.biomarker];
        let line = `${r.visit_date} | ${r.biomarker}: ${fmt(r.value)}`;
        if (ref) {
          if (r.value > ref.high) line += " (HIGH)";
          else if (r.value < ref.low) line += " (LOW)";
        }
        return line;
      }).join("\n");
    
    if (sorted.length > 250) {
      dataContent += `\n... (and ${sorted.length - 250} more records)`;
    }
  }

  // 2. Annotate cohort aggregates with clinical reference ranges
  const annotatedStats = context.summary ? annotateWithRanges(
    context.summary as Record<string, { mean: number | null; std: number | null; min: number | null; max: number | null; n: number }>,
  ) : "";

  // 3. Detect multi-biomarker clinical patterns (liver, renal, metabolic)
  const patterns = context.summary ? detectClinicalPatterns(
    context.summary as Record<string, { mean: number | null; n: number }>,
  ) : [];

  // 4. Extract notable correlations (|r| > 0.3)
  const corrPairs: string[] = [];
  if (context.correlation) {
    const corrKeys = Object.keys(context.correlation);
    for (let i = 0; i < corrKeys.length; i++) {
      for (let j = i + 1; j < corrKeys.length; j++) {
        const a = corrKeys[i], b = corrKeys[j];
        const v = context.correlation[a]?.[b];
        if (typeof v === "number" && Math.abs(v) > 0.3) {
          corrPairs.push(`${a} × ${b}: r=${v.toFixed(3)}`);
        }
      }
    }
  }
  const corrSummary = corrPairs.length
    ? corrPairs.slice(0, 20).join("\n")
    : "No notable correlations (|r| > 0.3) found.";

  const sections = [
    `Question: ${question}`,
    "",
    `Data source: ${context.dataSource}, ${context.rowCount} rows.`,
    context.filters
      ? `Filters: ${context.filters.dateFrom} to ${context.filters.dateTo}${context.filters.biomarkers?.length ? `, biomarkers: ${context.filters.biomarkers.join(", ")}` : ""}`
      : "",
    context.chartHint ?? "",
    "",
    dataContent || (annotatedStats ? `── Biomarker Statistics (Aggregated) ──\n${annotatedStats}` : ""),
    "",
    "── Notable Correlations (Pearson) ──",
    corrSummary,
  ];

  if (patterns.length > 0) {
    sections.push(
      "",
      "── Detected Clinical Patterns ──",
      ...patterns,
    );
  }

  if (dataContent && !annotatedStats) {
    const uniqueMarkers = Array.from(new Set(context.rows?.map(r => r.biomarker) || []));
    const rangeLines = uniqueMarkers.map(m => {
      const ref = CLINICAL_RANGES[m];
      return ref ? `${m}: ${ref.low}-${ref.high} ${ref.unit}` : null;
    }).filter((line): line is string => line !== null);
    if (rangeLines.length > 0) {
      sections.push("", "── Clinical Reference Ranges ──", ...rangeLines);
    }
  }

  sections.push(
    "",
    "Instructions: Analyze the above data in clinical context. Reference normal ranges, flag abnormalities, explain correlations, and identify patterns relevant to the user's question. Be precise and evidence-based. If exact date-level data is provided, prioritize it for trend analysis over aggregate means.",
  );

  return sections.filter(Boolean).join("\n");
}

/**
 * Handles HTTP POST requests to generate AI-assisted clinical biomarker explanations.
 *
 * @param req - HTTP Request with JSON body matching `bodySchema`
 * @returns JSON response with `{ answer, mode, warning }`
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

  const { question, context } = parsed.data;
  const env = getServerEnv();

  const prompt = buildEnrichedPrompt(question, context);
  const errors: string[] = [];

  // 1. Primary: Google Gemini API
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const answer = await generateExplanationGemini(geminiKey, prompt);
      return NextResponse.json({ answer, mode: "gemini" as const });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("Gemini explain error:", msg);
      errors.push(`Gemini: ${msg}`);
    }
  }

  // 2. Clinical Specialist: Hugging Face MedGemma
  const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
  if (hfKey) {
    try {
      const answer = await generateExplanationHuggingFace(hfKey, prompt);
      return NextResponse.json({ answer, mode: "medgemma" as const });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("Hugging Face / MedGemma explain error:", msg);
      errors.push(`MedGemma: ${msg}`);
    }
  }

  // 3. Fallback: OpenAI GPT
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const answer = await generateExplanationOpenAI(openaiKey, prompt);
      return NextResponse.json({ answer, mode: "openai" as const });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("OpenAI explain error:", msg);
      errors.push(`OpenAI: ${msg}`);
    }
  }

  // 4. Local structured clinical snapshot fallback
  const answer = localStubAnswer(question, context);
  return NextResponse.json({
    answer,
    mode: "local_stub" as const,
    warning: errors.length
      ? `Offline analysis (API keys unavailable / inactive: ${errors.join(" | ")})`
      : "Offline clinical analysis mode.",
  });
}
