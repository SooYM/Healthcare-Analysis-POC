# Medical Records Data Warehouse — BigQuery Star Schema

## Overview

This project transforms raw medical laboratory CSV data into a fully normalized **star-schema data warehouse** on **Google BigQuery**. The pipeline takes three flat CSV source files, creates **6 dimension tables** and **14 fact tables**, and exposes **14 analytics-ready views** — enabling the Healthcare Dashboard (and any BI tool) to query patient health metrics with minimal complexity.

> **BigQuery Project**: `bigquery-tutorial-480009`  
> **Dataset**: `A2`

---

## Source Files

| File | Rows | Description |
|---|---|---|
| `AgeCategories.csv` | 7 | Maps age ranges (25–29, 30–34, …, 55–60) to human-readable life-stage labels (e.g. *Early Adulthood*, *Nearing Retirement*). |
| `MedIDDetails.csv` | 1,155 | Patient demographics — MedID, LabReference, masked names, age, gender (incl. PNTD, TrFe, TrMale, NS), diet type, and registration weight. |
| `Medical Records.csv` | 13,849 | Comprehensive lab results per patient visit. Contains **96 columns** spanning: Urine Analysis, CBC, Platelet Profile, Lipid Profile, Liver Function, Kidney Function, Iron Profile, HbA1c, Urine ACR, Calcium & Phosphorus, Thyroid Profile, and three Glucose panels. |

---

## Architecture

```
┌─────────────────────────────────────────┐
│            SOURCE CSVs                  │
│  AgeCategories · MedIDDetails           │
│  Medical Records (cleaned)              │
└───────────────┬─────────────────────────┘
                │  SQL Scripts (Dataset/Script/)
                ▼
┌─────────────────────────────────────────┐
│         DIMENSION TABLES (6)            │
│  MedID_Dimension                        │
│  LabReference_Dimension                 │
│  SampleID_Dimension                     │
│  Collected_Dimension (Date)             │
│  Time_Dimension                         │
│  Reported_Time_Dimension                │
└───────────────┬─────────────────────────┘
                │  Foreign Keys (surrogate IDs)
                ▼
┌─────────────────────────────────────────┐
│           FACT TABLES (14)              │
│  Fact_Urine          Fact_HbA1c         │
│  Fact_CBC            Fact_Urine_ACR     │
│  Fact_Platelet       Fact_Calcium_Phos  │
│  Fact_Lipid          Fact_Thyroid       │
│  Fact_Liver          Fact_Glucose_Fast  │
│  Fact_Kidney         Fact_Glucose_PP    │
│  Fact_Iron           Fact_Glucose_Diag  │
└───────────────┬─────────────────────────┘
                │  JOINs → denormalized
                ▼
┌─────────────────────────────────────────┐
│        ANALYTICS VIEWS (14)             │
│  View_Fact_Urine … View_Fact_Glucose_*  │
│  (flat, dashboard-ready, null-safe)     │
└───────────────┬─────────────────────────┘
                │  UNION ALL (BIGQUERY_VIEW_NAMES)
                ▼
┌─────────────────────────────────────────┐
│     HEALTHCARE DASHBOARD (Next.js)      │
│  • Local CSV Engine: local-dataset.ts   │
│  • BigQuery Engine:  bigquery.ts        │
│  • MySQL 8.0 Script: healthcare_mysql   │
└─────────────────────────────────────────┘
```

---

## Dimension Tables

| Table | Key Columns | Source |
|---|---|---|
| **MedID_Dimension** | ID (surrogate), Original_MedID, First_Name, Last_Name, Age, Age_Category, Gender, Diet, Registration_Weight | `MedIDDetails` + `AgeCategories` (LEFT JOIN on age range) |
| **LabReference_Dimension** | ID, LabReference | UNION DISTINCT of `Medical_Records` and `MedIDDetails` |
| **SampleID_Dimension** | ID, Sample_ID (STRING) | DISTINCT from `Medical_Records_Cleaned` |
| **Collected_Dimension** | ID, Date | DISTINCT dates from `Medical_Records_Cleaned` |
| **Time_Dimension** | ID, Time (TIME) | DISTINCT collection times |
| **Reported_Time_Dimension** | ID, Reported_Time (TIME) | DISTINCT reported times |

---

## Fact Tables

Each fact table stores **6 foreign keys** (MedID_FK, LabReference_FK, SampleID_FK, Collected_FK, Time_FK, Reported_Time_FK) plus domain-specific **measures**:

| Fact Table | Measures | Count |
|---|---|---|
| **Fact_Urine** | Colour, Appearance, Specific Gravity, pH, Proteins, Glucose, Bilirubin, Ketones, Blood, Urobilinogen, Nitrites, WBC/Pus Cells, RBC, Epithelial Cells, Casts, Crystals, Others | 17 |
| **Fact_CBC** | Hemoglobin, RBC Count, Hematocrit, MCV, MCH, MCHC, RDW-CV, RDW-SD, WBC Count, Neutrophils %, Lymphocytes %, Eosinophils %, Monocytes %, Basophils %, Abs Neutrophils/Lymphocytes/Monocytes/Eosinophils/Basophils | 19 |
| **Fact_Platelet_Profile** | Platelet Count, MPV, Platelet RDW, PCT, P-LCR, IMG, IMM, IML, LIC | 9 |
| **Fact_Lipid_Profile** | Total Cholesterol, HDL, LDL, VLDL, Triglycerides, Non-HDL, Total/HDL Ratio, LDL/HDL Ratio, HDL/LDL Ratio | 9 |
| **Fact_Liver_Function** | Bilirubin (Total/Direct/Indirect), ALP, ALT/SGPT, AST/SGOT, GGT, Protein Total, Albumin, Globulin, A/G Ratio | 11 |
| **Fact_Kidney_Function** | Creatinine, Urea, BUN, BUN/Creatinine Ratio, Sodium, Potassium, Chloride, Uric Acid, eGFR | 9 |
| **Fact_Iron_Profile** | Iron, UIBC, TIBC, Transferrin Saturation | 4 |
| **Fact_HbA1c** | HbA1c, Estimated Avg Glucose, HbF | 3 |
| **Fact_Urine_ACR** | Urine Albumin, Urine Creatinine, Albumin/Creatinine Ratio | 3 |
| **Fact_Calcium_Phos** | Calcium, Phosphorus | 2 |
| **Fact_Thyroid_Profile** | TT3, TT4, TSH | 3 |
| **Fact_Glucose_Fasting** | Fasting Glucose | 1 |
| **Fact_Glucose_PP** | Postprandial Glucose | 1 |
| **Fact_Glucose_Diagnopath** | FBS, PLBS | 2 |

---

## Analytics Views

Each view denormalizes a fact table back into a **flat, query-friendly** format by joining the MedID and Collected dimensions. All views share a standard header:

- `Original_MedID`, `First_Name`, `Last_Name`, `Gender`, `Age_Category`, `Test_Date`

Plus the domain-specific metrics, all wrapped in `IFNULL()` for null-safety.

These are the views queried by the dashboard via `BIGQUERY_VIEW_NAMES` (UNION ALL, dynamic UNPIVOT into long-format `BiomarkerRow[]`).

---

## Key Design Decisions

1. **Surrogate Keys**: All dimensions use `ROW_NUMBER() OVER (...)` to generate sequential `INT64` IDs.
2. **Null Handling**: `COALESCE()` in fact tables (defaults: `0`, `0.0`, `'Unknown'`, `-1`); `IFNULL()` in views.
3. **Type Casting**: `SAFE_CAST()` used for Lipid Profile VLDL/Triglycerides (STRING → FLOAT64) and Liver A/G Ratio.
4. **Age Categorization**: Joined at dimension-build time using a CTE that parses `AgeCategories.csv` ranges (handles both `–` and `-` delimiters).
5. **Privacy**: Patient names are masked in the source CSV with asterisks.
6. **Dashboard Integration**: View column names `Original_MedID` and `Test_Date` map to the dashboard's `BQ_COL_PATIENT_ID` and `BQ_COL_VISIT_DATE` environment variables.

---

## How to Execute

1. Upload the three CSV files to BigQuery dataset `bigquery-tutorial-480009.A2`.
2. Run the SQL scripts in `Dataset/Script/` in order:
   - **Dimension scripts** (`Dataset/Script/Dimension/*.sql`) — build lookup tables first
   - **Fact scripts** (`Dataset/Script/Fact/*.sql`) — build domain-specific measure tables
   - **View scripts** (`Dataset/Script/View Fact/*.sql`) — build denormalized analytics views
   
   Alternatively, follow the consolidated instructions in `Script 2.0.pdf`.
3. Connect the dashboard by setting `BIGQUERY_VIEW_NAMES` in `.env.local` to all 14 `View_Fact_*` names.
4. Or connect your BI tool (Looker Studio, Tableau, etc.) to the views directly.

---

## File Inventory

```
Dataset/
├── AgeCategories.csv        # Age-range → life-stage mapping (7 rows)
├── MedIDDetails.csv         # Patient demographics (1,155 rows)
├── Medical Records.csv      # Lab results (13,849 rows, 96 columns)
├── Script 2.0.pdf           # Complete BigQuery SQL reference (58 pages)
├── Script/
│   ├── Dimension/           # 6 dimension table SQL scripts
│   │   ├── MedID_Dimension.sql
│   │   ├── LabReference_Dimension.sql
│   │   ├── SampleID_Dimension.sql
│   │   ├── Collected_Dimension.sql
│   │   ├── Time_Dimension.sql
│   │   └── Reported_Time_Dimension.sql
│   ├── Fact/                # 14 fact table SQL scripts
│   │   ├── Fact_Urine.sql … Fact_Glucose_Diagnopath.sql
│   │   └── (one per clinical domain)
│   └── View Fact/           # 14 analytics view SQL scripts
│       ├── View_Fact_Urine.sql … View_Fact_Glucose_Diagnopath.sql
│       └── (one per fact table)
├── README.md                # ← You are here
├── walkthrough.md           # Step-by-step execution walkthrough
└── pseudocode.md            # High-level pseudocode for every SQL object
```
