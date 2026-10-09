/*
 * Generates a 5-FILE payroll section test set — same community, same
 * employee roster, same FY2025 period, same ground-truth totals as
 * dataset.json's payroll operands — but split across 5 separate workbooks
 * instead of one, each focused on a different slice of the data (register,
 * agency labor, benefits/expense, staffing status, training). This exists
 * to test multi-file-per-section upload/extraction: the 5 files are
 * cross-consistent (same employees, same dates) but no single file contains
 * everything, so extracting the full payroll picture requires combining
 * findings across all 5 in sequence.
 *
 * Output: "Synthetic Data/Payroll Multi-File/Payroll Section - File N....xlsx"
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const dataset = require("./dataset.json");

const OUT_DIR = path.join(__dirname, "..", "Synthetic Data", "Payroll Multi-File");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- Seeded RNG (same mulberry32 approach as build-raw-reports.js) -------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20250601);
const rand = (min, max) => min + rng() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function splitTotal(total, n, { minEach = 0, weights = null } = {}) {
  if (n <= 0) return [];
  const w = weights || Array.from({ length: n }, () => 0.25 + rng());
  const sumW = w.reduce((a, b) => a + b, 0);
  const pool = total - minEach * n;
  const raw = w.map((x) => (pool * x) / sumW);
  const floors = raw.map(Math.floor);
  let rem = pool - floors.reduce((a, b) => a + b, 0);
  const order = shuffle(Array.from({ length: n }, (_, i) => i));
  let k = 0;
  while (rem > 0 && k < order.length * 3) { floors[order[k % order.length]] += 1; rem -= 1; k += 1; }
  return floors.map((v) => v + minEach);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = Date.UTC(2025, 0, 1);
const DAYS_IN_PERIOD = 365;
const addDays = (t, n) => t + n * DAY_MS;
const fmt = (t) => new Date(t).toISOString().slice(0, 10);
const monthLabel = (m) => new Date(Date.UTC(2025, m, 1)).toLocaleString("en-US", { month: "short", year: "numeric" });

const STAFF_FIRST = ["Ashley","Jasmine","Brittany","Megan","Amanda","Kayla","Samantha","Jessica","Danielle","Nicole","Michael","Christopher","Joshua","Brandon","Tyler","Marcus","DeShawn","Anthony","Jacob","Andrew","Maria","Carmen","Luis","Jose","Angela","Latoya","Keisha","Tanya","Erin","Rachel","Victoria","Brianna","Austin","Caleb","Diana","Felicia","Gabriel","Hannah","Isaac","Julia"];
const STAFF_LAST = ["Ramirez","Torres","Flores","Washington","Jefferson","Freeman","Hayes","Price","Bryant","Barrett","Mercer","Holloway","Pruitt","Sutton","Vaughn","Wheeler","Abernathy","Castillo","Delgado","Nguyen","Patel","Kim","Choi","Osei","Boateng","Alvarez","Reyes","Cordova","Whitaker","Simmons","Lowery","Nash","Garrison","Pittman","Sears","Vance","Winslow"];
function nameFactory(firstPool, lastPool) {
  const used = new Set();
  return function () {
    let n; do { n = `${pick(firstPool)} ${pick(lastPool)}`; } while (used.has(n) && used.size < firstPool.length * lastPool.length);
    used.add(n); return n;
  };
}
const genStaffName = nameFactory(STAFF_FIRST, STAFF_LAST);

const DEPARTMENTS = ["Nursing", "Dining Services", "Housekeeping", "Plant and Maintenance", "Administration", "Sales and Marketing", "Life Enrichment"];
const POSITIONS_BY_DEPT = {
  "Nursing": ["CNA", "Med Aide", "LPN", "RN", "Unit Manager"],
  "Dining Services": ["Dietary Aide", "Cook", "Dining Server", "Dietary Manager"],
  "Housekeeping": ["Housekeeper", "Laundry Aide", "EVS Supervisor"],
  "Plant and Maintenance": ["Maintenance Tech", "Groundskeeper", "Maintenance Director"],
  "Administration": ["Business Office Coordinator", "Receptionist", "HR Coordinator", "Executive Director"],
  "Sales and Marketing": ["Sales Counselor", "Marketing Director"],
  "Life Enrichment": ["Activities Assistant", "Life Enrichment Director"],
};
const DEPT_HEADCOUNT_SHARE = { "Nursing": 0.44, "Dining Services": 0.16, "Housekeeping": 0.11, "Plant and Maintenance": 0.09, "Administration": 0.10, "Sales and Marketing": 0.05, "Life Enrichment": 0.05 };

function sheetFromAOA(aoa, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (colWidths) ws["!cols"] = colWidths.map((wch) => ({ wch }));
  return ws;
}
function writeWorkbook(fname, sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, aoa, colWidths }) => XLSX.utils.book_append_sheet(wb, sheetFromAOA(aoa, colWidths), name.slice(0, 31)));
  const outPath = path.join(OUT_DIR, fname);
  XLSX.writeFile(wb, outPath);
  const rows = sheets.reduce((n, s) => n + s.aoa.length - 1, 0);
  console.log(`Wrote ${fname} (${sheets.length} sheet${sheets.length > 1 ? "s" : ""}, ${rows} data rows)`);
}

// ===========================================================================
// SHARED EMPLOYEE ROSTER — built once, used by all 5 files
// ===========================================================================
const o = dataset.operands.payroll;
const departing = o.separations;
const active = o.avgHeadcount - Math.round(departing * 0.507); // see build-raw-reports.js for the reasoning
const employees = [];
let eid = 5000;
DEPARTMENTS.forEach((dept) => {
  const deptActive = Math.round(active * DEPT_HEADCOUNT_SHARE[dept]);
  const deptDeparted = Math.round(departing * DEPT_HEADCOUNT_SHARE[dept]);
  for (let i = 0; i < deptActive + deptDeparted; i++) {
    const isDeparted = i >= deptActive;
    const hireDate = addDays(PERIOD_START, -randInt(30, 2200));
    const termDate = isDeparted ? addDays(PERIOD_START, randInt(10, DAYS_IN_PERIOD - 5)) : null;
    employees.push({
      id: `E-${eid++}`, name: genStaffName(), dept, position: pick(POSITIONS_BY_DEPT[dept]),
      ftpt: rng() < 0.72 ? "FT" : "PT", hireDate, termDate,
      hourlyRate: Math.round(rand(dept === "Nursing" ? 18 : 14, dept === "Nursing" ? 34 : 24) * 100) / 100,
    });
  }
});
console.log(`Shared roster: ${employees.length} employees across ${DEPARTMENTS.length} departments`);

// ===========================================================================
// FILE 1 — Payroll Register (biweekly, richer columns)
// ===========================================================================
function buildFile1() {
  const PERIODS = 26; // biweekly
  const regRows = [];
  for (let p = 0; p < PERIODS; p++) {
    const periodStart = addDays(PERIOD_START, Math.round((p * DAYS_IN_PERIOD) / PERIODS));
    const periodEnd = addDays(PERIOD_START, Math.round(((p + 1) * DAYS_IN_PERIOD) / PERIODS)) - DAY_MS;
    employees.forEach((e) => {
      const wasActive = e.hireDate <= periodEnd && (!e.termDate || e.termDate >= periodStart);
      if (wasActive) regRows.push({ emp: e, period: p });
    });
  }
  const N = regRows.length;
  const regHours = splitTotal(o.scheduledHours, N, { minEach: 15, weights: regRows.map((r) => (r.emp.ftpt === "FT" ? 1.4 : 0.7)) });
  const otHours = splitTotal(o.overtimeHours, N, { minEach: 0 });
  const absenceHours = splitTotal(o.unscheduledAbsenceHours, N, { minEach: 0 });
  const grossPay = regRows.map((r, i) => Math.round((regHours[i] + otHours[i] * 1.5) * r.emp.hourlyRate * 100) / 100);

  const aoa = [["Employee ID", "Name", "Department", "Position", "Pay Period", "Period Start", "Period End", "FT/PT", "Hourly Rate ($)", "Regular Hours", "Overtime Hours", "Unscheduled Absence Hours", "Gross Pay ($)", "Federal Tax Withheld ($)", "State Tax Withheld ($)", "Benefits Deduction ($)", "Net Pay ($)"]];
  regRows.forEach((r, i) => {
    const periodStart = addDays(PERIOD_START, Math.round((r.period * DAYS_IN_PERIOD) / PERIODS));
    const periodEnd = addDays(PERIOD_START, Math.round(((r.period + 1) * DAYS_IN_PERIOD) / PERIODS)) - DAY_MS;
    const gross = grossPay[i];
    const fedTax = Math.round(gross * 0.12 * 100) / 100;
    const stateTax = Math.round(gross * 0.045 * 100) / 100;
    const benefitsDeduction = Math.round(gross * 0.06 * 100) / 100;
    const net = Math.round((gross - fedTax - stateTax - benefitsDeduction) * 100) / 100;
    aoa.push([
      r.emp.id, r.emp.name, r.emp.dept, r.emp.position, `Period ${r.period + 1} (biweekly)`, fmt(periodStart), fmt(periodEnd),
      r.emp.ftpt, r.emp.hourlyRate, regHours[i], otHours[i], absenceHours[i], gross, fedTax, stateTax, benefitsDeduction, net,
    ]);
  });

  writeWorkbook("Payroll Section - File 1 (Payroll Register).xlsx", [
    { name: "Payroll Register", aoa, colWidths: [10, 20, 20, 20, 20, 12, 12, 6, 12, 12, 12, 16, 12, 14, 14, 14, 12] },
  ]);
  return { nursingHours: sum(regRows.map((r, i) => (r.emp.dept === "Nursing" ? regHours[i] + otHours[i] : 0))) };
}
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// ===========================================================================
// FILE 2 — Agency Labor Details (per-shift billing)
// ===========================================================================
function buildFile2() {
  const VENDORS = ["Bluegrass Staffing Solutions", "CarePro Nurse Staffing", "Palmetto Health Staffing", "Trinity Contract Nursing", "ShiftMed Agency Partners"];
  const AGENCY_WORKERS = 42;
  const workers = Array.from({ length: AGENCY_WORKERS }, (_, i) => ({
    id: `AG-W${100 + i}`, name: genStaffName(), vendor: pick(VENDORS), dept: pick(["Nursing", "Dining Services", "Housekeeping"]),
  }));
  const SHIFTS_TOTAL = 2080; // ~50 shifts/worker average
  const shiftHours = splitTotal(o.agencyHours, SHIFTS_TOTAL, { minEach: 4 });
  const aoa = [["Shift ID", "Agency Worker ID", "Worker Name", "Agency Vendor", "Department", "Shift Date", "Shift Hours", "Bill Rate ($/hr)", "Billed Amount ($)"]];
  for (let i = 0; i < SHIFTS_TOTAL; i++) {
    const w = pick(workers);
    const billRate = w.dept === "Nursing" ? rand(38, 58) : rand(24, 36);
    const hrs = shiftHours[i];
    const billed = Math.round(hrs * billRate * 100) / 100;
    aoa.push([`SH-${30000 + i}`, w.id, w.name, w.vendor, w.dept, fmt(addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1))), hrs, Math.round(billRate * 100) / 100, billed]);
  }
  writeWorkbook("Payroll Section - File 2 (Agency Labor Details).xlsx", [
    { name: "Agency Labor Details", aoa, colWidths: [12, 14, 20, 30, 20, 12, 12, 14, 16] },
  ]);
}

// ===========================================================================
// FILE 3 — Employee Benefits & Expense Details (incl. WC claims as a category)
// ===========================================================================
function buildFile3() {
  const CATEGORIES = ["Health Insurance", "Dental Insurance", "Vision Insurance", "401k Employer Match", "Life Insurance", "Workers Comp Allocation"];
  const activeEmployees = employees.filter((e) => !e.termDate || e.termDate > addDays(PERIOD_START, DAYS_IN_PERIOD - 30));
  const rows = [];
  activeEmployees.forEach((e) => {
    for (let m = 0; m < 12; m++) {
      CATEGORIES.forEach((cat) => { if (rng() < 0.85) rows.push({ emp: e, month: m, category: cat }); });
    }
  });
  const nonWcRows = rows.filter((r) => r.category !== "Workers Comp Allocation");
  const amounts = splitTotal(Math.round((o.grossWages - sumPayrollAlreadyAllocated()) * 0.22), nonWcRows.length, { minEach: 15 });

  // Separate, explicit Workers' Comp CLAIMS (not routine allocation) -> wcCost / wcClaimCount
  const WC_N = 16;
  const wcAmounts = splitTotal(o.wcCost, WC_N, { minEach: 500 });
  const wcRows = [];
  for (let i = 0; i < WC_N; i++) {
    const emp = pick(activeEmployees);
    wcRows.push({ emp, month: randInt(0, 11), category: "Workers Comp Claim", amount: wcAmounts[i], claim: true });
  }

  const allRows = shuffle([...nonWcRows.map((r, i) => ({ ...r, amount: amounts[i], claim: false })), ...wcRows]);
  const aoa = [["Employee ID", "Name", "Department", "Month", "Expense Category", "Amount ($)", "Claim Type (if applicable)"]];
  allRows.forEach((r) => {
    aoa.push([r.emp.id, r.emp.name, r.emp.dept, monthLabel(r.month), r.category, r.amount, r.claim ? pick(["Strain/Sprain", "Slip/Fall", "Needlestick", "Repetitive Motion", "Vehicle Incident"]) : ""]);
  });
  writeWorkbook("Payroll Section - File 3 (Employee Benefits and Expense Details).xlsx", [
    { name: "Benefits and Expense Details", aoa, colWidths: [10, 20, 20, 16, 24, 14, 24] },
  ]);
}
function sumPayrollAlreadyAllocated() { return 0; } // placeholder, benefits are modeled as a flat % of wages here

// ===========================================================================
// FILE 4 — Employee Status & Staffing Log (+ small position/new-hire sheets)
// ===========================================================================
function buildFile4() {
  const statusRows = [];
  for (let m = 0; m < 12; m++) {
    const monthStart = addDays(PERIOD_START, Math.round((m * DAYS_IN_PERIOD) / 12));
    const monthEnd = addDays(PERIOD_START, Math.round(((m + 1) * DAYS_IN_PERIOD) / 12)) - DAY_MS;
    employees.forEach((e) => {
      const wasActive = e.hireDate <= monthEnd && (!e.termDate || e.termDate >= monthStart);
      if (!wasActive) return;
      const separatedThisMonth = e.termDate && e.termDate >= monthStart && e.termDate <= monthEnd;
      statusRows.push([e.id, e.name, e.dept, e.position, monthLabel(m), e.ftpt, separatedThisMonth ? "Separated" : "Active"]);
    });
  }
  const statusAOA = [["Employee ID", "Name", "Department", "Position", "Month", "FT/PT", "Status"], ...statusRows];

  // Position roster (small, structural — not padded to 2000 rows)
  const posRows = [];
  DEPARTMENTS.forEach((dept) => POSITIONS_BY_DEPT[dept].forEach((pos) => posRows.push({ dept, pos, approved: randInt(4, 18) })));
  const totalApproved = posRows.reduce((a, r) => a + r.approved, 0);
  const scale = o.approvedPositions / totalApproved;
  posRows.forEach((r) => (r.approved = Math.max(1, Math.round(r.approved * scale))));
  const openIdxs = shuffle(Array.from({ length: posRows.length }, (_, i) => i)).slice(0, Math.min(o.openPositions, posRows.length));
  const staffingAOA = [["Department", "Position", "Approved Positions", "Open/Vacant"]];
  posRows.forEach((r, i) => staffingAOA.push([r.dept, r.pos, r.approved, openIdxs.includes(i) ? 1 : 0]));

  // New hire cohort (small)
  const nhAOA = [["Req/Hire ID", "Name", "Department", "Position", "Hire Date", "90-Day Status", "Days to Fill (if backfilled req)"]];
  const retainedFlags = shuffle([...Array(o.newHiresRetained90).fill("Retained"), ...Array(o.newHires - o.newHiresRetained90).fill("Separated before 90 days")]);
  const daysToFillPool = splitTotal(o.sumDaysToFill, o.positionsFilled, { minEach: 10 });
  for (let i = 0; i < o.newHires; i++) {
    const dept = pick(DEPARTMENTS);
    nhAOA.push([`NH-${300 + i}`, genStaffName(), dept, pick(POSITIONS_BY_DEPT[dept]), fmt(addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 95))), retainedFlags[i], i < o.positionsFilled ? daysToFillPool[i] : ""]);
  }

  writeWorkbook("Payroll Section - File 4 (Employee Status and Staffing Log).xlsx", [
    { name: "Employee Status Log", aoa: statusAOA, colWidths: [10, 20, 20, 20, 16, 6, 12] },
    { name: "Position Roster", aoa: staffingAOA, colWidths: [22, 26, 18, 12] },
    { name: "New Hire Cohort", aoa: nhAOA, colWidths: [10, 20, 22, 24, 12, 24, 28] },
  ]);
}

// ===========================================================================
// FILE 5 — Training & Compliance Log (per employee, per course)
// ===========================================================================
function buildFile5() {
  const COURSES = ["Fire & Life Safety", "Infection Control", "Abuse & Neglect Prevention", "HIPAA Privacy", "Bloodborne Pathogens", "Dementia Care Basics", "Emergency Preparedness", "Workplace Violence Prevention", "Back Safety / Body Mechanics", "Resident Rights", "Fall Prevention", "Food Handler Safety", "Customer Service Excellence", "Cultural Competency", "Elder Abuse Reporting"];
  const activeEmployees = employees.filter((e) => !e.termDate || e.termDate > addDays(PERIOD_START, DAYS_IN_PERIOD - 30));

  // This file's own row count (every active employee assigned every course)
  // is kept local to this generator — it does NOT write back to the shared
  // dataset.json ground truth used elsewhere in the project.
  const rows = [];
  activeEmployees.forEach((e) => COURSES.forEach((course) => rows.push({ emp: e, course })));
  const trainingsRequired = rows.length;
  const trainingsCompleted = Math.round(trainingsRequired * 0.96);
  const shortfall = trainingsRequired - trainingsCompleted;

  const incompleteIdx = new Set(shuffle(Array.from({ length: rows.length }, (_, i) => i)).slice(0, shortfall));
  const aoa = [["Employee ID", "Name", "Department", "Course Name", "Assigned Date", "Due Date", "Completed Date", "Status"]];
  rows.forEach((r, i) => {
    const assigned = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 60));
    const due = assigned + 30 * DAY_MS;
    const incomplete = incompleteIdx.has(i);
    aoa.push([r.emp.id, r.emp.name, r.emp.dept, r.course, fmt(assigned), fmt(due), incomplete ? "" : fmt(due - randInt(0, 10) * DAY_MS), incomplete ? "Overdue" : "Completed"]);
  });
  writeWorkbook("Payroll Section - File 5 (Training and Compliance Log).xlsx", [
    { name: "Training Compliance Log", aoa, colWidths: [10, 20, 20, 30, 12, 12, 14, 12] },
  ]);
}

// ===========================================================================
const f1 = buildFile1();
buildFile2();
buildFile3();
buildFile4();
buildFile5();
console.log("\nAll 5 payroll multi-file test files written to:", OUT_DIR);
console.log("(nursingHours cross-check from File 1:", Math.round(f1.nursingHours), ")");
