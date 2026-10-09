/*
 * Advantedge Operations — compute engine (Node port).
 * These functions are ported verbatim (logic-for-logic) from the client-side
 * functions in "Advantedge Operations v3.0.41_1.html": sbcCompute, computeKpi,
 * scoreKpi, kpiEvalFormula, kpiRequiredInputs. Kept identical so a report
 * generated here matches what the browser tool would compute from the same
 * inputs. CMS-sourced KPIs (source === "cms") are resolved from a supplied
 * mock Care Compare fetch rather than left "pending".
 */
"use strict";
const KPI_CATALOG = require("./kpi-catalog.json");
const OPERAND_REGISTRY = require("./operand-registry.json");

const KPI_BY_CODE = {};
KPI_CATALOG.forEach((e) => { KPI_BY_CODE[e.code] = e; });

function kpiRequiredInputs(entry) {
  return (entry.inputs || []).filter((i) => i.unit !== "text");
}

function kpiEvalFormula(formula, vals) {
  const keys = Object.keys(vals);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(keys.join(","), "return (" + formula + ");");
    const r = fn.apply(null, keys.map((k) => vals[k]));
    if (typeof r === "number" && isFinite(r)) return { value: r, reason: null };
    if (typeof r === "number" && !isFinite(r)) return { value: null, reason: "division-by-zero" };
    return { value: null, reason: "non-numeric-result" };
  } catch (e) {
    return { value: null, reason: "formula-exception" };
  }
}

function scoreKpi(entry, value) {
  const t = entry.benchmark && entry.benchmark.threshold;
  if (!t || !t.scored || value == null || typeof value === "object") return null;
  const tol = 0.05, tg = t.target, d = t.direction;
  const band = (pass, watch) => (pass ? "pass" : watch ? "watch" : "below");
  if (d === "higher") return band(value >= tg, value >= tg * (1 - tol));
  if (d === "lower") return band(value <= tg, value <= tg * (1 + tol));
  if (d === "zero") return band(value <= (tg || 0), value <= (tg || 0));
  if (d === "band") return band(value >= t.lo && value <= t.hi, value >= t.lo * (1 - tol) && value <= t.hi * (1 + tol));
  if (d === "bandabs") return band(Math.abs(value) <= tg, Math.abs(value) <= tg * (1 + tol));
  return null;
}

// Core compute logic against a single flat operand store (one value per
// key — the blended, campus-wide figure). Factored out of computeKpi so
// computeKpiForLevel (below) can run the EXACT same logic against a
// per-care-level store without duplicating it — computeKpi's own behavior
// for every existing (non-care-level) KPI is unchanged byte-for-byte from
// before this refactor.
function computeFromStore(entry, store) {
  const req = kpiRequiredInputs(entry);
  const missing = [];
  const vals = {};
  req.forEach((i) => {
    const rec = store[i.key];
    const v = rec ? rec.value : undefined;
    const num = typeof v === "number" ? v : v == null || v === "" ? NaN : parseFloat(v);
    if (isNaN(num)) missing.push(i.key);
    else vals[i.key] = num;
  });
  if (missing.length) {
    const allManual = missing.every((k) => (OPERAND_REGISTRY[k] || {}).intake === "manual");
    return { code: entry.code, status: allManual ? "manual-pending" : "missing-inputs", value: null, missing };
  }
  const tg = entry.benchmark && entry.benchmark.threshold ? entry.benchmark.threshold.target : null;
  const f = entry.formula;
  if (f === "direct") {
    const nums = req.map((i) => i.key);
    const value = nums.length === 1 ? vals[nums[0]] : nums.reduce((o, k) => ((o[k] = vals[k]), o), {});
    return { code: entry.code, status: "computed", value, unit: entry.unit, scoreBand: scoreKpi(entry, value), target: tg, formula: f, vals };
  }
  if (f === "distribution") return { code: entry.code, status: "computed", value: "(breakdown)", unit: entry.unit, scoreBand: null, target: tg, formula: f, vals };
  const { value: v, reason } = kpiEvalFormula(f, vals);
  if (v === null) return { code: entry.code, status: "compute-error", value: null, formula: f, vals, errorReason: reason };
  const val = Math.round(v * 100) / 100;
  return { code: entry.code, status: "computed", value: val, unit: entry.unit, scoreBand: scoreKpi(entry, val), target: tg, formula: f, vals };
}

function computeKpi(entry, store, cmsStore) {
  if (entry.source === "cms") {
    const c = (cmsStore || {})[entry.code];
    if (!c) return { code: entry.code, status: "cms-pending", value: null };
    return { code: entry.code, status: "computed", value: c.value, unit: entry.unit, scoreBand: c.status, target: null, cmsNote: c.note };
  }
  return computeFromStore(entry, store);
}

// For a KPI flagged with `careLevels` (e.g. ["IL","AL","MC","SNF"]), compute
// the SAME formula once per level, reading that level's own operand values
// from storeByLevel[level] instead of the blended store — reusing
// computeFromStore (and therefore kpiEvalFormula/scoreKpi) unchanged, so a
// level's result is scored exactly the same way a blended KPI's would be.
// A per-level benchmark target (entry.benchmark.threshold.byCareLevel[level])
// overrides the blended target when present; otherwise the level result is
// still computed but left unscored (no fabricated target).
function computeKpiByCareLevel(entry, storeByLevel) {
  const byLevelTargets = (entry.benchmark && entry.benchmark.threshold && entry.benchmark.threshold.byCareLevel) || {};
  const byCareLevel = entry.careLevels.map((level) => {
    const levelStore = storeByLevel[level] || {};
    const r = computeFromStore(entry, levelStore);
    if (r.status === "computed" && byLevelTargets[level] != null) {
      r.target = byLevelTargets[level];
      r.scoreBand = scoreKpi(entry, r.value); // re-score against the level-specific target, not the blended one
    } else if (r.status === "computed") {
      r.target = null;
      r.scoreBand = null; // no level-specific benchmark on file — show the number, don't invent a target
    }
    return { level, ...r };
  });
  const anyComputed = byCareLevel.some((r) => r.status === "computed");
  const allMissing = byCareLevel.every((r) => r.status === "missing-inputs");
  return {
    code: entry.code,
    status: allMissing ? "missing-inputs" : anyComputed ? "computed" : byCareLevel[0].status,
    value: null, // no single blended value for a level-specific KPI — see byCareLevel instead
    byCareLevel,
  };
}

function computeAllKPIs(operandStore, cmsStore, storeByLevel) {
  const results = {};
  const sum = { computed: 0, missing: 0, manual: 0, cms: 0, error: 0, pass: 0, watch: 0, below: 0 };
  KPI_CATALOG.forEach((e) => {
    const r = e.careLevels && storeByLevel ? computeKpiByCareLevel(e, storeByLevel) : computeKpi(e, operandStore, cmsStore);
    results[e.code] = r;
    if (r.status === "computed") {
      sum.computed++;
      if (r.byCareLevel) {
        r.byCareLevel.forEach((lr) => {
          if (lr.scoreBand === "pass") sum.pass++;
          else if (lr.scoreBand === "watch") sum.watch++;
          else if (lr.scoreBand === "below") sum.below++;
        });
      } else {
        if (r.scoreBand === "pass") sum.pass++;
        else if (r.scoreBand === "watch") sum.watch++;
        else if (r.scoreBand === "below") sum.below++;
      }
    } else if (r.status === "missing-inputs") sum.missing++;
    else if (r.status === "manual-pending") sum.manual++;
    else if (r.status === "cms-pending") sum.cms++;
    else sum.error++;
  });
  const meas = (c) => results[c] && results[c].status === "computed";
  const redFlags = { resident: !(meas("OPS-03") || meas("OPS-05")), employee: !meas("HR-09") };
  return { at: new Date().toISOString(), summary: sum, results, redFlags };
}

// ---- Staffing Base Calculator (SBC) — ported from sbcCompute -------------
function sbcCompute(I) {
  const n = (x) => { x = +x; return isFinite(x) ? x : 0; };
  const ilCap = n(I.ilCap), alCap = n(I.alCap), mcCap = n(I.mcCap), snfCap = n(I.snfCap);
  const ilOcc = n(I.ilOcc), alOcc = n(I.alOcc), mcOcc = n(I.mcOcc);
  const snfRehab = n(I.snfRehab), snfLtc = n(I.snfLtc), snfCensus = snfRehab + snfLtc;
  const ilSqft = n(I.ilSqft), alSqft = n(I.alSqft), mcSqft = n(I.mcSqft), snfSqft = n(I.snfSqft);
  const ccrc = I.ccrc === "Yes", nonprofit = I.tax === "Nonprofit", system = I.ownership === "System";
  const single = I.config !== "Multi-building", optSec = I.optSecurity === "Yes";
  const totalUnits = ilCap + alCap + mcCap + snfCap;
  const totalCensus = ilOcc + alOcc + mcOcc + snfCensus;
  const hasResi = ilOcc > 0 || alOcc > 0 || mcOcc > 0;
  const SEC_FTE = ((10687.5 / 365) * 7) / 40;

  const P = {};
  const z = () => ({ IL: 0, AL: 0, MC: 0, SNF: 0, Campus: 0 });
  const set = (name, o) => { P[name] = Object.assign(z(), o); };

  set("Executive Director", { Campus: hasResi ? 1 : 0 });
  set("SNF Administrator (NHA)", { SNF: snfCap > 0 ? (ccrc && hasResi && snfCap < 60 && single ? 0 : 1) : 0 });
  set("Associate ED", { Campus: totalCensus > 200 ? 1 : 0 });
  set("Finance / Billing", {
    IL: ilOcc === 0 ? 0 : ilOcc < 125 ? 1 : ilOcc * 0.005,
    AL: alOcc > 75 ? 1 : alOcc * 0.005,
    MC: mcOcc > 75 ? 1 : mcOcc * 0.005,
    SNF: snfCensus > 75 ? 1 : snfCensus * 0.025,
  });
  set("Concierge / Front Desk", {
    IL: ilOcc > 0 ? 4.2 : 0,
    AL: alOcc < 45 ? alOcc * 0.005 : 1,
    MC: mcOcc < 45 ? mcOcc * 0.005 : 1,
    SNF: snfCensus > 40 ? 2.1 : 0,
  });
  set("Sales / Marketing", {
    IL: ilCap > 0 ? (ilCap < 100 ? 1 : ilCap / 100) : 0,
    AL: alCap > 0 ? (alCap < 40 ? 1 : alCap / 40) : 0,
    MC: mcCap > 0 ? (mcCap < 30 ? 1 : mcCap / 30) : 0,
    SNF: (snfRehab > 0 ? (snfRehab < 30 ? 1 : snfRehab / 30) : 0) + (snfLtc > 0 ? (snfLtc < 30 ? 1 : snfLtc / 30) : 0),
  });
  set("Program Director", {});
  const mplh = (occ, t) => (occ <= 0 ? 0 : ((occ * 3 * 365) / t / 52) / 40);
  set("Dining", { IL: mplh(ilOcc, 2.2), AL: mplh(alOcc, 2.5), MC: mplh(mcOcc, 3.0), SNF: mplh(snfCensus, 3.5) });
  set("Plant Ops", { Campus: (ilSqft + alSqft + mcSqft + snfSqft) / 50000 });
  set("DON / Resident Care Dir.", { AL: alOcc > 0 || mcOcc > 0 ? 1 : 0, SNF: snfCensus > 0 ? 1 : 0 });
  set("Activities / Lifestyles", {
    IL: ilOcc === 0 ? 0 : ilOcc / 100,
    AL: alOcc > 0 ? (alOcc < 60 ? 1.4 : alOcc * 0.05) : 0,
    MC: mcOcc > 0 ? (mcOcc < 30 ? 1.4 : mcOcc * 0.035) : 0,
    SNF: snfCensus > 0 ? (snfCensus < 30 ? 1.4 : snfCensus * 0.035) : 0,
  });
  set("Social Services", { AL: alOcc > 0 ? alOcc / 120 : 0, MC: mcOcc > 0 ? mcOcc / 80 : 0, SNF: snfRehab / 25 + snfLtc / 50 });
  set("Housekeeping", { Campus: ilSqft / 25000 + alSqft / 20000 + mcSqft / 8000 + snfSqft / 8000 });
  set("Laundry", { Campus: (ilOcc * 6.4 + alOcc * 18.9 + mcOcc * 18.9 + snfRehab * 24.5 + snfLtc * 84) / 50 / 40 });
  set("Transport", { Campus: ilOcc > 0 ? ilOcc * 0.006 : 0 });
  set("Security", { Campus: totalUnits > 0 ? (ccrc ? SEC_FTE : ilCap > 0 && optSec ? SEC_FTE : 0) : 0 });
  set("Foundation / Giving", { Campus: ccrc && nonprofit ? 1 : 0 });

  const d14 = (p) => (p * 8 * 7) / 40;
  set("CNA / Aide", {
    AL: d14(alOcc / 12 + alOcc / 15 + (alOcc > 0 ? (alOcc / 20 < 2 ? 2 : alOcc / 20) : 0)),
    MC: d14(mcOcc / 8 + mcOcc / 8 + (mcOcc > 0 ? (mcOcc / 20 < 2 ? 2 : mcOcc / 12) : 0)),
    SNF: d14(snfCensus / 8 + snfCensus / 8 + snfCensus / 12),
  });
  const nshift = (o, r) => (o > 0 ? (o < 30 ? 1 : o / r) : 0);
  set("Nurses / Med Aides", { AL: d14(nshift(alOcc, 30) * 3), MC: d14(nshift(mcOcc, 30) * 3), SNF: d14((snfCensus > 0 ? (snfCensus < 20 ? 1 : snfCensus / 20) : 0) * 3) });
  set("Specialty / GCM", {});
  set("Shift Supervisor", { SNF: snfCensus > 0 ? 4.2 : 0 });
  set("MDS", { SNF: snfRehab > 0 ? snfLtc / 45 + snfRehab / 30 : 0 });

  const rowTot = (o) => o.IL + o.AL + o.MC + o.SNF + o.Campus;

  let empBase = 0; Object.keys(P).forEach((k) => { empBase += rowTot(P[k]); });
  const empMeals = empBase * 0.25 * 365;
  set("Employee Dining", { Campus: (empMeals / 3 / 52) / 40 });

  let hrBase = 0; Object.keys(P).forEach((k) => { hrBase += rowTot(P[k]); });
  let hr;
  if (system) hr = Math.max(0.25, (hrBase / 70) * 0.25);
  else hr = hrBase > 40 ? Math.max(0.5, hrBase / 70) : hrBase / 70;
  set("HR", { Campus: hr });

  const ORDER_POS = [
    "Executive Director", "SNF Administrator (NHA)", "Associate ED", "Finance / Billing",
    "Concierge / Front Desk", "Sales / Marketing", "Program Director", "Dining", "Plant Ops",
    "DON / Resident Care Dir.", "HR", "Activities / Lifestyles", "Social Services", "Housekeeping",
    "Laundry", "Transport", "Security", "Foundation / Giving", "Employee Dining",
    "CNA / Aide", "Nurses / Med Aides", "Specialty / GCM", "Shift Supervisor", "MDS",
  ];
  let grand = 0; ORDER_POS.forEach((k) => { grand += rowTot(P[k]); });
  return { positions: P, order: ORDER_POS, rowTot, grandTotal: grand };
}

module.exports = { KPI_CATALOG, OPERAND_REGISTRY, KPI_BY_CODE, computeKpi, computeKpiByCareLevel, computeAllKPIs, scoreKpi, kpiEvalFormula, sbcCompute };
