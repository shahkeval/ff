const express = require("express");
const { pool } = require("../db");
const { computeAllKPIs, sbcCompute, OPERAND_REGISTRY, KPI_BY_CODE } = require("../../engine/compute");

const router = express.Router();

async function loadCommunity(slug) {
  const { rows } = await pool.query("SELECT * FROM communities WHERE slug = $1", [slug]);
  return rows[0] || null;
}
// Returns { store, storeByLevel }: `store` is the existing blended view
// (care_level = '', exactly as before — every non-care-level KPI reads this
// and its behavior is unchanged). `storeByLevel` is new: { IL: {...}, AL:
// {...}, ... }, built from rows that DO carry a care_level, for the KPIs
// flagged with `careLevels` in the catalog.
async function loadOperandStore(communityId) {
  const { rows } = await pool.query("SELECT operand_key, value, text_value, care_level FROM operand_values WHERE community_id = $1", [communityId]);
  const store = {};
  const storeByLevel = {};
  rows.forEach((r) => {
    const reg = OPERAND_REGISTRY[r.operand_key] || {};
    const rec = { value: r.value !== null ? Number(r.value) : r.text_value, unit: reg.unit, family: reg.family };
    if (r.care_level) {
      if (!storeByLevel[r.care_level]) storeByLevel[r.care_level] = {};
      storeByLevel[r.care_level][r.operand_key] = rec;
    } else {
      store[r.operand_key] = rec;
    }
  });
  return { store, storeByLevel };
}
async function loadCmsStore(communityId) {
  const { rows } = await pool.query("SELECT kpi_code, value_text, status, note FROM cms_fivestar_values WHERE community_id = $1", [communityId]);
  const store = {};
  rows.forEach((r) => { store[r.kpi_code] = { value: r.value_text, status: r.status, note: r.note }; });
  return store;
}

router.get("/:slug/kpis", async (req, res) => {
  const community = await loadCommunity(req.params.slug);
  if (!community) return res.status(404).json({ error: "Community not found" });
  const [{ store, storeByLevel }, cmsStore] = await Promise.all([loadOperandStore(community.id), loadCmsStore(community.id)]);
  const R = computeAllKPIs(store, cmsStore, storeByLevel);
  const detailed = {};
  Object.entries(R.results).forEach(([code, r]) => {
    const meta = KPI_BY_CODE[code] || {};
    detailed[code] = { ...r, name: meta.name, section: meta.section, benchmark: meta.benchmark, inputs: meta.inputs, source: meta.source, careLevels: meta.careLevels };
  });
  res.json({ summary: R.summary, results: detailed, redFlags: R.redFlags, at: R.at });

  await pool.query(
    "INSERT INTO report_runs (community_id, summary, results) VALUES ($1,$2,$3)",
    [community.id, JSON.stringify(R.summary), JSON.stringify(R.results)]
  ).catch(() => {}); // best-effort audit trail; never block the response on it
});

router.get("/:slug/staffing", async (req, res) => {
  const community = await loadCommunity(req.params.slug);
  if (!community) return res.status(404).json({ error: "Community not found" });
  const s = community.structure || {};
  const pct = (v, fallback) => (v != null ? Number(v) / 100 : fallback);
  const ilPct = pct(community.occupancy_il, 0.9), alPct = pct(community.occupancy_al, 0.9);
  const mcPct = pct(community.occupancy_mc, 0.9), snfPct = pct(community.occupancy_snf, 0.9);
  const snfOcc = Math.round(community.units_snf * snfPct);
  const I = {
    ilCap: community.units_il, alCap: community.units_al, mcCap: community.units_mc, snfCap: community.units_snf,
    ilOcc: Math.round(community.units_il * ilPct), alOcc: Math.round(community.units_al * alPct), mcOcc: Math.round(community.units_mc * mcPct),
    snfRehab: Math.round(snfOcc * 0.32), snfLtc: snfOcc - Math.round(snfOcc * 0.32),
    ilSqft: community.sqft_il || 0, alSqft: community.sqft_al, mcSqft: community.sqft_mc, snfSqft: community.sqft_snf || 0,
    ccrc: s.ccrc, tax: s.tax, ownership: s.ownership, config: s.config, optSecurity: s.optSecurity,
  };
  const SB = sbcCompute(I);
  res.json({ inputs: I, grandTotal: SB.grandTotal, positions: SB.positions, order: SB.order });
});

module.exports = router;
