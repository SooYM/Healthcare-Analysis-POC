# System Design & Architecture — Biomarker Observatory

## 1. Executive Summary

The **Biomarker Observatory** is a production-grade healthcare data intelligence platform engineered to ingest, normalize, and visualize longitudinal patient biomarker measurements across cohorts. The system provides sub-second query performance over tens of thousands of records, computes real-time statistical metrics (including Pearson correlation matrices and cohort aggregates), facilitates multidimensional slicing via a 3D OLAP Cube, and delivers AI-assisted clinical reasoning grounded in standardized clinical reference ranges.

---

## 2. High-Level Architecture Diagram

```mermaid
flowchart TD
    subgraph ClientLayer ["Client Presentation Layer (Browser)"]
        UI["Next.js React 19 UI"]
        Charts["Apache ECharts Engine\n(Trends · Scatter · Heatmap)"]
        OLAP["3D OLAP Cube (ECharts GL)"]
        AIPanel["AI Clinical Assistant Panel"]
    end

    subgraph AppRouterLayer ["Next.js App Router (Server-Side)"]
        APIData["/api/data\n(Filtering, Correlation, Summary)"]
        APIPatients["/api/patients\n(Cohort Discovery)"]
        APIExplain["/api/explain\n(Prompt Enrichment & AI Cascade)"]
        APIHealth["/api/health\n(Liveness & Probes)"]
    end

    subgraph CoreEngineLayer ["Core Computation & Query Engines"]
        LocalEngine["In-Memory Local Dataset Engine\n(Singleton Cache · Indexer · Parser)"]
        BQEngine["BigQuery Star-Schema Engine\n(Dynamic UNPIVOT & UNION ALL)"]
        StatsEngine["Statistical Computation Engine\n(Pearson Correlation · Covariance · Aggregates)"]
        ClinicalRanges["Clinical Range & Pattern Detector\n(40+ Reference Ranges · Triad Alerts)"]
    end

    subgraph StorageLayer ["Data Storage & Warehousing"]
        CSV["Dataset/Medical Records.csv\n(13,848 Visits · 1,154 Patients · 78 Biomarkers)"]
        BQ["Google Cloud BigQuery (Dataset A2)\n(6 Dimensions · 14 Facts · 14 Views)"]
        MySQL["MySQL 8.0 / phpMyAdmin\n(healthcare_dashboard_mysql.sql)"]
    end

    subgraph LLMProviders ["AI Provider Cascade"]
        Gemini["Google Gemini API (Primary)\n(gemini-2.5-flash / gemini-2.0-flash)"]
        MedGemma["Hugging Face MedGemma (Clinical)\n(medgemma-27b-text-it)"]
        OpenAI["OpenAI GPT (Fallback)\n(gpt-5.5 / gpt-4o)"]
        OfflineStub["Offline Clinical Summary Engine\n(Deterministic Rules & Range Flags)"]
    end

    %% Interactions
    UI --> APIData & APIPatients & APIExplain & APIHealth
    Charts & OLAP & AIPanel --- UI

    APIData --> LocalEngine & BQEngine & StatsEngine
    APIPatients --> LocalEngine & BQEngine
    APIExplain --> ClinicalRanges & Gemini & MedGemma & OpenAI & OfflineStub

    LocalEngine --> CSV
    BQEngine --> BQ
    MySQL -.-> StorageLayer
```

---

## 3. Core Architectural Subsystems

### 3.1. In-Memory Local Dataset Engine (`src/lib/local-dataset.ts`)
- **Purpose**: Provides instantaneous, zero-cloud data loading for local prototypes, air-gapped clinical deployments, or environments where cloud API keys have expired.
- **Mechanism**:
  - Employs a **singleton memory pattern** (`loadLocalDataset()`). On the first API call, the 6.6 MB CSV file is read and indexed in under 15ms.
  - **Date Normalization**: Seamlessly resolves Excel serial day offsets (e.g. `43549` $\rightarrow$ `2019-03-25`), international `DD/MM/YYYY` dates, and `YYYY-MM-DD` strings.
  - **Transposition & Indexing**: Normalizes 78 wide-format observation columns into long-format records (`patient_id`, `visit_date`, `biomarker`, `value`, `group`), while maintaining a per-patient index map (`Map<string, LocalDatasetRecord[]>`) for instant single-patient queries ($<1\text{ms}$).

### 3.2. BigQuery Data Warehouse Engine (`src/lib/bigquery.ts`)
- **Purpose**: Enterprise cloud scalability over petabyte-scale data lakes.
- **Mechanism**:
  - Dynamically inspects table schemas at runtime using `INFORMATION_SCHEMA.COLUMNS` to discover numeric measures.
  - Generates parameter-safe `UNPIVOT` statements on demand for each view table.
  - Bundles all fact views into a single-pass `UNION ALL` query, bounded by a 5 GB billing ceiling (`maximumBytesBilled`) for cost governance.

### 3.3. Statistical Analysis Engine (`src/lib/stats.ts`)
- **Purpose**: Computes cohort-wide statistical correlations and descriptive distribution metrics on the fly.
- **Formulas & Algorithm**:
  - **Pairwise Pearson Correlation**:
    $$\rho_{X, Y} = \frac{n \sum xy - \sum x \sum y}{\sqrt{(n \sum x^2 - (\sum x)^2)(n \sum y^2 - (\sum y)^2)}}$$
  - **Same-Visit Pairing**: Grouping rows by `patient_id|visit_date` ensures correlation calculations only compare measurements obtained synchronously during the same clinical encounter.
  - **Sample Variance with Bessel's Correction**:
    $$s^2 = \frac{1}{n - 1} \sum_{i=1}^n (x_i - \bar{x})^2$$

### 3.4. Multidimensional OLAP Engine (`src/components/OlapCube.tsx`)
- **Purpose**: Enables true multi-dimensional drill-down, roll-up, slicing, and dicing across 4 dimensions:
  1. **Time** (Granularity: Day vs Month)
  2. **Biomarker** (Individual assay selection)
  3. **Patient Cohort** (Single patient vs multi-patient selection)
  4. **Clinical Panel Group** (e.g., CBC, Lipid, Liver, Renal)
- **Visual Projection**: Renders a 3D bar matrix using **ECharts GL** with orbital camera controls alongside synchronized 2D heatmap projections.

### 3.5. Cascading AI Clinical Assistant (`src/app/api/explain/route.ts`)
- **Purpose**: Translates complex numeric lab distributions into actionable clinical insights with evidence-based guardrails.
- **Cascade Architecture**:
  1. **Google Gemini** (`gemini-2.5-flash`): Primary LLM utilizing REST API key authentication.
  2. **Hugging Face MedGemma** (`medgemma-27b-text-it`): Specialized open medical foundation model.
  3. **OpenAI GPT** (`gpt-5.5` / `gpt-4o`): Secondary fallback provider.
  4. **Offline Clinical Rule Engine**: Deterministic fallback checking measurements against `CLINICAL_RANGES` and generating structured clinical summaries when no external network or API key is accessible.

---

## 4. Data Flow Walkthrough

```mermaid
sequenceDiagram
    autonumber
    actor User as Clinician / Researcher
    participant UI as Dashboard UI (React)
    participant API as /api/data (Next.js)
    participant Engine as Local / BigQuery Engine
    participant Stats as Stats Engine

    User->>UI: Selects Patient "560252" & Dates "2018-08-24 to 2019-07-24"
    UI->>API: POST /api/data { patientId, dateFrom, dateTo, rowLimit: 80000 }
    API->>Engine: queryLocalBiomarkers() / queryBiomarkerLong()
    Engine-->>API: Returns BiomarkerRow[] (Filtered cohort slice)
    API->>Stats: correlationMatrix(rows) & summaryStats(rows)
    Stats-->>API: Pearson matrix & summary (mean, std, min, max, n)
    API-->>UI: Returns DataResponse payload
    UI->>UI: Renders Trend Lines, Correlation Heatmap & Scatter Plots
    
    opt Ask AI Clinical Assistant
        User->>UI: Types "Explain my Fasting Glucose & HbA1c trajectory"
        UI->>API: POST /api/explain { question, context }
        API->>API: Enriches prompt with CLINICAL_RANGES & pattern detection
        API->>API: Executes AI Cascade (Gemini -> MedGemma -> OpenAI -> Offline)
        API-->>UI: Returns clinical interpretation & abnormal flags
    end
```

---

## 5. Non-Functional Requirements & Design Decisions

| Attribute | Implementation Strategy | Rationale |
| :--- | :--- | :--- |
| **Latency** | In-memory singleton caching (`local-dataset.ts`) | Query responses under 10ms for full-cohort slicing (13,848 rows). |
| **Reliability** | 4-tier AI cascade + 3-tier data source fallback | Zero crashes even when external cloud credentials expire or network fails. |
| **Type Safety** | Strict TypeScript 5.7 + Zod runtime validation | Prevents runtime schema mismatch between client, server, and SQL. |
| **Security & Privacy** | `.secrets/`, `.env.local` strictly gitignored; patient data contained locally | Complies with patient privacy and prevents accidental API key leakage. |
| **Extensibility** | Universal `BiomarkerRow` contract | New data sources (DuckDB, PostgreSQL, FHIR) can be added with zero UI changes. |
