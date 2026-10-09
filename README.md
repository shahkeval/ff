# Advantedge Operations — POC

A working, demoable version of the Advantedge Operations product: a senior-living
operations intelligence tool that turns uploaded department reports into a scored
KPI scorecard, a live occupancy-driven staffing model, and a consolidated action
plan — matching the "Whitefield Commons" sample report in `Sample Report Outputs/`.

Everything here is fabricated synthetic data for one fictional community,
**Cedar Bluff Commons**, used to prove the pipeline end to end.

## Architecture

```
Browser (Advantedge Operations v3.0.41_1.html)
   │  upload a file (any shape: csv/xlsx/pdf)
   ▼
Backend (server/, Express, http://localhost:4000)
   │  converts file → text → GPT-4.1-mini extracts the operand fields
   │  for that report's bucket, whatever the document's own layout is
   ▼
Postgres (VMP-POC)
   │  operand_values (editable data) · ai_usage_log (field-wise AI usage)
   │  kpi_catalog · operand_registry · benchmark_sources · report_runs
   ▼
engine/compute.js  →  97 KPIs scored + occupancy-driven staffing model
```

If the backend isn't running, or `OPENAI_API_KEY` isn't set yet, the
browser tool falls back to a deterministic local parser (recognizes the
"Operand Key / Value" template in `Synthetic Data/`) so the demo still works
without either — see **What's real vs. what's mocked** below.

## What's in this folder

| Path | What it is |
|---|---|
| `Advantedge Operations v3.0.41_1.html` | The onboarding + reporting tool (frontend). Open directly in a browser. |
| `server/` | The backend: Express API, GPT-4.1-mini document extraction, Postgres persistence. |
| `Synthetic Data/` | 10 ready-to-upload `.xlsx` files (one per department report) for the live demo. |
| `engine/` | Node port of the tool's compute logic — KPI scoring, staffing model, dataset/seed generation. |
| `db/` | Postgres schema + seed SQL and reusable query files. |
| `Sample Report Outputs/`, `VMP_Senior_Living_KPI_Problem_Output_Benchmark_Decision.xlsx` | The original reference materials this POC was built to match. |

## Running the live demo

### 1. Start the backend

```
cd server
npm install                     # first time only
$env:OPENAI_API_KEY = "sk-..."  # PowerShell — omit to run without real AI extraction
node index.js
```

Runs on `http://localhost:4000`. Without `OPENAI_API_KEY` set, document
uploads still work end-to-end (document row + graceful "no key configured"
error logged, browser falls back to local parsing) — set the key any time
and re-upload to get real extraction with no other changes needed.

### 2. Open the frontend

Open `Advantedge Operations v3.0.41_1.html` directly in a browser (no build
step). It talks to the backend at `http://localhost:4000` automatically.

1. On the first screen, click **Load demo profile (Cedar Bluff Commons)**.
2. Go to **Reports to Run** and upload each file from `Synthetic Data/` into
   its matching drop zone (census → `01-census.xlsx`, payroll →
   `02-payroll.xlsx`, … through `10-manual.xlsx`), clicking **Upload &
   extract** each time. Each upload is sent to the backend, which converts
   the file to text and asks GPT-4.1-mini to find that bucket's fields —
   the result panel shows the model used, tokens captured, and estimated
   cost, and the values are saved to Postgres (`operand_values`), not just
   this browser tab.
3. Go to **KPI Scorecard** — all 97 measures compute and score (the 26 CMS
   Five-Star measures resolve from a built-in mock Care Compare fetch).
4. **Generate Action Plan** — uses the AI service if configured; otherwise
   falls back to a deterministic, rules-based plan built from the scored
   gaps, so it always produces something.
5. **Generate Report** → **Print / Save as PDF**.

To see the report change: edit a value in Postgres (see below) or re-upload
a corrected report file — re-uploading the same bucket **overwrites** that
bucket's prior values (no duplicates, no stale leftovers), then regenerate.

### Realistic (non-templated) documents

`Synthetic Data/*.xlsx` uses a simple "Operand Key / Value" layout so the
local fallback parser can read it deterministically. To actually exercise
the AI extraction on a document that *doesn't* match any fixed template —
proving the "dynamic, find-the-information" extraction, not a lookup —
upload any real-shaped report instead (a raw payroll register, a GL export,
a census table with whatever columns your system produces). As long as it's
`.csv`, `.xlsx`/`.xls`, or a text-based `.pdf`, the backend converts it to
text and asks the model to find the same fields by meaning.

## Database

### Schema

```
node db/run-sql.js 001_schema.sql               -- communities, kpi_catalog, kpi_inputs,
                                                 --   operand_registry, operand_values,
                                                 --   cms_fivestar_values, report_runs
node db/run-sql.js 002_seed_kpi_catalog.sql
node db/run-sql.js 003_seed_operand_registry.sql
node db/run-sql.js 004_seed_demo_community.sql
node db/run-sql.js 005_schema_backend.sql       -- documents, ai_usage_log, benchmark_sources
node db/run-sql.js 006_seed_benchmark_sources.sql
```

| Table | What |
|---|---|
| `communities` | Profile: units/sqft/occupancy **per care level**, CCRC/ownership structure. |
| `kpi_catalog` / `kpi_inputs` | The 97 KPIs, each with its formula and benchmark threshold. |
| `operand_registry` | The 124 fields the tool can capture, grouped by family/bucket. |
| `operand_values` | **The editable data** — one row per community per field. Change one, regenerate, everything downstream moves. |
| `cms_fivestar_values` | Mock CMS Care Compare fetch for the 26 SNF Five-Star measures. |
| `documents` | One row per uploaded file — bucket, filename, status (received/extracting/extracted/failed), error if any. |
| `ai_usage_log` | **Field-wise AI usage** — one row per operand field the model was asked to find in a given document: found or not, model, prompt/completion/total tokens, estimated cost, grouped by `request_id` per API call. |
| `benchmark_sources` | Reference data for the named industry sources the catalog cites (SOSH, CARF, CMS, Aline, Siemens/Brightly, CLA, RC 2025, ENERGY STAR, Kushant Shah). |
| `report_runs` | Snapshot of every computed report (summary + full results), for history. |

### Editing data directly

```sql
UPDATE operand_values SET value = 6
WHERE community_id = (SELECT id FROM communities WHERE slug = 'cedar-bluff-commons')
  AND operand_key = 'openPositions';
```

Then either re-upload in the browser (`GET /api/communities/cedar-bluff-commons/kpis`
picks it up immediately) or run:

```
node engine/generate-report-from-db.js cedar-bluff-commons
```

See `db/queries/` for more (viewing current gaps, resetting to baseline).

### Resetting a community's uploaded data

```
curl -X POST http://localhost:4000/api/communities/cedar-bluff-commons/reset
```

Clears `documents`, `operand_values`, and `ai_usage_log` for that community
(profile and CMS mock data are untouched) — a clean slate to re-run the
upload demo. Re-seed the shipped baseline afterward with
`node db/run-sql.js 004_seed_demo_community.sql`.

## Backend API reference

| Method & path | What |
|---|---|
| `GET /api/health` | `{ok, openaiConfigured}` |
| `POST /api/communities` | Create/update a community profile |
| `GET /api/communities/:slug` | Fetch a community |
| `POST /api/communities/:slug/reset` | Wipe uploaded data (see above) |
| `POST /api/communities/:slug/documents/:bucket` | Upload a file (`multipart/form-data`, field `file`) → AI-extract → persist |
| `GET /api/communities/:slug/documents` | List uploaded documents + status |
| `GET /api/communities/:slug/schema/:bucket` | The operand fields expected for a bucket |
| `GET /api/communities/:slug/kpis` | Compute all 97 KPIs from current DB data |
| `GET /api/communities/:slug/staffing` | Compute the occupancy-driven staffing model |
| `GET /api/benchmarks` | List benchmark source reference data |
| `GET /api/benchmarks/kpi-catalog` | Full KPI catalog |
| `GET /api/benchmarks/ai-usage/:slug` | Field-wise AI usage summary for a community |

## Regenerating the synthetic dataset / files

`engine/build-dataset.js` is the single source of truth for Cedar Bluff
Commons' numbers (internally consistent — census ties to resident-days,
payroll ties to labor cost, etc.). Edit it, then:

```
node engine/build-dataset.js      # -> engine/dataset.json
node engine/gen-sql.js            # -> db/002_*.sql, 003_*.sql, 004_*.sql
node engine/export-xlsx.js        # -> Synthetic Data/*.xlsx
node engine/validate.js           # sanity-check: all 97 KPIs compute, no errors
```

## What's real vs. what's mocked

- **Real**: the 97-measure KPI catalog, every formula and benchmark
  threshold, the occupancy-driven staffing model (`sbcCompute`), the
  scoring logic, the report layout, the backend's document→text→GPT-4.1-mini
  extraction pipeline — all functional, not simulated.
- **Mocked for the POC**: Cedar Bluff Commons itself (fictional), the CMS
  Five-Star fetch (normally a live Care Compare API call), and — until an
  `OPENAI_API_KEY` is set — actual AI extraction results (the system falls
  back to deterministic local parsing so the demo still runs).
