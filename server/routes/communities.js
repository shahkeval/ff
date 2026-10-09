const express = require("express");
const { pool } = require("../db");
const router = express.Router();

router.get("/:slug", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM communities WHERE slug = $1", [req.params.slug]);
  if (!rows.length) return res.status(404).json({ error: "Community not found" });
  res.json(rows[0]);
});

router.post("/", async (req, res) => {
  const p = req.body || {};
  if (!p.slug || !p.name) return res.status(400).json({ error: "slug and name are required" });
  const occ = p.occupancyByLevel || {};
  const { rows } = await pool.query(
    `INSERT INTO communities (slug, name, operator, address, city_state_zip, state_abbr,
       units_il, units_al, units_mc, units_snf, sqft_il, sqft_al, sqft_mc, sqft_snf, sqft_total,
       current_occupancy, occupancy_il, occupancy_al, occupancy_mc, occupancy_snf, year_opened, care_levels, structure)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name, operator = EXCLUDED.operator, address = EXCLUDED.address,
       city_state_zip = EXCLUDED.city_state_zip, state_abbr = EXCLUDED.state_abbr,
       units_il = EXCLUDED.units_il, units_al = EXCLUDED.units_al, units_mc = EXCLUDED.units_mc, units_snf = EXCLUDED.units_snf,
       sqft_il = EXCLUDED.sqft_il, sqft_al = EXCLUDED.sqft_al, sqft_mc = EXCLUDED.sqft_mc, sqft_snf = EXCLUDED.sqft_snf, sqft_total = EXCLUDED.sqft_total,
       current_occupancy = EXCLUDED.current_occupancy,
       occupancy_il = EXCLUDED.occupancy_il, occupancy_al = EXCLUDED.occupancy_al, occupancy_mc = EXCLUDED.occupancy_mc, occupancy_snf = EXCLUDED.occupancy_snf,
       year_opened = EXCLUDED.year_opened, care_levels = EXCLUDED.care_levels, structure = EXCLUDED.structure, updated_at = now()
     RETURNING *`,
    [
      p.slug, p.name, p.operator || null, p.address || null, p.cityStateZip || null, p.stateAbbr || null,
      p.units?.IL || 0, p.units?.AL || 0, p.units?.MC || 0, p.units?.SNF || 0,
      p.sqft?.IL || null, p.sqft?.AL || null, p.sqft?.MC || null, p.sqft?.SNF || null, p.sqft?.total || null,
      p.currentOccupancy || null, occ.IL || null, occ.AL || null, occ.MC || null, occ.SNF || null,
      p.yearOpened || null, p.careLevels || [], JSON.stringify(p.structure || {}),
    ]
  );
  res.json(rows[0]);
});

// Clears uploaded documents / extracted operand values / AI usage log for a
// community, leaving its profile and CMS mock data intact — a clean slate
// to run the upload demo again without stale leftovers.
router.post("/:slug/reset", async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM communities WHERE slug = $1", [req.params.slug]);
  if (!rows.length) return res.status(404).json({ error: "Community not found" });
  const id = rows[0].id;
  await pool.query("DELETE FROM ai_usage_log WHERE community_id = $1", [id]);
  await pool.query("DELETE FROM documents WHERE community_id = $1", [id]);
  await pool.query("DELETE FROM operand_values WHERE community_id = $1", [id]);
  res.json({ ok: true, reset: ["ai_usage_log", "documents", "operand_values"] });
});

module.exports = router;
