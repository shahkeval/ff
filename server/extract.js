/*
 * Converts an arbitrary uploaded operating report (csv/xlsx/xls/pdf — any
 * real-world shape, not a fixed template) into the operand fields relevant
 * to that document's bucket.
 *
 * Spreadsheet-shaped files (xlsx/xls/csv) support two extraction modes,
 * selectable per request via `mode` (see extractOperands):
 *
 *  - "code-interpreter" (default): the file is uploaded to OpenAI's
 *    Responses API with the `code_interpreter` tool, and the model itself
 *    writes and runs pandas code inside a sandbox to compute every field.
 *    Simple to reason about, but the model occasionally miscounts (e.g.
 *    summing a column twice) since IT does the arithmetic.
 *  - "formula-plan" (beta): the model sees only a lightweight preview of
 *    each sheet and returns a structured PLAN per field (sheet/column/
 *    operation/filter) — never a number. Our own deterministic code then
 *    executes that plan against the full data. Splits "understand an
 *    arbitrary layout" (the model's strength) from "add up thousands of
 *    numbers correctly" (not the model's strength) — the executor can't
 *    double-count, and the plan itself is an inspectable audit trail. Also
 *    faster and cheaper (no sandbox round-trip).
 *
 * PDF/TXT reports (prose-style, values usually already stated as text) keep
 * the simpler text-extraction + chat-completion path in both modes.
 */
const path = require("path");
const XLSX = require("xlsx");
const OPERAND_REGISTRY = require("../engine/operand-registry.json");

// Foundry (both the model-deployment path and the agent path below) is
// disabled going forward — plain OpenAI only.
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// GPT-4.1-mini published pricing (per 1M tokens) — used only to estimate a
// cost figure for the usage log; adjust if OpenAI's pricing changes. The
// code-interpreter tool also meters sandbox/container time separately on
// OpenAI's side, which this estimate does not include.
const PRICE_PER_1M = { prompt: 0.4, completion: 1.6 };

function ext(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function operandKeysForBucket(bucket) {
  // A bucket maps to one or more operand "family" groups. Financial buckets
  // (gl/pl/coa/budget) all draw from the single "financial" family.
  const familyForBucket = {
    census: "census", payroll: "payroll", clinical: "clinical", dining: "dining",
    sales: "sales", plant: "plant", incident: "incident", lifeEnrichment: "life-enrichment",
    manual: "manual", gl: "financial", pl: "financial", coa: "financial", budget: "financial",
  };
  const family = familyForBucket[bucket] || bucket;
  return Object.entries(OPERAND_REGISTRY)
    .filter(([, o]) => o.family === family)
    .map(([key, o]) => ({ key, label: o.label, unit: o.unit, sourceHint: o.sourceHint, intake: o.intake }));
}

// ---- Robustly pull the final JSON object out of a model's text output ----
function extractJsonObject(text) {
  let t = (text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* fall through */ }
  }
  throw new Error("Model did not return valid JSON: " + t.slice(0, 200));
}

function fieldsFromParsed(parsed, opKeys) {
  return opKeys.map((o) => {
    const raw = parsed[o.key];
    const found = raw !== null && raw !== undefined && raw !== "";
    const value = found ? Number(raw) : null;
    const field = { key: o.key, label: o.label, unit: o.unit, found: found && isFinite(value), value: isFinite(value) ? value : null, raw };
    // Code-interpreter mode computes the number itself (unlike formula-plan's
    // plan-then-execute), so a care-level breakdown here is the model's own
    // computed per-level figures directly, under a parallel "<key>__byCareLevel"
    // key — same naming convention as formula-plan, just numbers instead of plans.
    if (OPERAND_REGISTRY[o.key] && OPERAND_REGISTRY[o.key].careLevelCapable) {
      const levelRaw = parsed[`${o.key}__byCareLevel`];
      if (levelRaw && typeof levelRaw === "object") {
        const byCareLevel = {};
        Object.entries(levelRaw).forEach(([level, v]) => {
          const n = Number(v);
          if (v !== null && v !== undefined && v !== "" && isFinite(n)) byCareLevel[level] = n;
        });
        if (Object.keys(byCareLevel).length) field.byCareLevel = byCareLevel;
      }
    }
    return field;
  });
}

function operandGlossary(opKeys) {
  return opKeys
    .map((o) => {
      let line = `${o.key} = ${o.label}${o.unit ? ` (${o.unit})` : ""}`;
      // intake === "manual" means this field is normally typed in directly by
      // staff, not found in an uploaded report — tell the model so, so it
      // doesn't strain to find or invent a plan for data that was never
      // expected to be in a document in the first place.
      if (o.intake === "manual") line += " [normally entered manually by staff — do NOT expect this in an uploaded document; leave it null unless you genuinely see it stated]";
      // sourceHint is a specific pointer (report title / column name / row
      // label) to where this field is usually found, written from prior
      // real-file testing — pass it straight through as guidance, not as a
      // guarantee every file has it this way.
      if (o.sourceHint) line += ` — Where to look: ${o.sourceHint}`;
      return line;
    })
    .join("; ");
}

// ---- Path A: spreadsheet-shaped files -> code interpreter (real compute) --
async function extractViaCodeInterpreter({ buffer, fileName, bucket, opKeys, client }) {
  const schema = opKeys.map((o) => `"${o.key}": <number, or null if not computable>`).join(", ");
  const glossary = operandGlossary(opKeys);
  const levelKeys = opKeys.filter((o) => OPERAND_REGISTRY[o.key] && OPERAND_REGISTRY[o.key].careLevelCapable).map((o) => o.key);
  const careLevelInstructions = levelKeys.length
    ? `\n\nSome fields ALSO need a breakdown by care level (IL/AL/MC/SNF, or whichever subset this file actually ` +
      `has). For each key in this list: ${levelKeys.join(", ")} — IN ADDITION to that field's normal entry in the ` +
      `JSON (still the blended, all-levels figure, exactly as every other field), ALSO compute the SAME metric ` +
      `separately for each care level present in the data, and include a second key named "<key>__byCareLevel" ` +
      `whose value is an object mapping each level to its own computed number — e.g. "residentDays__byCareLevel": ` +
      `{"IL": 41679, "AL": 16307, "SNF": 14600}. Finding the right way to split by level takes judgment — try in ` +
      `order: (1) a clean "Care Level"/"Unit"-type column whose values ARE the levels themselves — filter and ` +
      `recompute per value; (2) separate per-level columns already broken out (e.g. "IL Occupied"); (3) if the file ` +
      `instead has one row/section per BUILDING or SUB-COMMUNITY with no clean level label, group by that instead — ` +
      `read each building's name to tell its level (e.g. "...- ILF" or "... Skilled Nursing"), and if MORE THAN ONE ` +
      `building belongs to the same level, SUM across all of them for that level, not just the first one you find. ` +
      `After computing each level, verify they sum back to (or close to) the blended figure before trusting them — ` +
      `if a level's number equals the blended total, or every level has the identical number, that means your ` +
      `grouping isn't actually distinguishing levels and should not be reported. Omit the "__byCareLevel" key ` +
      `entirely for a field if the file truly gives no way to tell levels apart — never invent a breakdown.`
    : "";

  const uploaded = await client.files.create({
    file: await require("openai").toFile(buffer, fileName),
    purpose: "assistants",
  });

  const prompt =
    `You are a data analyst extracting operating metrics from a senior-living operator's ${bucket} report. ` +
    `The attached file "${fileName}" is a real operational export — it may hold hundreds or thousands of detail rows ` +
    `across several sheets (a daily log, a resident/employee roster, a transaction ledger, etc.), in whatever layout ` +
    `the operator's own system produced. It will NOT match a fixed template, and it will NOT contain a pre-computed ` +
    `summary of the values below.\n\n` +
    `Field meanings: ${glossary}\n\n` +
    `IMPORTANT — these field names are ANALYTICAL metrics, not literal column headers. The file's actual column names ` +
    `will be completely different, domain-specific labels (e.g. a raw daily census log has columns like "IL Occupied", ` +
    `"Total Occupied", "SNF Occupied" by date — there is no column literally called "residentDays"). Do NOT search for ` +
    `a column whose name matches the field key. Instead, for each field: read the sheet's actual columns, understand ` +
    `what each one represents from its header and sample values, and then derive the requested figure with the ` +
    `correct pandas operation for that meaning — e.g. a "-days in period" or "total X" metric is usually the SUM of a ` +
    `daily count/occupancy column across every row of the period; a "current"/"at period end" metric is usually the ` +
    `LAST dated row's value; an "AVERAGE X over the period" metric (read the field meaning carefully — this is ` +
    `different from a period-end snapshot) is the MEAN of a daily column across every row of the period, e.g. ` +
    `df['Total Occupied'].mean(), NOT the last row and NOT a sum; a "departed"/event count is usually the number of ` +
    `rows in a detail log matching that event; a rate's numerator/denominator are usually two separate counts from a ` +
    `detail or event log. There is no cell anywhere in the file that already states these figures directly — every ` +
    `one must be derived by actually running the matching computation over the full data, never guessed or read off ` +
    `a single row. Reason about the data's structure before picking an operation.\n\n` +
    `WHEN A FIELD IS A COUNT OF ROWS MATCHING ONE SPECIFIC CATEGORY, out of a column that holds several different ` +
    `category values (a type/status/reason/event column, etc.): first inspect every distinct value that column ` +
    `actually contains before filtering — do not assume a category's exact spelling, capitalization or wording. ` +
    `Filter on the precise value you actually found, not an approximation of it. After filtering, print both the ` +
    `resulting count and a few of the matched rows themselves, and confirm those rows genuinely belong to the ` +
    `intended category before treating the count as final. This is especially important when several of the fields ` +
    `you're asked for are really the same column filtered to different category values — it's easy to filter on the ` +
    `wrong value, or the right value with the wrong spelling, and end up confidently reporting a count that belongs ` +
    `to a different category (or no rows at all) instead of the one actually requested. Treat every such count as ` +
    `unverified until you've checked the matched rows, not just the number.\n\n` +
    `You have a Python code_interpreter tool available — you MUST actually call it and execute code; do not just ` +
    `write code as text in your reply. In a SINGLE tool call, in one pass, open every sheet with pandas, print the ` +
    `computed value for every field above, and read back the printed numbers before answering. Do not stop after ` +
    `only listing sheet names or previewing a few rows — run the full computation over the complete file.\n\n` +
    `After the code has actually run and printed the results, your FINAL message must be ONLY one JSON object (no ` +
    `prose, no markdown fences) in this exact shape: {${schema}}. Every value must be a plain number (no $, %, ` +
    `commas, or units) representing the PERIOD TOTAL. Use null only for a field the data genuinely has no basis to ` +
    `compute — never guess.${careLevelInstructions}`;

  const tools = [{ type: "code_interpreter", container: { type: "auto", file_ids: [uploaded.id] } }];
  let promptTokens = 0, completionTokens = 0;
  let response;
  try {
    response = await client.responses.create({ model: MODEL, input: prompt, tools, temperature: 0 });
    promptTokens += response.usage?.input_tokens || 0;
    completionTokens += response.usage?.output_tokens || 0;

    // The model sometimes stops after only exploring the file (e.g. just
    // listing sheet names) instead of finishing the computation in one pass.
    // The sandbox container persists across turns via previous_response_id,
    // so nudge it to actually run the numbers and answer, up to 3 tries.
    let attempts = 0;
    while (attempts < 3 && !isCompleteJson(response.output_text, opKeys)) {
      response = await client.responses.create({
        model: MODEL,
        input: "Continue: actually run the code now over the full file, read back the printed numbers, and then " +
          "give your final answer as ONLY the JSON object described earlier — no prose, no markdown fences.",
        previous_response_id: response.id,
        tools,
        temperature: 0,
      });
      promptTokens += response.usage?.input_tokens || 0;
      completionTokens += response.usage?.output_tokens || 0;
      attempts++;
    }
  } finally {
    client.files.del(uploaded.id).catch(() => {}); // best-effort cleanup, never blocks extraction
  }

  const totalTokens = promptTokens + completionTokens;
  const estimatedCostUsd = (promptTokens / 1e6) * PRICE_PER_1M.prompt + (completionTokens / 1e6) * PRICE_PER_1M.completion;

  const parsed = extractJsonObject(response.output_text);
  return { model: MODEL, promptTokens, completionTokens, totalTokens, estimatedCostUsd, fields: fieldsFromParsed(parsed, opKeys) };
}

function isCompleteJson(text, opKeys) {
  try {
    const parsed = extractJsonObject(text);
    if (!opKeys.every((o) => Object.prototype.hasOwnProperty.call(parsed, o.key))) return false;
    // Having every key present isn't enough on its own — the model sometimes
    // computes one field, then declares the rest null ("not in document")
    // without actually finishing the pandas run, which still satisfies the
    // check above. When almost everything comes back null on a field list
    // long enough that real single-purpose files wouldn't legitimately be
    // this sparse, treat it as incomplete and nudge another attempt instead
    // of accepting a likely-gave-up answer as final.
    if (opKeys.length >= 5) {
      const foundCount = opKeys.filter((o) => parsed[o.key] !== null && parsed[o.key] !== undefined).length;
      if (foundCount / opKeys.length < 0.2) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ---- Path A2: spreadsheet-shaped files -> "plan then execute" (beta) ------
// Instead of asking the model to compute final numbers itself (Path A above),
// the model only sees a lightweight PREVIEW of each sheet (headers, a few
// sample rows, and the distinct values of categorical columns) and returns,
// per field, a small structured PLAN describing which sheet/column/operation
// computes it — never a number. Our own deterministic code then executes
// that plan against the FULL sheet data. This splits "understand an
// arbitrary layout" (the model's strength) from "add up thousands of
// numbers correctly" (not the model's strength — Path A occasionally
// double-counted a column when asked to compute directly via its own
// generated code). The executor runs the same handful of operations every
// time, so the same plan always yields the same, correct number, and the
// plan itself is a transparent, inspectable audit trail.
function loadSheets(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheets = {};
  wb.SheetNames.forEach((name) => {
    sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true });
  });
  return sheets;
}

function buildSheetPreview(sheets) {
  return Object.entries(sheets).map(([name, rows]) => {
    const headers = rows[0] || [];
    const dataRows = rows.slice(1);
    const columns = headers.map((h, colIdx) => {
      const values = dataRows.map((r) => r[colIdx]).filter((v) => v !== undefined && v !== null && v !== "");
      const distinct = [...new Set(values.map((v) => String(v)))];
      const isCategorical = distinct.length > 0 && distinct.length <= 15 && values.length > distinct.length * 1.5;
      return { header: h, sampleValues: isCategorical ? distinct : undefined };
    });
    return { sheet: name, rowCount: dataRows.length, columns, sampleRows: dataRows.slice(0, 3) };
  });
}

function findColumnIndex(headers, name) {
  if (name === null || name === undefined) return -1;
  const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/^[—\-—\s]+/, "");
  const target = norm(name);
  let idx = headers.findIndex((h) => norm(h) === target);
  if (idx === -1) idx = headers.findIndex((h) => norm(h).includes(target) || target.includes(norm(h)));
  return idx;
}

function matchFilter(row, headers, filter) {
  const idx = findColumnIndex(headers, filter.column);
  if (idx === -1) return false;
  const v = row[idx];
  const sv = v === undefined || v === null ? "" : String(v).trim().toLowerCase();
  switch (filter.match) {
    case "equals": return sv === String(filter.value).trim().toLowerCase();
    case "not_equals": return sv !== String(filter.value).trim().toLowerCase();
    case "not_blank": return sv !== "";
    case "blank": return sv === "";
    case "in": return (filter.value || []).some((x) => String(x).trim().toLowerCase() === sv);
    case "not_in": return !(filter.value || []).some((x) => String(x).trim().toLowerCase() === sv);
    default: return true;
  }
}

// The only function in this file that ever adds numbers together — plain,
// deterministic JS, so the same plan always produces the same answer.
function executePlan(sheets, plan) {
  const sheetName = Object.keys(sheets).find((n) => n.trim().toLowerCase() === String(plan.sheet).trim().toLowerCase()) || plan.sheet;
  const rows = sheets[sheetName];
  if (!rows) throw new Error(`Sheet "${plan.sheet}" not found`);
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const filters = plan.filters || [];
  const matched = dataRows.filter((r) => filters.every((f) => matchFilter(r, headers, f)));

  if (plan.op === "count") return matched.length;

  if (plan.op === "count_per_group_average") {
    const groupIdx = findColumnIndex(headers, plan.groupBy);
    if (groupIdx === -1) throw new Error(`groupBy column not found: ${plan.groupBy}`);
    const counts = {};
    matched.forEach((r) => { const g = String(r[groupIdx]); counts[g] = (counts[g] || 0) + 1; });
    const groupSizes = Object.values(counts);
    return groupSizes.length ? groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length : null;
  }

  const colNames = plan.columns && plan.columns.length ? plan.columns : plan.column ? [plan.column] : [];
  if (!colNames.length) throw new Error(`op "${plan.op}" requires a column`);
  const colIdxs = colNames.map((c) => findColumnIndex(headers, c));
  if (colIdxs.some((i) => i === -1)) throw new Error(`Column(s) not found: ${colNames.join(", ")}`);

  const rowValue = (r) => colIdxs.reduce((sum, i) => sum + (typeof r[i] === "number" ? r[i] : parseFloat(r[i]) || 0), 0);

  if (plan.op === "sum") return matched.reduce((a, r) => a + rowValue(r), 0);
  if (plan.op === "average") return matched.length ? matched.reduce((a, r) => a + rowValue(r), 0) / matched.length : null;
  if (plan.op === "first") return matched.length ? rowValue(matched[0]) : null;
  if (plan.op === "last") return matched.length ? rowValue(matched[matched.length - 1]) : null;
  if (plan.op === "max") return matched.length ? Math.max(...matched.map(rowValue)) : null;
  if (plan.op === "min") return matched.length ? Math.min(...matched.map(rowValue)) : null;
  throw new Error(`Unknown op "${plan.op}"`);
}

function fieldsFromPlans(plans, opKeys, sheets) {
  return opKeys.map((o) => {
    const plan = plans[o.key];
    const base = !plan
      ? { key: o.key, label: o.label, unit: o.unit, found: false, value: null, raw: null, plan: null }
      : (() => {
          try {
            const result = executePlan(sheets, plan);
            const found = result !== null && isFinite(result);
            return { key: o.key, label: o.label, unit: o.unit, found, value: found ? result : null, raw: result, plan };
          } catch (e) {
            return { key: o.key, label: o.label, unit: o.unit, found: false, value: null, raw: null, plan, error: e.message };
          }
        })();

    // Care-level-capable fields may ALSO carry a parallel "<key>__byCareLevel"
    // plan map (same plan shape per level) — executed through the exact same
    // executePlan() as the blended plan above, never a second code path.
    const levelPlans = plans[`${o.key}__byCareLevel`];
    if (OPERAND_REGISTRY[o.key] && OPERAND_REGISTRY[o.key].careLevelCapable && levelPlans && typeof levelPlans === "object") {
      const byCareLevel = {};
      Object.entries(levelPlans).forEach(([level, levelPlan]) => {
        if (!levelPlan) return;
        try {
          const result = executePlan(sheets, levelPlan);
          if (result !== null && isFinite(result)) byCareLevel[level] = result;
        } catch (e) { /* skip this level silently — never let a bad level plan fail the whole field */ }
      });
      if (Object.keys(byCareLevel).length) base.byCareLevel = byCareLevel;
    }
    return base;
  });
}

async function extractViaPlan({ buffer, fileName, bucket, opKeys, client }) {
  const sheets = loadSheets(buffer);
  const preview = buildSheetPreview(sheets);
  const glossary = operandGlossary(opKeys);
  const fieldKeys = opKeys.map((o) => o.key);
  const levelKeys = opKeys.filter((o) => OPERAND_REGISTRY[o.key] && OPERAND_REGISTRY[o.key].careLevelCapable).map((o) => o.key);

  const careLevelInstructions = levelKeys.length
    ? `\n\nSome fields ALSO need a breakdown by care level (IL/AL/MC/SNF, or whichever subset of those this file ` +
      `actually contains). For each key in this list: ${levelKeys.join(", ")} — IN ADDITION to that field's normal ` +
      `plan (still computing the blended, all-levels figure, exactly as every other field does), ALSO include a ` +
      `second top-level key named "<key>__byCareLevel" whose value is an object mapping each care level actually ` +
      `present in the file to its OWN plan (same sheet/op/column/filters shape as a normal plan) — e.g. ` +
      `"residentDays__byCareLevel": {"IL": {...plan...}, "AL": {...plan...}}.\n\n` +
      `Finding the right column to split on takes a bit of judgment — try these in order:\n` +
      `1. A clean "Care Level"/"Unit"/"Setting"-type column whose distinct values ARE the levels themselves (e.g. ` +
      `"IL","AL","MC","SNF") — filter on it directly with match="equals".\n` +
      `2. Separate per-level columns already broken out (e.g. "IL Occupied"/"AL Occupied") — point straight at the ` +
      `right column, no filter needed.\n` +
      `3. If neither exists, but the file instead has one row/section per BUILDING or SUB-COMMUNITY (a "Building"/` +
      `"Section"/"Property"/"_context"-type column, or separate sheets per building) — use THAT column/sheet to ` +
      `identify care level instead, by reading each building's name (a building named like "...- ILF", "...- ALF", ` +
      `"... Skilled Nursing", etc. tells you its level even though the column isn't literally called "Care Level"). ` +
      `A single care level can legitimately span MORE THAN ONE building/value (e.g. two separate IL buildings) — ` +
      `in that case use op "in" with an ARRAY of all matching values for that level, e.g. {"column":"Building",` +
      `"match":"in","value":["Harbor Pointe Cottage Homes - ILF","The Village of East Harbor - ILF"]}, so that ` +
      `level's plan sums across every building belonging to it, not just the first one you find.\n` +
      `4. If a sheet mixes multiple care levels under confusing values (e.g. a care-level column that's just the ` +
      `same generic code for everyone, or billing/HIPPS-style codes instead of a level name), prefer approach 3 ` +
      `(group by building/section) over trying to force a reading of that confusing column.\n\n` +
      `Omit the "__byCareLevel" key entirely for a field if the file truly has no way to tell levels apart — never ` +
      `invent a breakdown, and never return the SAME value for every level (that means your filter isn't actually ` +
      `distinguishing them — go back and find a column/grouping that does).`
    : "";

  const prompt =
    `You are mapping a senior-living operator's ${fileName} (${bucket} report) onto a fixed set of analytical fields. ` +
    `The file's layout is whatever the operator's own system produced — it will not match any fixed template, and it ` +
    `will NOT contain a pre-computed summary of the values below.\n\n` +
    `Field meanings: ${glossary}\n\n` +
    `You are shown below a PREVIEW of every sheet: its column headers, the first 3 rows, and — for any column that ` +
    `looks categorical (a status/type/flag column) — every distinct value it actually contains. You are NOT shown the ` +
    `full data (it may have hundreds or thousands of rows) and you must NOT compute or guess any final number ` +
    `yourself.\n\n` +
    `SHEET PREVIEW:\n${JSON.stringify(preview, null, 1)}\n\n` +
    `If this workbook contains MULTIPLE sheets that each cover a sub-section of the same community (e.g. one sheet ` +
    `per building/wing/department, each with its own subtotal), AND one or more separate sheets that already combine ` +
    `everything (commonly named something like "Grand Total", "Combined", "All Buildings", "Summary — All", etc.) — ` +
    `use the COMBINED sheet for any field that should represent the WHOLE community/period, not one sub-section's ` +
    `sheet. Check every sheet name before picking one; a sub-section sheet appearing earlier in the list is not ` +
    `necessarily the right source just because it's first — the combined total, when the file has one, is usually ` +
    `further down and is the correct source for a period-wide figure.\n\n` +
    `Your job: for each field key below, output a PLAN describing exactly how to compute it from the real column ` +
    `names shown above — our own code will then execute that plan against the complete data. A plan has this shape:\n` +
    `{"sheet": "<exact sheet name from the preview>", "op": "sum"|"count"|"average"|"last"|"first"|"max"|"min"|` +
    `"count_per_group_average", ` +
    `"column": "<exact column header>" (omit or null for op="count" with no value column), ` +
    `"columns": ["<header1>","<header2>"] (use instead of "column" when the field is the row-wise SUM of two or ` +
    `more columns, e.g. regular+overtime hours), ` +
    `"groupBy": "<exact column header>" (op="count_per_group_average" only — see below), ` +
    `"filters": [{"column":"<exact header>","match":"equals"|"not_equals"|"not_blank"|"blank"|"in"|"not_in",` +
    `"value":"<exact value from the distinct-values list, or an array for in/not_in>"}] (empty array if no filter)}.\n\n` +
    `Guidance on picking the right op: a "-days"/"total X" period metric is usually op="sum" over a daily column; a ` +
    `"current"/"at period end" metric is op="last"; an "AVERAGE X over the period" metric is op="average" over the ` +
    `daily column (NOT "last" and NOT "sum" — read field meanings carefully, average and period-end are different ` +
    `metrics); a count of residents/events/rows matching something is op="count" with the matching filters; a sum of ` +
    `two related columns per row (e.g. total hours = regular + overtime) uses "columns", not "column"; an "AVERAGE ` +
    `HEADCOUNT"-style metric, where the sheet has one row per person per period (e.g. one row per employee per pay ` +
    `period) and you need the average number of people PER period, is op="count_per_group_average" with groupBy set ` +
    `to the period column (e.g. "Pay Period") — this counts rows in each period then averages those counts, which ` +
    `plain "average" or "count" cannot express. Use the EXACT sheet name, column header and filter value text shown ` +
    `in the preview — do not paraphrase them.\n\n` +
    `Return ONLY one JSON object, no prose, no markdown fences, with exactly these keys: ${fieldKeys.join(", ")}. ` +
    `Each value is a plan object as above, or null if this file gives no basis to compute that field — never invent ` +
    `a plan for data that isn't there.${careLevelInstructions}`;

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const usage = completion.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || promptTokens + completionTokens;
  const estimatedCostUsd = (promptTokens / 1e6) * PRICE_PER_1M.prompt + (completionTokens / 1e6) * PRICE_PER_1M.completion;

  const plans = extractJsonObject(completion.choices[0].message.content);
  return { model: MODEL, promptTokens, completionTokens, totalTokens, estimatedCostUsd, fields: fieldsFromPlans(plans, opKeys, sheets) };
}

// ---- Path B: prose reports (PDF/TXT) -> plain text + chat completion ------
async function fileToText(buffer, fileName) {
  const e = ext(fileName);
  if (e === "csv" || e === "txt") return buffer.toString("utf8");
  if (e === "xlsx" || e === "xls") {
    const wb = XLSX.read(buffer, { type: "buffer" });
    return wb.SheetNames.map((name) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      return `--- Sheet: ${name} ---\n${csv}`;
    }).join("\n\n");
  }
  if (e === "pdf") {
    // pdf-parse v2 replaced the old `pdfParse(buffer)` function API with a
    // `PDFParse` class (new PDFParse({data}).getText()) — the old call style
    // broke silently as "pdfParse is not a function" after the dependency
    // bump.
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text || "";
    } finally {
      await parser.destroy();
    }
  }
  throw new Error(`Unsupported file type for extraction: .${e}`);
}

// Rough heuristic (~4 chars/token for English prose) — no tokenizer
// dependency pulled in just for an estimate. Always rounds UP, so the
// estimate errs toward "this looks bigger than it is" rather than risking
// an underestimate that lets something past the real limit.
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

// Conservative default per-call budget, leaving headroom below it for the
// prompt's own instructions/glossary/accumulator text and the model's
// completion. Override via OPENAI_CHAT_TOKEN_BUDGET if a specific
// deployment's real context window is known to be larger or smaller.
const CHAT_CONTEXT_TOKEN_BUDGET = Number(process.env.OPENAI_CHAT_TOKEN_BUDGET) || 90000;
const CHAT_PROMPT_OVERHEAD_TOKENS = 1500;

// Splits a document into page-level (PDF) or paragraph-level (plain text)
// pieces — never cuts off content, just finds natural boundaries to chunk
// on later if the whole thing turns out to be too big for one call. A
// short file always comes back as a single piece.
async function fileToPages(buffer, fileName) {
  const e = ext(fileName);
  if (e === "pdf") {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const pages = (result.pages || []).map((p) => ({ label: `Page ${p.num}`, text: p.text || "" }));
      return pages.length ? pages : [{ label: "Document", text: result.text || "" }];
    } finally {
      await parser.destroy();
    }
  }
  const text = await fileToText(buffer, fileName);
  const maxChars = (CHAT_CONTEXT_TOKEN_BUDGET - CHAT_PROMPT_OVERHEAD_TOKENS) * 4;
  if (text.length <= maxChars) return [{ label: "Document", text }];
  // No page breaks in plain text — fall back to paragraph (blank-line)
  // boundaries so an arbitrarily long .txt file still splits cleanly
  // instead of ever being cut off mid-line.
  const paragraphs = text.split(/\n\s*\n/);
  const pages = [];
  let current = "";
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > maxChars) {
      pages.push({ label: `Section ${pages.length + 1}`, text: current });
      current = "";
    }
    current += (current ? "\n\n" : "") + para;
  }
  if (current) pages.push({ label: `Section ${pages.length + 1}`, text: current });
  return pages;
}

// Greedily packs page-level pieces into as few chunks as fit the token
// budget — the same greedy-packing idea this project already uses for
// multi-file batching, applied here to the pages of ONE document instead of
// multiple files. A short document always resolves to exactly one chunk;
// nothing above this function needs to know or care how many chunks a given
// file produced.
function packPagesIntoChunks(pages, maxTokens) {
  const chunks = [];
  let current = [];
  let currentTokens = 0;
  for (const page of pages) {
    const pageTokens = estimateTokens(page.text);
    if (current.length && currentTokens + pageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(page);
    currentTokens += pageTokens;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// The model must see the ENTIRE document — silently cutting a large report
// off at a fixed character count (the old behavior) can drop the exact data
// a field's answer depends on, with no sign that happened. So: estimate the
// real size, send the whole thing in one call when it fits, and when it
// doesn't, split along natural boundaries (PDF page breaks; paragraph
// breaks for plain text) into sequential chunks, each comfortably under a
// safe per-call budget. Chunks are processed in order, carrying an
// explicit, inspectable "running totals so far" JSON object forward from
// one call to the next (not relying on the model's own hidden memory of
// the conversation) — only the LAST chunk is told to produce the final
// answer; every other chunk is explicitly told more of the document is
// still coming, so it doesn't conclude a field is "missing" just because
// it hasn't reached that value yet.
async function extractViaChatCompletion({ buffer, fileName, bucket, opKeys, client }) {
  const pages = await fileToPages(buffer, fileName);
  if (!pages.some((p) => p.text.trim())) throw new Error("Could not read any text from this file (it may be a scanned/image-only PDF).");

  const schema = opKeys.map((o) => `"${o.key}": <number, or null if not present>`).join(", ");
  const glossary = operandGlossary(opKeys);
  const budget = CHAT_CONTEXT_TOKEN_BUDGET - CHAT_PROMPT_OVERHEAD_TOKENS;
  const chunks = packPagesIntoChunks(pages, budget);

  let promptTokens = 0, completionTokens = 0;
  let runningTotals = null; // the model's own last-returned JSON, carried forward verbatim
  let lastContent = null;
  const chunkLog = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isOnly = chunks.length === 1;
    const isFinal = i === chunks.length - 1;
    const chunkText = chunk.map((p) => `--- ${p.label} ---\n${p.text}`).join("\n\n");
    const chunkLabel = chunk.length > 1 ? `${chunk[0].label} – ${chunk[chunk.length - 1].label}` : chunk[0].label;

    const statusNote = isOnly
      ? "This message contains the ENTIRE document — nothing has been cut or left out."
      : isFinal
      ? `This is the FINAL part (${i + 1} of ${chunks.length}) of ONE document split only because it was too long ` +
        `for a single message. You were shown the earlier parts already, and your running totals from them are ` +
        `included below. Combine everything across ALL parts now and return your complete, final answer.`
      : `This is part ${i + 1} of ${chunks.length} of ONE document, split only because it's too long for a single ` +
        `message — NOT because anything after this point is absent. Do not conclude a field is missing just because ` +
        `you haven't reached its value yet; more parts follow. Update the running totals below with whatever this ` +
        `part adds, and return that updated JSON — not a final answer.`;

    const runningNote = runningTotals
      ? `\n\nYOUR RUNNING TOTALS FROM EARLIER PARTS (update this with what THIS part adds — prefer an explicit ` +
        `"Grand Total"/campus-wide figure over re-deriving one from sub-totals, if the document states one ` +
        `directly):\n${runningTotals}`
      : "";

    const prompt =
      `You are extracting operating data from a senior-living operator's ${bucket} report. ` +
      `The report's layout is whatever the operator's own system produced — it will not match any fixed template; ` +
      `find the values by meaning, not by column position. ${statusNote}${runningNote}\n\n` +
      `Return ONLY a single JSON object, no prose, no markdown fences: {${schema}}. ` +
      `Report each value as a plain number (no $, %, commas, or units) for the PERIOD TOTAL shown in the document. ` +
      `Use null only for a field truly absent from the document — never guess, and on a non-final part never mark ` +
      `a field null just because this part alone doesn't happen to mention it.\n` +
      `Field meanings: ${glossary}.\n\n` +
      `DOCUMENT TEXT (${chunkLabel}):\n${chunkText}`;

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 1,
      response_format: { type: "json_object" },
    });

    const usage = completion.usage || {};
    promptTokens += usage.prompt_tokens || 0;
    completionTokens += usage.completion_tokens || 0;
    lastContent = completion.choices[0].message.content;
    runningTotals = lastContent;
    chunkLog.push({ chunkIndex: i, pages: chunk.map((p) => p.label), estimatedTokens: chunk.reduce((a, p) => a + estimateTokens(p.text), 0) });
  }

  const totalTokens = promptTokens + completionTokens;
  const estimatedCostUsd = (promptTokens / 1e6) * PRICE_PER_1M.prompt + (completionTokens / 1e6) * PRICE_PER_1M.completion;
  const parsed = extractJsonObject(lastContent);
  return {
    model: MODEL, promptTokens, completionTokens, totalTokens, estimatedCostUsd,
    fields: fieldsFromParsed(parsed, opKeys),
    chunks: chunkLog,
  };
}

// `mode`: "code-interpreter" (default — the model computes final numbers
// itself inside a Python sandbox) or "formula-plan" (beta — the model only
// returns a sheet/column/operation plan; our own code executes it). Both
// only apply to spreadsheet-shaped files; PDF/TXT always use the text path.
// occupiedUnits is DEFINED as the average daily census over the period —
// mathematically that's just residentDays (the sum of daily census) divided
// by the number of days in the period. Asking the model to separately find
// and average a daily occupancy column is a second, fragile extraction for
// a number we can already derive exactly from a field we extract reliably —
// so instead of trusting the model's own occupiedUnits plan, we OVERWRITE
// it with this derivation whenever residentDays was found, blended AND per
// care level alike. This runs for every mode, not just formula-plan — the
// math holds regardless of how residentDays was obtained.
// PERIOD_DAYS assumes a full calendar year, matching every file tested so
// far (all annual census reports) — a partial-period file would need this
// adjusted, which nothing here currently detects automatically.
const PERIOD_DAYS = 365;
function deriveOccupiedUnitsFromResidentDays(fields) {
  const residentDays = fields.find((f) => f.key === "residentDays");
  const occupiedUnits = fields.find((f) => f.key === "occupiedUnits");
  if (!residentDays || !occupiedUnits) return;
  if (residentDays.found && typeof residentDays.value === "number") {
    occupiedUnits.found = true;
    occupiedUnits.value = Math.round((residentDays.value / PERIOD_DAYS) * 100) / 100;
    occupiedUnits.raw = occupiedUnits.value;
    occupiedUnits.derivedFrom = "residentDays / 365";
  }
  if (residentDays.byCareLevel) {
    const byLevel = {};
    Object.entries(residentDays.byCareLevel).forEach(([level, days]) => {
      byLevel[level] = Math.round((days / PERIOD_DAYS) * 100) / 100;
    });
    occupiedUnits.byCareLevel = byLevel;
  }
}

async function extractOperands({ buffer, fileName, bucket, mode }) {
  const opKeys = operandKeysForBucket(bucket);
  if (!opKeys.length) throw new Error(`No operand fields registered for bucket "${bucket}"`);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is not configured on the server — extraction is unavailable until it's set.");
    err.code = "NO_API_KEY";
    throw err;
  }

  const OpenAI = require("openai");
  const client = new OpenAI({ apiKey });

  const e = ext(fileName);
  let result;
  if (e === "xlsx" || e === "xls" || e === "csv") {
    result = mode === "formula-plan"
      ? { ...(await extractViaPlan({ buffer, fileName, bucket, opKeys, client })), mode: "formula-plan" }
      : { ...(await extractViaCodeInterpreter({ buffer, fileName, bucket, opKeys, client })), mode: "code-interpreter" };
  } else {
    result = { ...(await extractViaChatCompletion({ buffer, fileName, bucket, opKeys, client })), mode: "text" };
  }
  if (bucket === "census") deriveOccupiedUnitsFromResidentDays(result.fields);
  return result;
}

// ===========================================================================
// Path C: Microsoft Foundry agent — DISABLED, not used going forward.
// Left commented out (not deleted) only as a historical reference; nothing
// in this file calls any of it. See server/foundry_agent_call.py (also
// unused) for the Python-side counterpart.
// ===========================================================================
/*
// Tune to the agent's real limit (message size / attached-file size cap).
// Conservative default — adjust once the actual Foundry limit is known.
const FOUNDRY_MAX_BATCH_BYTES = 18 * 1024 * 1024;

function packFilesIntoBatches(files, maxBytes) {
  const batches = [];
  let current = [];
  let currentSize = 0;
  for (const f of files) {
    const size = f.buffer.length;
    if (current.length && currentSize + size > maxBytes) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(f);
    currentSize += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function buildFoundryBatchPrompt({ bucket, opKeys, batchIndex, totalBatches, fileNamesInBatch }) {
  const isOnly = totalBatches === 1;
  const isFinal = batchIndex === totalBatches - 1;
  const fieldKeys = opKeys.map((o) => o.key);
  const glossary = operandGlossary(opKeys);
  const batchStatus = isOnly
    ? "This is the ONLY batch for this section — all of its files are attached to this message."
    : isFinal
    ? `This is the FINAL batch (${batchIndex + 1} of ${totalBatches}) for this section. Earlier batches' files for this ` +
      `same section were already sent to you in this conversation. Consolidate everything and return your complete, ` +
      `final answer now.`
    : `This is batch ${batchIndex + 1} of ${totalBatches} for this section — more batches with more files for this ` +
      `same section will follow in this conversation. Respond with your current best-known findings, not a final answer.`;

  return (
    `Section: ${bucket}. Files in this message: ${fileNamesInBatch.join(", ")}.\n\n` +
    `Requested fields: ${glossary}\n\n` +
    `${batchStatus}\n\n` +
    `Return ONLY one JSON object with exactly these keys: ${fieldKeys.join(", ")}. Each value is a plain number or ` +
    `null. Follow the batching, combination and reliability rules from your configured instructions.`
  );
}

const FOUNDRY_CONFIG = {
  endpoint: process.env.FOUNDRY_ENDPOINT || "https://dfm-foundry.services.ai.azure.com/api/projects/dfm-foundry",
  agentName: process.env.FOUNDRY_AGENT_NAME || "excel-reader",
  agentVersion: process.env.FOUNDRY_AGENT_VERSION || "3",
  pythonBin: process.env.FOUNDRY_PYTHON_BIN || "python",
  apiKey: process.env.FOUNDRY_API_KEY || null,
};

async function callFoundryAgent({ threadId, prompt, files }) {
  const os = require("os");
  const fsSync = require("fs");
  const { spawn } = require("child_process");

  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "foundry-batch-"));
  const filePaths = files.map((f, i) => {
    const safeName = f.fileName.replace(/[\\/]/g, "_");
    const p = path.join(tmpDir, `${i}-${safeName}`);
    fsSync.writeFileSync(p, f.buffer);
    return p;
  });

  const payload = {
    endpoint: FOUNDRY_CONFIG.endpoint,
    agentName: FOUNDRY_CONFIG.agentName,
    agentVersion: FOUNDRY_CONFIG.agentVersion,
    prompt,
    filePaths,
    previousResponseId: threadId || undefined,
    apiKey: FOUNDRY_CONFIG.apiKey || undefined,
  };

  try {
    const scriptPath = path.join(__dirname, "foundry_agent_call.py");
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(FOUNDRY_CONFIG.pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (out.trim()) resolve(out);
        else reject(new Error(`Foundry agent subprocess exited (code ${code}) with no output. stderr: ${err.slice(0, 2000)}`));
      });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });

    const parsed = JSON.parse(stdout.trim().split("\n").pop());
    if (parsed.error) throw new Error(`Foundry agent call failed: ${parsed.error}`);
    return { threadId: parsed.responseId, text: parsed.text };
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractViaFoundryAgent({ files, bucket }) {
  const opKeys = operandKeysForBucket(bucket);
  if (!opKeys.length) throw new Error(`No operand fields registered for bucket "${bucket}"`);
  if (!files.length) throw new Error("No files provided for Foundry agent extraction");

  const batches = packFilesIntoBatches(files, FOUNDRY_MAX_BATCH_BYTES);
  let threadId = null;
  let lastText = null;
  const batchLog = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const prompt = buildFoundryBatchPrompt({
      bucket, opKeys, batchIndex: i, totalBatches: batches.length,
      fileNamesInBatch: batch.map((f) => f.fileName),
    });
    const result = await callFoundryAgent({ threadId, prompt, files: batch });
    threadId = result.threadId;
    lastText = result.text;
    batchLog.push({ batchIndex: i, files: batch.map((f) => f.fileName), bytes: batch.reduce((a, f) => a + f.buffer.length, 0) });
  }

  const parsed = extractJsonObject(lastText);
  return {
    model: "foundry-agent",
    promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
    fields: fieldsFromParsed(parsed, opKeys),
    mode: "foundry-agent",
    batches: batchLog,
  };
}
*/

module.exports = {
  extractOperands, operandKeysForBucket, fileToText, MODEL, executePlan, loadSheets,
  fileToPages, packPagesIntoChunks, estimateTokens,
};
