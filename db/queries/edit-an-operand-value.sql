-- Example: change one input and see the report move.
-- Every KPI, the staffing model, and the financials are all derived from
-- operand_values — there is nothing else to edit for a report re-run.

-- 1. Find the operand you want to change (e.g. anything about vacancy/agency/overtime):
SELECT operand_key, label, unit, value, text_value
FROM operand_values ov
JOIN operand_registry r USING (operand_key)
WHERE ov.community_id = (SELECT id FROM communities WHERE slug = 'cedar-bluff-commons')
  AND r.family = 'payroll'
ORDER BY operand_key;

-- 2. Change it:
UPDATE operand_values
SET value = 6
WHERE community_id = (SELECT id FROM communities WHERE slug = 'cedar-bluff-commons')
  AND operand_key = 'openPositions';

-- 3. Regenerate: from a shell, run
--    node engine/generate-report-from-db.js cedar-bluff-commons
--    (or query report_runs below to see the latest snapshot)
