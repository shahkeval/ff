const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { pool } = require("../db");
const { extractOperands, operandKeysForBucket } = require("../extract");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 75 * 1024 * 1024 } });
const uploadMany = multer({ storage: multer.memoryStorage(), limits: { fileSize: 75 * 1024 * 1024, files: 10 } });
const router = express.Router();

async function getCommunityId(slug) {
  const { rows } = await pool.query("SELECT id FROM communities WHERE slug = $1", [slug]);
  if (!rows.length) return null;
  return rows[0].id;
}

// POST /api/communities/:slug/documents/:bucket  (multipart; accepts one or
// more files under any field name — "file" for the original single-file
// callers, "files" for the newer multi-file-per-section UI). Each file is
// run through extraction independently with the SAME mode, in order; results
// are merged field-by-field (a later file's found value overwrites an
// earlier one, same as re-uploading a corrected single file always did —
// only applies when the later file actually found that field, so a file
// that doesn't cover a given field never blanks out an earlier finding).
router.post("/:slug/documents/:bucket", upload.any(), async (req, res) => {
  const { slug, bucket } = req.params;
  const communityId = await getCommunityId(slug);
  if (!communityId) return res.status(404).json({ error: "Community not found" });
  if (!req.files || !req.files.length) return res.status(400).json({ error: "No file uploaded (expected multipart field \"file\" or \"files\")" });

  const docIds = [];
  for (const f of req.files) {
    const { rows } = await pool.query(
      `INSERT INTO documents (community_id, bucket, file_name, mime_type, byte_size, status)
       VALUES ($1,$2,$3,$4,$5,'extracting') RETURNING id`,
      [communityId, bucket, f.originalname, f.mimetype, f.size]
    );
    docIds.push(rows[0].id);
  }
  const documentId = docIds[0];
  const requestId = crypto.randomUUID();
  const combinedFileName = req.files.map((f) => f.originalname).join(", ");

  // Optional toggle: "formula-plan" (beta) makes the AI return a computation
  // plan that our own code executes, instead of computing the number itself.
  // Defaults to the existing "code-interpreter" behavior when omitted.
  const mode = req.body.mode === "formula-plan" ? "formula-plan" : "code-interpreter";

  try {
    let model = null, promptTokens = 0, completionTokens = 0, totalTokens = 0, estimatedCostUsd = 0;
    const merged = new Map(); // key -> field object, last found value wins

    for (const f of req.files) {
      const result = await extractOperands({ buffer: f.buffer, fileName: f.originalname, bucket, mode });
      model = result.model;
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      totalTokens += result.totalTokens;
      estimatedCostUsd += result.estimatedCostUsd;
      for (const field of result.fields) {
        const existing = merged.get(field.key);
        if (field.found || !existing) merged.set(field.key, field);
      }
    }
    const fields = [...merged.values()];

    // Upsert each found field into operand_values — same community + key
    // overwrites the prior value, so re-uploading a corrected report never
    // leaves stale data behind. care_level = '' is the blended row every
    // existing KPI reads; a field carrying a `byCareLevel` breakdown (from
    // formula-plan mode, for operands flagged careLevelCapable) ALSO gets
    // one additional row per level, same table, same upsert pattern.
    let capturedCount = 0;
    for (const f of fields) {
      if (!f.found) continue;
      capturedCount++;
      await pool.query(
        `INSERT INTO operand_values (community_id, operand_key, value, text_value, source_bucket, file_name, care_level)
         VALUES ($1,$2,$3,NULL,$4,$5,'')
         ON CONFLICT (community_id, operand_key, care_level) DO UPDATE SET
           value = EXCLUDED.value, text_value = NULL, source_bucket = EXCLUDED.source_bucket,
           file_name = EXCLUDED.file_name, recorded_at = now()`,
        [communityId, f.key, f.value, bucket, combinedFileName]
      );
      // Whenever this field is found at all, THIS run is authoritative for
      // its level breakdown too — drop any previously-stored levels first,
      // even if this run's result carries no byCareLevel (e.g. a re-upload
      // via a mode/file that doesn't produce one), so an old breakdown from
      // an earlier, different extraction never survives as stale once a
      // newer run has superseded the blended value.
      await pool.query(`DELETE FROM operand_values WHERE community_id = $1 AND operand_key = $2 AND care_level <> ''`, [communityId, f.key]);
      if (f.byCareLevel) {
        for (const [level, levelValue] of Object.entries(f.byCareLevel)) {
          await pool.query(
            `INSERT INTO operand_values (community_id, operand_key, value, text_value, source_bucket, file_name, care_level)
             VALUES ($1,$2,$3,NULL,$4,$5,$6)
             ON CONFLICT (community_id, operand_key, care_level) DO UPDATE SET
               value = EXCLUDED.value, text_value = NULL, source_bucket = EXCLUDED.source_bucket,
               file_name = EXCLUDED.file_name, recorded_at = now()`,
            [communityId, f.key, levelValue, bucket, combinedFileName, level]
          );
        }
      }
    }

    // Any field this bucket asks for that this run did NOT find gets its
    // stored value cleared, not left alone — otherwise a field missed on a
    // re-run (e.g. the model gave up partway through) would keep silently
    // showing a number left over from an earlier, unrelated upload, which
    // makes a run look more accurate than it actually was. This only clears
    // keys that belong to THIS bucket, so a multi-file run where one file
    // covers some fields and another file covers the rest still works —
    // only fields genuinely absent from every file in this run are cleared.
    const bucketKeys = operandKeysForBucket(bucket).map((o) => o.key);
    const foundKeys = new Set(fields.filter((f) => f.found).map((f) => f.key));
    const notFoundKeys = bucketKeys.filter((k) => !foundKeys.has(k));
    if (notFoundKeys.length) {
      await pool.query(`DELETE FROM operand_values WHERE community_id = $1 AND operand_key = ANY($2)`, [communityId, notFoundKeys]);
    }

    // Field-wise AI usage log — one row per field the model was asked for,
    // whether or not it found a value, all sharing this call's token/cost.
    const perFieldCost = fields.length ? estimatedCostUsd / fields.length : 0;
    for (const f of fields) {
      await pool.query(
        `INSERT INTO ai_usage_log (request_id, community_id, document_id, bucket, operand_key, found, extracted_value,
           model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [requestId, communityId, documentId, bucket, f.key, f.found, f.raw != null ? String(f.raw) : null,
         model, promptTokens, completionTokens, totalTokens, perFieldCost]
      );
    }

    await pool.query("UPDATE documents SET status = 'extracted' WHERE id = ANY($1)", [docIds]);
    res.json({
      documentId, requestId, model, mode,
      tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
      estimatedCostUsd,
      capturedCount, totalFields: fields.length,
      fields,
    });
  } catch (err) {
    await pool.query("UPDATE documents SET status = 'failed', error = $2 WHERE id = ANY($1)", [docIds, err.message]);
    const status = err.code === "NO_API_KEY" ? 503 : 422;
    res.status(status).json({ error: err.message, code: err.code || null, documentId });
  }
});

// Foundry agent route — DISABLED, not used going forward. Left commented
// out (not deleted) only as a historical reference.
/*
router.post("/:slug/documents/:bucket/foundry", uploadMany.array("files", 10), async (req, res) => {
  const { slug, bucket } = req.params;
  const communityId = await getCommunityId(slug);
  if (!communityId) return res.status(404).json({ error: "Community not found" });
  if (!req.files || !req.files.length) return res.status(400).json({ error: "No files uploaded (expected multipart field \"files\", one or more)" });

  const docIds = [];
  for (const f of req.files) {
    const { rows } = await pool.query(
      `INSERT INTO documents (community_id, bucket, file_name, mime_type, byte_size, status)
       VALUES ($1,$2,$3,$4,$5,'extracting') RETURNING id`,
      [communityId, bucket, f.originalname, f.mimetype, f.size]
    );
    docIds.push(rows[0].id);
  }
  const documentId = docIds[0];
  const requestId = crypto.randomUUID();
  const combinedFileName = req.files.map((f) => f.originalname).join(", ");

  try {
    const files = req.files.map((f) => ({ buffer: f.buffer, fileName: f.originalname }));
    const result = await extractViaFoundryAgent({ files, bucket });

    let capturedCount = 0;
    for (const f of result.fields) {
      if (!f.found) continue;
      capturedCount++;
      await pool.query(
        `INSERT INTO operand_values (community_id, operand_key, value, text_value, source_bucket, file_name)
         VALUES ($1,$2,$3,NULL,$4,$5)
         ON CONFLICT (community_id, operand_key) DO UPDATE SET
           value = EXCLUDED.value, text_value = NULL, source_bucket = EXCLUDED.source_bucket,
           file_name = EXCLUDED.file_name, recorded_at = now()`,
        [communityId, f.key, f.value, bucket, combinedFileName]
      );
    }

    const bucketKeys = operandKeysForBucket(bucket).map((o) => o.key);
    const foundKeys = new Set(result.fields.filter((f) => f.found).map((f) => f.key));
    const notFoundKeys = bucketKeys.filter((k) => !foundKeys.has(k));
    if (notFoundKeys.length) {
      await pool.query(`DELETE FROM operand_values WHERE community_id = $1 AND operand_key = ANY($2)`, [communityId, notFoundKeys]);
    }

    const perFieldCost = result.fields.length ? result.estimatedCostUsd / result.fields.length : 0;
    for (const f of result.fields) {
      await pool.query(
        `INSERT INTO ai_usage_log (request_id, community_id, document_id, bucket, operand_key, found, extracted_value,
           model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [requestId, communityId, documentId, bucket, f.key, f.found, f.raw != null ? String(f.raw) : null,
         result.model, result.promptTokens, result.completionTokens, result.totalTokens, perFieldCost]
      );
    }

    await pool.query("UPDATE documents SET status = 'extracted' WHERE id = ANY($1)", [docIds]);
    res.json({
      documentId, requestId, model: result.model, mode: result.mode,
      batches: result.batches,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens, total: result.totalTokens },
      estimatedCostUsd: result.estimatedCostUsd,
      capturedCount, totalFields: result.fields.length,
      fields: result.fields,
    });
  } catch (err) {
    await pool.query("UPDATE documents SET status = 'failed', error = $2 WHERE id = ANY($1)", [docIds, err.message]);
    const status = err.code === "NO_API_KEY" ? 503 : 422;
    res.status(status).json({ error: err.message, code: err.code || null, documentId });
  }
});
*/

router.get("/:slug/documents", async (req, res) => {
  const communityId = await getCommunityId(req.params.slug);
  if (!communityId) return res.status(404).json({ error: "Community not found" });
  const { rows } = await pool.query("SELECT * FROM documents WHERE community_id = $1 ORDER BY uploaded_at DESC", [communityId]);
  res.json(rows);
});

router.get("/:slug/schema/:bucket", (req, res) => {
  res.json({ bucket: req.params.bucket, fields: operandKeysForBucket(req.params.bucket) });
});

module.exports = router;
