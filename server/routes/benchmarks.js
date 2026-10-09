const express = require("express");
const { pool } = require("../db");
const router = express.Router();

router.get("/", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM benchmark_sources ORDER BY source_name");
  res.json(rows);
});

router.get("/kpi-catalog", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM kpi_catalog ORDER BY section, code");
  res.json(rows);
});

router.get("/ai-usage/:slug", async (req, res) => {
  const { rows: cRows } = await pool.query("SELECT id FROM communities WHERE slug = $1", [req.params.slug]);
  if (!cRows.length) return res.status(404).json({ error: "Community not found" });
  const communityId = cRows[0].id;
  const { rows } = await pool.query(
    `SELECT operand_key, bucket, found, extracted_value, model,
            sum(total_tokens) AS total_tokens, sum(estimated_cost_usd) AS estimated_cost_usd, count(*) AS calls,
            max(created_at) AS last_used
     FROM ai_usage_log WHERE community_id = $1
     GROUP BY operand_key, bucket, found, extracted_value, model
     ORDER BY last_used DESC`,
    [communityId]
  );
  const { rows: totals } = await pool.query(
    `SELECT count(DISTINCT request_id) AS requests, sum(total_tokens) AS total_tokens, sum(estimated_cost_usd) AS estimated_cost_usd
     FROM ai_usage_log WHERE community_id = $1`,
    [communityId]
  );
  res.json({ totals: totals[0], fields: rows });
});

module.exports = router;
