const { computeAllKPIs, sbcCompute, OPERAND_REGISTRY, KPI_BY_CODE } = require("./compute");
const dataset = require("./dataset.json");

// Flatten operands into the { key: {value, unit, family} } store shape STATE.operands uses
const store = {};
for (const fam of Object.values(dataset.operands)) {
  for (const [k, v] of Object.entries(fam)) {
    store[k] = { value: v, unit: (OPERAND_REGISTRY[k] || {}).unit, family: (OPERAND_REGISTRY[k] || {}).family };
  }
}

const R = computeAllKPIs(store, dataset.cms);
console.log("=== KPI summary ===");
console.log(R.summary);

const missing = Object.values(R.results).filter((r) => r.status === "missing-inputs");
if (missing.length) {
  console.log("\n=== MISSING INPUTS (" + missing.length + ") ===");
  missing.forEach((r) => console.log(r.code, KPI_BY_CODE[r.code].name, "->", r.missing));
}
const errors = Object.values(R.results).filter((r) => r.status === "compute-error");
if (errors.length) {
  console.log("\n=== COMPUTE ERRORS (" + errors.length + ") ===");
  errors.forEach((r) => console.log(r.code, KPI_BY_CODE[r.code].name));
}

console.log("\n=== Sample computed values ===");
["OPS-01", "OPS-03", "HR-01", "HR-04", "HR-05", "HR-06", "FIN-01", "FIN-05", "PLT-04", "PLT-07", "SNF-6.01"].forEach((c) => {
  const r = R.results[c];
  console.log(c, KPI_BY_CODE[c] ? KPI_BY_CODE[c].name : "?", "=", r && r.value, "|", r && r.scoreBand, "|", r && r.status);
});

// Staffing model
const I = {
  ilCap: dataset.profile.units.IL, alCap: dataset.profile.units.AL, mcCap: dataset.profile.units.MC, snfCap: dataset.profile.units.SNF,
  ilOcc: Math.round(dataset.profile.units.IL * 0.928), alOcc: Math.round(dataset.profile.units.AL * 0.907), mcOcc: Math.round(dataset.profile.units.MC * 0.923),
  snfRehab: Math.round(dataset.profile.units.SNF * 0.870 * 0.32), snfLtc: Math.round(dataset.profile.units.SNF * 0.870 * 0.68),
  ilSqft: 168000, alSqft: dataset.profile.sqft.AL, mcSqft: dataset.profile.sqft.MC, snfSqft: 41600,
  ccrc: dataset.profile.structure.ccrc, tax: dataset.profile.structure.tax, ownership: dataset.profile.structure.ownership,
  config: dataset.profile.structure.config, optSecurity: dataset.profile.structure.optSecurity,
};
const SB = sbcCompute(I);
console.log("\n=== Staffing model grand total FTE ===", Math.round(SB.grandTotal * 10) / 10);
SB.order.forEach((name) => {
  const o = SB.positions[name];
  const t = SB.rowTot(o);
  if (t > 0) console.log(" ", name.padEnd(26), Math.round(t * 100) / 100);
});
