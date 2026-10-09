-- Backend layer: real document uploads, AI extraction usage, and benchmark
-- reference data. Adds to 001_schema.sql; safe to re-run.

-- Every file a user uploads, whatever its native shape (pdf/image/csv/xlsx/
-- docx/txt) — one row per upload, independent of whether extraction succeeded.
CREATE TABLE IF NOT EXISTS documents (
  id              SERIAL PRIMARY KEY,
  community_id    INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  bucket          TEXT NOT NULL,        -- census|payroll|clinical|dining|sales|plant|incident|life-enrichment|financial|manual
  file_name       TEXT NOT NULL,
  mime_type       TEXT,
  byte_size       INTEGER,
  status          TEXT NOT NULL DEFAULT 'received', -- received | extracting | extracted | failed
  error           TEXT,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_community ON documents(community_id, bucket);

-- Field-wise AI extraction usage log — one row per operand field the model
-- was asked to find in a given document, whether or not it found a value.
-- request_id groups every row from the same API call (so the token/cost
-- figures, which are per-call, can be read either per-call or per-field).
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id                  SERIAL PRIMARY KEY,
  request_id          UUID NOT NULL,
  community_id        INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  document_id         INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  bucket              TEXT NOT NULL,
  operand_key         TEXT NOT NULL REFERENCES operand_registry(operand_key),
  found               BOOLEAN NOT NULL,       -- did the model return a non-null value for this field?
  extracted_value     TEXT,                   -- as returned, before numeric coercion
  model               TEXT NOT NULL,          -- e.g. 'gpt-4.1-mini'
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  total_tokens        INTEGER,
  estimated_cost_usd  NUMERIC(10,6),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_community ON ai_usage_log(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_operand ON ai_usage_log(operand_key);
CREATE INDEX IF NOT EXISTS idx_ai_usage_request ON ai_usage_log(request_id);

-- Reference table for the named industry benchmark sources the KPI catalog
-- cites (SOSH, CARF, CMS, Aline, Siemens/Brightly, CLA, RC 2025, etc.) — the
-- "who published this target and where" backing the benchmark_source column
-- already on kpi_catalog. Dummy/reference data: real source names and scope,
-- standing in for the full published tables.
CREATE TABLE IF NOT EXISTS benchmark_sources (
  id              SERIAL PRIMARY KEY,
  match_key       TEXT UNIQUE NOT NULL,   -- matches kpi_catalog.benchmark_source substring
  source_name     TEXT NOT NULL,
  applies_to      TEXT,                   -- e.g. 'IL, AL, MC, CCRC'
  vintage         TEXT,                   -- e.g. '2025 edition'
  url             TEXT,
  notes           TEXT
);
