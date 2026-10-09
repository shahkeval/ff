/*
 * Generates one .xlsx file per upload bucket in the Advantedge Operations
 * tool's "Operand Key / Label / Value / Unit" report-template format, from
 * dataset.json — these are the files to upload during the live demo.
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const OPERAND_REGISTRY = require("./operand-registry.json");
const dataset = require("./dataset.json");

const OUT_DIR = path.join(__dirname, "..", "Synthetic Data");
fs.mkdirSync(OUT_DIR, { recursive: true });

// bucket -> { title, family key(s) in dataset.operands }
const BUCKETS = [
  { bucket: "census", title: "Census / Occupancy Report", fam: "census" },
  { bucket: "payroll", title: "Payroll, Turnover & Staffing Report", fam: "payroll" },
  { bucket: "clinical", title: "Clinical / EHR & MDS Report", fam: "clinical" },
  { bucket: "dining", title: "Dining / Food Service Report", fam: "dining" },
  { bucket: "sales", title: "Sales / CRM Report", fam: "sales" },
  { bucket: "plant", title: "Plant / Maintenance Report", fam: "plant" },
  { bucket: "incident", title: "Incident & Grievance Log", fam: "incident" },
  { bucket: "lifeEnrichment", title: "Life Enrichment / Activity Participation Report", fam: "life-enrichment" },
  { bucket: "gl", title: "General Ledger (Financial Operands)", fam: "financial" },
  { bucket: "manual", title: "Manual Entries (Operator-Keyed Measures)", fam: "manual" },
];

function buildSheet(entries) {
  const rows = [["Operand Key", "Label", "Value", "Unit"]];
  entries.forEach(([key, value]) => {
    const reg = OPERAND_REGISTRY[key] || {};
    rows.push([key, reg.label || "", value, reg.unit || ""]);
  });
  return XLSX.utils.aoa_to_sheet(rows);
}

BUCKETS.forEach(({ bucket, title, fam }) => {
  const famData = dataset.operands[fam] || {};
  const entries = Object.entries(famData);
  const wb = XLSX.utils.book_new();
  const ws = buildSheet(entries);
  ws["!cols"] = [{ wch: 26 }, { wch: 42 }, { wch: 16 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  const fname = `${String(BUCKETS.indexOf(BUCKETS.find((b) => b.bucket === bucket)) + 1).padStart(2, "0")}-${bucket}.xlsx`;
  const outPath = path.join(OUT_DIR, fname);
  XLSX.writeFile(wb, outPath);
  console.log("Wrote", fname, `(${entries.length} operands)`);
});

console.log("\nAll synthetic report files written to:", OUT_DIR);
