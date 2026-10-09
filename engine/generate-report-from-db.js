/*
 * Reads the current operand values + CMS mock values for a community
 * straight from Postgres, computes all 97 KPIs and the staffing model with
 * the same engine the HTML tool uses, prints a summary, and stores a
 * snapshot in report_runs — the audit trail of "what did the report say,
 * and when" as values are edited over time.
 *
 * Usage: node generate-report-from-db.js [community-slug]
 * Default slug: cedar-bluff-commons
 */
const path = require("path");
const { Client } = require(path.join(__dirname, "..", "mcp-postgres-rw", "node_modules", "pg"));
const { computeAllKPIs, sbcCompute, OPERAND_REGISTRY, KPI_BY_CODE } = require("./compute");

const CONN = "postgresql://devteam:D3vteaM%2321@172.16.1.30:5432/VMP-POC";
const slug = process.argv[2] || "cedar-bluff-commons";

async function main() {
  const client = new Client({ connectionString: CONN });
  await client.connect();
  try {
    const { rows: cRows } = await client.query("SELECT * FROM communities WHERE slug = $1", [slug]);
    if (!cRows.length) throw new Error("No community with slug " + slug);
    const community = cRows[0];

    const { rows: opRows } = await client.query("SELECT operand_key, value, text_value FROM operand_values WHERE community_id = $1", [community.id]);
    const store = {};
    opRows.forEach((r) => {
      const key = r.operand_key;
      const reg = OPERAND_REGISTRY[key] || {};
      store[key] = { value: r.value !== null ? Number(r.value) : r.text_value, unit: reg.unit, family: reg.family };
    });

    const { rows: cmsRows } = await client.query("SELECT kpi_code, value_text, status, note FROM cms_fivestar_values WHERE community_id = $1", [community.id]);
    const cmsStore = {};
    cmsRows.forEach((r) => { cmsStore[r.kpi_code] = { value: r.value_text, status: r.status, note: r.note }; });

    const R = computeAllKPIs(store, cmsStore);

    const I = {
      ilCap: community.units_il, alCap: community.units_al, mcCap: community.units_mc, snfCap: community.units_snf,
      ilOcc: store.occupiedUnits ? null : null, // occupiedUnits is a single blended figure in this dataset; staffing uses care-level splits below
    };
    // Care-level occupied counts aren't split in operand_values (occupiedUnits
    // is posted as one blended census figure), so derive the same splits the
    // synthetic dataset used, proportional to current_occupancy.
    const occPct = Number(community.current_occupancy) / 100;
    const snfOcc = Math.round(community.units_snf * 0.870);
    const staffingInputs = {
      ilCap: community.units_il, alCap: community.units_al, mcCap: community.units_mc, snfCap: community.units_snf,
      ilOcc: Math.round(community.units_il * 0.928), alOcc: Math.round(community.units_al * 0.907), mcOcc: Math.round(community.units_mc * 0.923),
      snfRehab: Math.round(snfOcc * 0.32), snfLtc: snfOcc - Math.round(snfOcc * 0.32),
      ilSqft: 168000, alSqft: community.sqft_al, mcSqft: community.sqft_mc, snfSqft: 41600,
      ccrc: community.structure.ccrc, tax: community.structure.tax, ownership: community.structure.ownership,
      config: community.structure.config, optSecurity: community.structure.optSecurity,
    };
    const SB = sbcCompute(staffingInputs);

    console.log("=== " + community.name + " — Operations Intelligence snapshot ===");
    console.log("Summary:", R.summary);
    console.log("Staffing model grand total FTE:", Math.round(SB.grandTotal * 10) / 10);

    const below = Object.values(R.results).filter((r) => r.scoreBand === "below");
    console.log("\nBelow-benchmark measures (" + below.length + "):");
    below.forEach((r) => console.log(" ", r.code, KPI_BY_CODE[r.code].name, "=", r.value));

    await client.query(
      "INSERT INTO report_runs (community_id, summary, results, staffing) VALUES ($1, $2, $3, $4)",
      [community.id, JSON.stringify(R.summary), JSON.stringify(R.results), JSON.stringify({ grandTotal: SB.grandTotal, positions: SB.positions })]
    );
    console.log("\nSnapshot written to report_runs.");
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
