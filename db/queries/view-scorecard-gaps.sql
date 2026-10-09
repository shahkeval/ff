-- What's below benchmark right now, for a given community, from the
-- most recent report_runs snapshot (see engine/generate-report-from-db.js).

SELECT
  rr.generated_at,
  kc.section,
  kv.key AS kpi_code,
  kc.name,
  rr.results -> kv.key ->> 'value' AS value,
  rr.results -> kv.key ->> 'scoreBand' AS band
FROM report_runs rr
CROSS JOIN LATERAL jsonb_object_keys(rr.results) AS kv(key)
JOIN kpi_catalog kc ON kc.code = kv.key
WHERE rr.community_id = (SELECT id FROM communities WHERE slug = 'cedar-bluff-commons')
  AND rr.results -> kv.key ->> 'scoreBand' = 'below'
  AND rr.id = (SELECT id FROM report_runs WHERE community_id = rr.community_id ORDER BY generated_at DESC LIMIT 1)
ORDER BY kc.section, kv.key;
