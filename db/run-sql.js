/*
 * Runs one or more .sql files against the VMP-POC Postgres database.
 * Usage: node run-sql.js 001_schema.sql 002_seed_kpi_catalog.sql ...
 */
const fs = require("fs");
const path = require("path");
const { Client } = require(path.join(__dirname, "..", "mcp-postgres-rw", "node_modules", "pg"));

const CONN = "postgresql://devteam:D3vteaM%2321@172.16.1.30:5432/VMP-POC";

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("Usage: node run-sql.js <file.sql> [more.sql ...]"); process.exit(1); }
  const client = new Client({ connectionString: CONN });
  await client.connect();
  try {
    for (const f of files) {
      const p = path.join(__dirname, f);
      const sql = fs.readFileSync(p, "utf8");
      console.log("Running", f, "(" + sql.length + " bytes)...");
      const res = await client.query(sql);
      const rows = Array.isArray(res) ? res[res.length - 1].rowCount : res.rowCount;
      console.log("  OK, last statement rowCount:", rows);
    }
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
