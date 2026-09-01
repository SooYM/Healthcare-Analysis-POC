# API Reference — Biomarker Observatory

## 1. Architecture & Protocol Standards

The Healthcare Dashboard exposes RESTful JSON endpoints implemented via the Next.js 15 App Router (`src/app/api/`).
- **Transport**: HTTPS / HTTP
- **Data Encoding**: `application/json; charset=utf-8`
- **Error Format**: Uniform JSON envelope containing `{ "error": string, "details"?: object }`
- **Validation**: Strict request payload validation via Zod schemas

---

## 2. Endpoints Overview

| Method | Endpoint | Description | Auth / Key Requirements |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Service liveness and health probe | None |
| `GET` | `/api/patients` | Retrieve list of unique patient IDs and cohort total | None |
| `POST` | `/api/data` | Query longitudinal biomarker records, correlation matrix & summary stats | None (uses active data source) |
| `POST` | `/api/explain` | AI Clinical Assistant explanation and pattern detection | Optional AI API key (Gemini / MedGemma / OpenAI / Offline) |

---

## 3. Detailed Endpoint Specifications

### 3.1. Health Check (`GET /api/health`)

Checks server availability and operational status.

#### Request
```http
GET /api/health HTTP/1.1
Host: localhost:3000
```

#### Response (`200 OK`)
```json
{
  "ok": true,
  "service": "healthcare-dashboard"
}
```

---

### 3.2. Patient Cohort Discovery (`GET /api/patients`)

Returns all distinct patient identifiers available in the data warehouse or local CSV dataset, along with total recorded visits.

#### Request
```http
GET /api/patients HTTP/1.1
Host: localhost:3000
```

#### Response (`200 OK`)
```json
{
  "patientIds": [
    "100004",
    "100271",
    "100311",
    "100427",
    "100757",
    "560252"
  ],
  "totalReports": 13848
}
```

---

### 3.3. Biomarker Longitudinal Query (`POST /api/data`)

Streams filtered biomarker observation rows, calculates real-time Pearson correlation matrix, and generates cohort distribution metrics.

#### Request
```http
POST /api/data HTTP/1.1
Host: localhost:3000
Content-Type: application/json

{
  "dateFrom": "2018-08-24",
  "dateTo": "2019-07-24",
  "biomarkers": ["Hemoglobin", "Total_Cholesterol", "HbA1c", "Fasting_Glucose"],
  "patientId": "560252",
  "rowLimit": 5000
}
```

#### Request Body Schema
| Field | Type | Required | Default | Description |
| :--- | :--- | :---: | :--- | :--- |
| `dateFrom` | `string` | **Yes** | - | Start date in `YYYY-MM-DD` format (inclusive) |
| `dateTo` | `string` | **Yes** | - | End date in `YYYY-MM-DD` format (inclusive) |
| `biomarkers` | `string[]` | No | All | Whitelist array of clinical biomarker names |
| `patientId` | `string` | No | - | Filter records for a single patient ID |
| `rowLimit` | `number` | No | `80000` | Max rows to return (min 100, max 200,000) |

#### Response (`200 OK`)
```json
{
  "source": "local_csv",
  "rows": [
    {
      "patient_id": "560252",
      "visit_date": "2018-08-26",
      "biomarker": "Hemoglobin",
      "value": 15.2,
      "group": "CBC"
    },
    {
      "patient_id": "560252",
      "visit_date": "2018-08-26",
      "biomarker": "Total_Cholesterol",
      "value": 196.0,
      "group": "Lipid Profile"
    }
  ],
  "biomarkers": ["Fasting_Glucose", "HbA1c", "Hemoglobin", "Total_Cholesterol"],
  "biomarkerGroups": {
    "CBC": ["Hemoglobin"],
    "Lipid Profile": ["Total_Cholesterol"],
    "HbA1c": ["HbA1c"],
    "Glucose - Fasting": ["Fasting_Glucose"]
  },
  "dateRange": {
    "min": "2018-08-24",
    "max": "2019-07-24"
  },
  "rowCount": 48,
  "correlation": {
    "Hemoglobin": {
      "Hemoglobin": 1.0,
      "Total_Cholesterol": 0.342,
      "HbA1c": -0.118,
      "Fasting_Glucose": 0.054
    }
  },
  "summary": {
    "Hemoglobin": {
      "mean": 14.85,
      "std": 0.62,
      "min": 13.9,
      "max": 15.8,
      "n": 12
    }
  }
}
```

---

### 3.4. AI Clinical Assistant (`POST /api/explain`)

Enriches user inquiries with exact biomarker values, normal reference ranges, and detected physiological patterns, routing through the AI cascade.

#### Request
```http
POST /api/explain HTTP/1.1
Host: localhost:3000
Content-Type: application/json

{
  "question": "What does the correlation between ALT and AST indicate for this patient?",
  "context": {
    "dataSource": "local_csv",
    "rowCount": 24,
    "filters": {
      "dateFrom": "2018-08-24",
      "dateTo": "2019-07-24",
      "patientId": "560252",
      "biomarkers": ["ALT_SGPT", "AST_SGOT"]
    },
    "rows": [
      { "visit_date": "2018-08-26", "biomarker": "ALT_SGPT", "value": 47.0 },
      { "visit_date": "2018-08-26", "biomarker": "AST_SGOT", "value": 35.0 }
    ],
    "correlation": {
      "ALT_SGPT": { "AST_SGOT": 0.814 }
    }
  }
}
```

#### Response (`200 OK`)
```json
{
  "answer": "### **Clinical Analysis**\n\n1. **Current Values vs Normal Ranges**:\n   - **ALT (SGPT)**: 47.0 U/L (Normal: 7–56 U/L) — *Within normal physiological limits*.\n   - **AST (SGOT)**: 35.0 U/L (Normal: 10–40 U/L) — *Within normal physiological limits*.\n\n2. **Correlation Context**:\n   - The observed Pearson correlation of **r = 0.814** demonstrates strong co-variance, typical of hepatic transaminases.",
  "mode": "gemini",
  "warning": null
}
```

---

## 4. HTTP Status Codes & Error Handling

| Code | Meaning | Example Cause |
| :--- | :--- | :--- |
| `200` | **OK** | Successful query execution |
| `400` | **Bad Request** | Invalid JSON syntax or Zod validation failure (e.g. invalid date regex) |
| `500` | **Internal Server Error** | Unexpected unhandled failure |
