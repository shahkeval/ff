-- Advantedge Operations POC — schema
-- Run once against the VMP-POC database. Safe to re-run (idempotent creates).

CREATE TABLE IF NOT EXISTS communities (
  id                  SERIAL PRIMARY KEY,
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  operator            TEXT,
  address             TEXT,
  city_state_zip      TEXT,
  state_abbr          TEXT,
  units_il            INTEGER DEFAULT 0,
  units_al            INTEGER DEFAULT 0,
  units_mc            INTEGER DEFAULT 0,
  units_snf           INTEGER DEFAULT 0,
  sqft_il             INTEGER,
  sqft_al             INTEGER,
  sqft_mc             INTEGER,
  sqft_snf            INTEGER,
  sqft_total          INTEGER,
  current_occupancy   NUMERIC(5,1),   -- blended campus occupancy (display only)
  occupancy_il        NUMERIC(5,1),   -- per-care-level occupancy % — what the staffing/financial model actually uses
  occupancy_al        NUMERIC(5,1),
  occupancy_mc        NUMERIC(5,1),
  occupancy_snf       NUMERIC(5,1),
  year_opened         INTEGER,
  care_levels         TEXT[],
  structure           JSONB,          -- {ccrc, ownership, tax, config, optSecurity}
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The 115/97-measure KPI catalog: one row per KPI code, with its formula and
-- benchmark threshold, exactly as defined in the Advantedge Operations tool.
CREATE TABLE IF NOT EXISTS kpi_catalog (
  code                TEXT PRIMARY KEY,
  section             TEXT NOT NULL,
  name                TEXT NOT NULL,
  unit                TEXT,
  source              TEXT NOT NULL,     -- 'upload' | 'cms' | 'manual'
  intake              TEXT,
  formula             TEXT,              -- JS expression over input keys, or 'direct' / 'distribution'
  benchmark_value     TEXT,
  benchmark_source    TEXT,
  benchmark_basis     TEXT,
  threshold_scored    BOOLEAN,
  threshold_direction TEXT,              -- 'higher' | 'lower' | 'zero' | 'band' | 'bandabs'
  threshold_target    NUMERIC,
  threshold_lo        NUMERIC,
  threshold_hi        NUMERIC,
  cms_fetched         BOOLEAN NOT NULL DEFAULT FALSE
);

-- Each KPI's required input operands (a KPI can need several).
CREATE TABLE IF NOT EXISTS kpi_inputs (
  id          SERIAL PRIMARY KEY,
  kpi_code    TEXT NOT NULL REFERENCES kpi_catalog(code) ON DELETE CASCADE,
  input_key   TEXT NOT NULL,
  label       TEXT,
  unit        TEXT
);
CREATE INDEX IF NOT EXISTS idx_kpi_inputs_code ON kpi_inputs(kpi_code);

-- Master registry of every field the onboarding tool can capture (~124 keys),
-- grouped into families that map to the upload buckets (census, payroll,
-- clinical, dining, sales, plant, incident, life-enrichment, financial, manual).
CREATE TABLE IF NOT EXISTS operand_registry (
  operand_key TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  unit        TEXT,
  family      TEXT NOT NULL,
  intake      TEXT NOT NULL   -- 'extract' | 'manual'
);

-- The EDITABLE data: one row per community per operand key. Change `value`
-- here (or re-run a bucket's seed insert) and re-generate the report to see
-- every dependent KPI, the staffing model and the financials move.
CREATE TABLE IF NOT EXISTS operand_values (
  id              SERIAL PRIMARY KEY,
  community_id    INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  operand_key     TEXT NOT NULL REFERENCES operand_registry(operand_key),
  value           NUMERIC,
  text_value      TEXT,
  source_bucket   TEXT,          -- which uploaded report/screen this came from
  file_name       TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, operand_key)
);

-- Mock CMS Care Compare fetch for the 26 CMS Five-Star measures. In
-- production these are pulled live from CMS; here they're editable rows so
-- the demo can show a rating change without a live API call.
CREATE TABLE IF NOT EXISTS cms_fivestar_values (
  id              SERIAL PRIMARY KEY,
  community_id    INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  kpi_code        TEXT NOT NULL REFERENCES kpi_catalog(code),
  value_text      TEXT,
  status          TEXT,          -- 'pass' | 'watch' | 'below'
  note            TEXT,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (community_id, kpi_code)
);

-- A snapshot of every report generated, so there's a real audit trail of
-- "what did the report say, and when" as the operator edits values over time.
CREATE TABLE IF NOT EXISTS report_runs (
  id              SERIAL PRIMARY KEY,
  community_id    INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary         JSONB NOT NULL,   -- {computed, missing, manual, cms, pass, watch, below}
  results         JSONB NOT NULL,   -- full per-code results blob
  staffing        JSONB,            -- staffing model snapshot
  financials      JSONB             -- financial model snapshot
);
CREATE INDEX IF NOT EXISTS idx_report_runs_community ON report_runs(community_id, generated_at DESC);
