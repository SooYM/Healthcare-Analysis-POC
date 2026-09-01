# Getting Started & Developer Guide

## 1. System Requirements & Prerequisites

- **Node.js**: `v18.18.0` or higher (`v20.x` / `v22.x` recommended)
- **Package Manager**: `npm` (v9+) or `yarn` (v1.22+)
- **Operating System**: macOS, Linux, or Windows (WSL2 recommended for Windows)

---

## 2. Quickstart Installation

```bash
# 1. Clone the repository
git clone https://github.com/SooYM/Healthcare-Analysis.git
cd Healthcare-Analysis

# 2. Install dependencies
npm install

# 3. Create local environment configuration
cp .env.example .env.local

# 4. Start the development server
npm run dev
```

Open **http://localhost:3000** in your browser. The dashboard automatically loads the included local dataset (`Dataset/Medical Records.csv`).

---

## 3. Data Source Modes

The application supports three operational data modes configured via `.env.local`:

### Mode A: Local In-Memory Dataset (Default & Recommended)
Zero-cloud setup. Parses and indexes `Dataset/Medical Records.csv` in memory.
```ini
DATA_SOURCE=local
LOCAL_DATASET_PATH=Dataset/Medical Records.csv
DEMO_MODE=false
```

### Mode B: Google Cloud BigQuery
For live cloud queries against a BigQuery Star Schema dataset:
```ini
DATA_SOURCE=bigquery
DEMO_MODE=false
GCP_PROJECT_ID=your-gcp-project-id
BIGQUERY_LOCATION=US
BIGQUERY_DATASET=A2
BIGQUERY_VIEW_NAMES=View_Fact_Urine,View_Fact_CBC,View_Fact_Platelet_Profile,View_Fact_Lipid_Profile,View_Fact_Liver_Function,View_Fact_Kidney_Function,View_Fact_Iron_Profile,View_Fact_HbA1c,View_Fact_Urine_ACR,View_Fact_Calcium_Phos,View_Fact_Thyroid_Profile,View_Fact_Glucose_Fasting,View_Fact_Glucose_PP,View_Fact_Glucose_Diagnopath
GOOGLE_APPLICATION_CREDENTIALS=.secrets/bigquery-sa.json
```

### Mode C: Synthetic Demo Mode
Forces deterministic synthetic curves (48 mock patients):
```ini
DEMO_MODE=true
```

---

## 4. AI Assistant Configuration (Optional)

The AI Explain panel operates in cascading order:
1. **Google Gemini API** (Recommended):
   ```ini
   GEMINI_API_KEY=AIzaSy...
   GEMINI_MODEL=gemini-2.5-flash
   ```
2. **Hugging Face MedGemma**:
   ```ini
   HUGGINGFACE_API_KEY=hf_...
   HUGGINGFACE_MODEL=google/medgemma-27b-text-it
   ```
3. **OpenAI GPT**:
   ```ini
   OPENAI_API_KEY=sk-...
   ```
4. **Offline Mode**: If no API keys are provided, the assistant uses built-in clinical reference ranges (`CLINICAL_RANGES`) to generate structured offline analysis without external network calls.

---

## 5. Development & Build Scripts

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Starts Next.js development server on `http://localhost:3000` with hot-reloading |
| `npm run build` | Compiles optimized production bundle and runs type checking |
| `npm run start` | Runs the compiled production build locally |
| `npm run lint` | Executes ESLint static code analysis |

---

## 6. Project Directory Map

```text
healthcare-dashboard/
├── Dataset/                     # Source medical datasets & SQL transformation scripts
│   ├── Medical Records.csv      # Primary dataset (13,848 visits, 96 columns)
│   ├── MedIDDetails.csv         # Demographics (1,155 patients)
│   ├── AgeCategories.csv        # Age range mapping
│   └── Script/                  # SQL creation scripts (Dimension, Fact, View Fact, MySQL)
├── docs/                        # Complete technical documentation suite
│   ├── SYSTEM_DESIGN.md         # System design & architecture specification
│   ├── DATABASE_SCHEMA.md       # Star Schema data warehouse specification
│   ├── API_REFERENCE.md         # REST API documentation
│   └── GETTING_STARTED.md       # Developer onboarding & setup guide
├── public/                      # Static web assets
├── src/
│   ├── app/                     # Next.js App Router (Pages & API routes)
│   │   ├── api/                 # API endpoints (data, patients, explain, health)
│   │   ├── globals.css          # Tailwind CSS global styles
│   │   ├── layout.tsx           # Root application layout
│   │   └── page.tsx             # Dashboard entry page
│   ├── components/              # React UI components
│   │   ├── Dashboard.tsx        # Main analytics observatory view
│   │   ├── OlapCube.tsx         # 3D OLAP Cube ECharts visualizer
│   │   └── PageTransition.tsx   # Framer Motion transitions
│   ├── lib/                     # Core computational & data libraries
│   │   ├── local-dataset.ts     # In-memory CSV loader & indexer
│   │   ├── bigquery.ts          # BigQuery dynamic UNPIVOT engine
│   │   ├── stats.ts             # Pearson correlation & summary stats
│   │   ├── clinical-ranges.ts   # Reference ranges & triad detection
│   │   ├── gemini.ts            # Google Gemini AI provider
│   │   ├── huggingface.ts       # Hugging Face MedGemma provider
│   │   ├── openai.ts            # OpenAI GPT provider
│   │   ├── demo-data.ts         # Synthetic demo generator
│   │   └── env.ts               # Zod environment validation
│   └── types/                   # TypeScript interfaces and envelopes
├── .env.example                 # Environment configuration template
├── package.json                 # Node dependencies and scripts
└── tsconfig.json                # TypeScript compiler configuration
```
