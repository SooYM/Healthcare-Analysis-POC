# Pseudocode & System Walkthrough

> A comprehensive technical and algorithmic walkthrough of every module in the Healthcare Dashboard, illustrating data structures, ingestion pipelines, statistical computations, and AI reasoning.

---

## Table of Contents

1. [System Overview & Architecture](#1-system-overview--architecture)
2. [End-to-End Data Flow](#2-end-to-end-data-flow)
3. [Type Contracts & Envelopes](#3-type-contracts--envelopes)
4. [In-Memory Local Dataset Engine (`local-dataset.ts`)](#4-in-memory-local-dataset-engine-local-datasetts)
5. [BigQuery Star-Schema Engine (`bigquery.ts`)](#5-bigquery-star-schema-engine-bigqueryts)
6. [Statistical Analysis Engine (`stats.ts`)](#6-statistical-analysis-engine-statsts)
7. [Clinical AI Explanation Cascade (`explain/route.ts`)](#7-clinical-ai-explanation-cascade-explainroutets)
8. [Multidimensional 3D OLAP Cube Engine (`OlapCube.tsx`)](#8-multidimensional-3d-olap-cube-engine-olapcubetsx)
9. [Frontend Dashboard Controller (`Dashboard.tsx`)](#9-frontend-dashboard-controller-dashboardtsx)
10. [Database Star Schema & Source Mapping](#10-database-star-schema--source-mapping)

---

## 1. System Overview & Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     BROWSER (React 19)                  │
│  Dashboard.tsx  ←→  OlapCube.tsx  ←→  PageTransition    │
│       ↕ fetch            ↕ fetch                        │
├─────────────────────────────────────────────────────────┤
│                  NEXT.JS APP ROUTER API                 │
│  /api/data    /api/explain    /api/patients   /api/health│
├─────────────────────────────────────────────────────────┤
│                  SERVER-SIDE COMPUTATION                │
│  local-dataset.ts   bigquery.ts   stats.ts   env.ts     │
│  clinical-ranges.ts gemini.ts     huggingface.ts        │
│  openai.ts          demo-data.ts                        │
├─────────────────────────────────────────────────────────┤
│              DATA WAREHOUSES & STORAGE                  │
│  • Local CSV (Medical Records.csv — 13.8k records)      │
│  • Google BigQuery (Star Schema Dataset A2)             │
│  • MySQL 8.0 / phpMyAdmin (healthcare_dashboard_mysql)  │
├─────────────────────────────────────────────────────────┤
│              AI REASONING CASCADE                       │
│  1. Google Gemini API (Primary LLM)                     │
│  2. Hugging Face MedGemma (Clinical Foundation Model)   │
│  3. OpenAI GPT (Fallback LLM)                           │
│  4. Offline Rule Engine (Reference Ranges & Triads)     │
└─────────────────────────────────────────────────────────┘
```

---

## 2. End-to-End Data Flow

```
USER opens dashboard
  │
  ├─► Browser fetches GET /api/patients
  │     ├─► IF BigQuery configured & active → queryDistinctPatients()
  │     ├─► ELSE IF Local CSV active (Default) → getLocalPatients() [1,154 patients]
  │     └─► ELSE → Fallback to synthetic demo cohort [P0001–P0048]
  │
  └─► Browser fetches POST /api/data { dateFrom, dateTo, rowLimit }
        │
        ├─► IF Local CSV active (Default):
        │     queryLocalBiomarkers({ dateFrom, dateTo, biomarkers, patientId })
        │
        ├─► ELSE IF BigQuery active:
        │     queryBiomarkerLong() via UNPIVOT + UNION ALL across 14 views
        │
        └─► ELSE (Demo Mode):
              generateDemoRows()
        │
        ▼
  Server computes:
    correlationMatrix(rows)  → Pearson correlation r for all biomarker pairs
    summaryStats(rows)       → mean, std, min, max, n per biomarker
    biomarkerGroups          → panel-to-biomarker mapping dictionary
        │
        ▼
  Browser receives DataResponse:
    • Renders Longitudinal Trend Chart (Year → Month → Day drill-down)
    • Renders Same-Visit Scatter Plot (X vs Y correlation)
    • Renders Pearson Correlation Heatmap
    • Renders 3D Multidimensional OLAP Cube
```

---

## 3. Type Contracts & Envelopes

```typescript
// Core observation record
type BiomarkerRow = {
  patient_id: string;   // e.g. "560252"
  visit_date: string;   // "YYYY-MM-DD"
  biomarker: string;    // e.g. "Hemoglobin"
  value: number;        // e.g. 15.2
  group?: string;       // e.g. "CBC"
};

// Response envelope for /api/data
type DataResponse = {
  source: "bigquery" | "demo" | "local_csv" | "csv";
  demoReason?: string;
  rows: BiomarkerRow[];
  biomarkers: string[];
  biomarkerGroups?: Record<string, string[]>;
  dateRange: { min: string; max: string };
  rowCount: number;
  correlation?: Record<string, Record<string, number>>;
  summary?: Record<string, { mean: number; std: number; min: number; max: number; n: number }>;
};
```

---

## 4. In-Memory Local Dataset Engine (`local-dataset.ts`)

### Pseudocode Algorithm:
```
FUNCTION loadLocalDataset():
  IF cachedDataset is NOT NULL:
    RETURN cachedDataset

  csvText = READ_FILE(resolveCsvPath())
  lines = SPLIT_LINES(csvText)
  
  line1 = SPLIT_COMMA(lines[0])  // Panel headers (CBC, Lipid, etc.)
  line2 = SPLIT_COMMA(lines[1])  // Column headers (Hemoglobin, etc.)
  
  columnDefs = []
  FOR EACH col IN line2:
    cleanName = COLUMN_MAPPING[col]
    IF cleanName EXISTS:
      columnDefs.APPEND({ idx, cleanName, group })

  allRows = []
  patientMap = Map<string, List<Record>>()
  
  FOR r FROM 2 TO lines.length - 1:
    cols = SPLIT_COMMA(lines[r])
    pid = cols[medIdIdx]
    isoDate = parseCollectedDate(cols[collectedIdx])
    
    IF pid IS NULL OR isoDate IS NULL:
      CONTINUE
      
    FOR EACH def IN columnDefs:
      num = PARSE_FLOAT(cols[def.idx])
      IF num IS VALID:
        record = { patient_id: pid, visit_date: isoDate, biomarker: def.cleanName, value: num, group: def.group }
        allRows.APPEND(record)
        patientMap.GET_OR_CREATE(pid).APPEND(record)

  cachedDataset = {
    patientIds: SORT_UNIQUE(patientMap.KEYS()),
    totalReports: totalVisits,
    biomarkers: SORT_UNIQUE(columnDefs.cleanNames),
    biomarkerGroups: GROUP_BY_PANEL(columnDefs),
    rows: allRows,
    patientRowMap: patientMap
  }
  
  RETURN cachedDataset
```

---

## 5. BigQuery Star-Schema Engine (`bigquery.ts`)

### Pseudocode Algorithm:
```
FUNCTION queryBiomarkerLong(env, params):
  client = NEW BigQueryClient(env.GCP_PROJECT_ID)
  
  // 1. Discover all numeric columns dynamically
  numericCols = client.QUERY(`
    SELECT table_name, column_name 
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE table_name IN UNNEST(@viewNames) AND data_type IN ('INT64', 'FLOAT64', 'NUMERIC')
  `)
  
  // 2. Generate UNPIVOT branches for each view
  branches = []
  FOR EACH view IN viewNames:
    cols = numericCols[view]
    branch = `
      SELECT patient_id, visit_date, biomarker, value, '${view}' AS group
      FROM (SELECT patient_id, visit_date, ${CAST_COLS_AS_FLOAT(cols)} FROM ${view})
      UNPIVOT (value FOR biomarker IN (${cols}))
      WHERE visit_date BETWEEN @dateFrom AND @dateTo
    `
    branches.APPEND(branch)
    
  // 3. Single-pass UNION ALL execution
  sql = `
    SELECT * FROM (${JOIN(branches, " UNION ALL ")})
    ORDER BY visit_date, patient_id, biomarker
    LIMIT @rowLimit
  `
  
  RETURN client.EXECUTE(sql, params)
```

---

## 6. Statistical Analysis Engine (`stats.ts`)

### Pseudocode: Pearson Correlation & Grouped Covariance
```
FUNCTION pearson(xs: number[], ys: number[]):
  n = MIN(xs.length, ys.length)
  IF n < 2: RETURN null
  
  sumX = SUM(xs), sumY = SUM(ys)
  sumXX = SUM(x^2), sumYY = SUM(y^2)
  sumXY = SUM(x * y)
  
  numerator = n * sumXY - sumX * sumY
  denominator = SQRT((n * sumXX - sumX^2) * (n * sumYY - sumY^2))
  
  IF denominator == 0: RETURN null
  RETURN numerator / denominator

FUNCTION correlationMatrix(rows, biomarkers):
  // Group by same patient visit
  visitMap = Map<"patient_id|visit_date", Record<biomarker, value>>()
  FOR EACH r IN rows:
    visitMap[r.patient_id + "|" + r.visit_date][r.biomarker] = r.value
    
  matrix = {}
  FOR EACH a IN biomarkers:
    FOR EACH b IN biomarkers:
      IF a == b: matrix[a][b] = 1.0; CONTINUE
      
      pairedX = [], pairedY = []
      FOR EACH visit IN visitMap.VALUES():
        IF visit[a] EXISTS AND visit[b] EXISTS:
          pairedX.APPEND(visit[a])
          pairedY.APPEND(visit[b])
          
      matrix[a][b] = pearson(pairedX, pairedY) ?? NaN
      
  RETURN matrix
```

---

## 7. Clinical AI Explanation Cascade (`explain/route.ts`)

```
FUNCTION POST_Explain(question, context):
  // 1. Build prompt enriched with exact measurements and normal ranges
  prompt = buildEnrichedPrompt(question, context)
  
  // 2. Cascade through providers
  IF GEMINI_API_KEY is configured:
    TRY generateExplanationGemini(prompt) -> RETURN 200 { mode: "gemini" }
    CATCH error -> log and continue
    
  IF HUGGINGFACE_API_KEY is configured:
    TRY generateExplanationHuggingFace(prompt) -> RETURN 200 { mode: "medgemma" }
    CATCH error -> log and continue
    
  IF OPENAI_API_KEY is configured:
    TRY generateExplanationOpenAI(prompt) -> RETURN 200 { mode: "openai" }
    CATCH error -> log and continue
    
  // 3. Fallback to deterministic offline rule engine
  RETURN localStubAnswer(question, context) with mode: "local_stub"
```

---

## 8. Multidimensional 3D OLAP Cube Engine (`OlapCube.tsx`)

```
FUNCTION buildCube(rows, { grain, biomarkers }):
  // 4 Dimensions: Time (Day/Month), Biomarker, Patient, Group
  timeKey = (row) => grain == "month" ? row.visit_date.slice(0,7) : row.visit_date
  
  agg = Map<"time||biomarker||patient||group", { sum: number, n: number }>()
  
  FOR EACH r IN rows:
    IF r.biomarker NOT IN biomarkers: CONTINUE
    k = `${timeKey(r)}||${r.biomarker}||${r.patient_id}||${r.group}`
    agg[k].sum += r.value
    agg[k].n += 1
    
  RETURN { times, biomarkers, patients, groups, agg }

// Slice operation: fix one dimension, project remaining two into 2D heatmap / 3D bars
FUNCTION projectSlice(cube, { xDim, yDim, fixedDim, fixedValue }):
  matrix = []
  FOR EACH x IN cube.getCoordinates(xDim):
    FOR EACH y IN cube.getCoordinates(yDim):
      avgValue = cube.lookup(xDim=x, yDim=y, fixedDim=fixedValue).mean
      matrix.APPEND([x, y, avgValue])
  RETURN matrix
```

---

## 9. Frontend Dashboard Controller (`Dashboard.tsx`)

```
COMPONENT Dashboard:
  STATE:
    patientId = ""
    dateFrom = "2018-08-24", dateTo = "2019-07-24"
    selectedBiomarkers = []
    drillLevel = "month" // "year" | "month" | "day"
    activeTab = "analytics" // "analytics" | "olap" | "correlations"
    
  EFFECT loadData():
    res = POST /api/data { dateFrom, dateTo, patientId, rowLimit: 80000 }
    SET data = res.json()
    IF selectedBiomarkers is EMPTY:
      selectedBiomarkers = data.biomarkerGroups["CBC"] // Default initial panel
      
  RENDER:
    • Header (Source Pill, Row Count, Total Reports Counter)
    • Sidebar Filters (Patient Search Autocomplete, Date Pickers, Panel Checkboxes)
    • Tab 1: Longitudinal Observatory (Trend Line with drill-down, Scatter Plot)
    • Tab 2: Pearson Correlation Heatmap & Summary Statistics Cards
    • Tab 3: 3D OLAP Hypercube (ECharts GL)
    • AI Clinical Assistant Drawer (Markdown Chat & Range Indicators)
```

---

## 10. Database Star Schema & Source Mapping

```
Dimension Tables:
  1. MedID_Dimension          (MedIDDetails.csv + AgeCategories.csv)
  2. LabReference_Dimension   (Medical Records.csv + MedIDDetails.csv)
  3. SampleID_Dimension       (Medical Records.csv)
  4. Collected_Dimension      (Medical Records.csv)
  5. Time_Dimension           (Medical Records.csv)
  6. Reported_Time_Dimension  (Medical Records.csv)

Fact Tables:
  1. Fact_CBC (19 measures)
  2. Fact_Platelet_Profile (9 measures)
  3. Fact_Lipid_Profile (9 measures)
  4. Fact_Liver_Function (11 measures)
  5. Fact_Kidney_Function (9 measures)
  6. Fact_Iron_Profile (4 measures)
  7. Fact_HbA1c (3 measures)
  8. Fact_Urine_ACR (3 measures)
  9. Fact_Calcium_Phos (2 measures)
  10. Fact_Thyroid_Profile (3 measures)
  11. Fact_Glucose_Fasting (1 measure)
  12. Fact_Glucose_PP (1 measure)
  13. Fact_Glucose_Diagnopath (2 measures)
  14. Fact_Urine (17 measures)
```
