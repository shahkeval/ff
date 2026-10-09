/*
 * Generates realistic, row-level "raw" operating reports for each upload
 * bucket — the way a client's own PMS/EHR/payroll/GL system would actually
 * export them (daily census logs, payroll registers, GL journal detail,
 * CRM lead lists, work-order logs, etc.) — instead of a pre-computed
 * Operand Key/Label/Value answer sheet. Every summary figure in
 * dataset.json is reproduced by AGGREGATING the generated detail rows, so
 * the numbers the extraction pipeline is supposed to find are actually
 * buried in a real-shaped report, not handed to it.
 *
 * Output replaces 01-census.xlsx .. 09-gl.xlsx in "Synthetic Data/".
 * 10-manual.xlsx (operator-keyed survey scores), 11-chart-of-accounts.csv
 * and 12-policies-procedures.txt are untouched — those are genuinely
 * reference/manual-entry documents in real life, not extracted reports.
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const dataset = require("./dataset.json");

const OUT_DIR = path.join(__dirname, "..", "Synthetic Data");
const { operands } = dataset;

// ---------------------------------------------------------------------
// Seeded RNG + generic helpers
// ---------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(19830611);
const rand = (min, max) => min + rng() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Split `total` (integer) into `n` non-negative integers that sum exactly
// to `total`, distributed with variance around equal shares (or supplied
// weights).
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
  while (rem > 0 && k < order.length * 3) {
    floors[order[k % order.length]] += 1;
    rem -= 1; k += 1;
  }
  return floors.map((v) => v + minEach);
}

function splitTotalFloat(total, n, decimals = 2) {
  const parts = splitTotal(Math.round(total * 10 ** decimals), n).map((v) => v / 10 ** decimals);
  return parts;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = Date.UTC(2025, 0, 1);
const DAYS_IN_PERIOD = 365;
const addDays = (t, n) => t + n * DAY_MS;
const fmt = (t) => new Date(t).toISOString().slice(0, 10);
const dayOf = (n) => fmt(addDays(PERIOD_START, n));

// ---------------------------------------------------------------------
// Name pools
// ---------------------------------------------------------------------
const RESIDENT_FIRST = ["Margaret","Dorothy","Eleanor","Frances","Ruth","Helen","Betty","Shirley","Barbara","Patricia","Doris","Joan","Norma","Virginia","Carol","Nancy","Mary","Elizabeth","Rose","Ann","Robert","William","James","John","Charles","George","Harold","Richard","Donald","Kenneth","Edward","Walter","Raymond","Paul","Gerald","Eugene","Arthur","Clarence","Ralph","Lawrence","Frank"];
const RESIDENT_LAST = ["Anderson","Baker","Carter","Davis","Edwards","Foster","Grant","Harris","Ingram","Johnson","Keller","Lawson","Mitchell","Nelson","Osborn","Parker","Quinn","Reynolds","Sanders","Thompson","Underwood","Vance","Walker","Whitfield","Young","Zimmerman","Bennett","Coleman","Dawson","Ellison"];
const STAFF_FIRST = ["Ashley","Jasmine","Brittany","Megan","Amanda","Kayla","Samantha","Jessica","Danielle","Nicole","Michael","Christopher","Joshua","Brandon","Tyler","Marcus","DeShawn","Anthony","Jacob","Andrew","Maria","Carmen","Luis","Jose","Angela","Latoya","Keisha","Tanya","Erin","Rachel"];
const STAFF_LAST = ["Ramirez","Torres","Flores","Washington","Jefferson","Freeman","Hayes","Price","Bryant","Barrett","Mercer","Holloway","Pruitt","Sutton","Vaughn","Wheeler","Abernathy","Castillo","Delgado","Nguyen","Patel","Kim","Choi","Osei","Boateng","Alvarez","Reyes","Cordova","Whitaker","Simmons"];

function nameFactory(firstPool, lastPool) {
  const used = new Set();
  return function () {
    let n;
    do {
      n = `${pick(firstPool)} ${pick(lastPool)}`;
    } while (used.has(n) && used.size < firstPool.length * lastPool.length);
    used.add(n);
    return n;
  };
}
const genResidentName = nameFactory(RESIDENT_FIRST, RESIDENT_LAST);
const genStaffName = nameFactory(STAFF_FIRST, STAFF_LAST);

function sheetFromAOA(aoa, colWidths) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (colWidths) ws["!cols"] = colWidths.map((wch) => ({ wch }));
  return ws;
}

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

function writeWorkbook(fname, sheets) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, aoa, colWidths }) => {
    XLSX.utils.book_append_sheet(wb, sheetFromAOA(aoa, colWidths), name.slice(0, 31));
  });
  const outPath = path.join(OUT_DIR, fname);
  XLSX.writeFile(wb, outPath);
  const rows = sheets.reduce((n, s) => n + s.aoa.length - 1, 0);
  console.log(`Wrote ${fname} (${sheets.length} sheet${sheets.length > 1 ? "s" : ""}, ${rows} data rows)`);
}

const UNITS = dataset.profile.units; // { IL, AL, MC, SNF }
const CARE_LEVELS = ["IL", "AL", "MC", "SNF"];

// =======================================================================
// 01 — CENSUS: "Daily Census & Occupancy Detail"
// =======================================================================
function buildCensus() {
  const o = operands.census;
  const totalCap = o.availableUnits;

  // Daily occupancy random-walk per care level, anchored to start/end targets.
  const startTotal = o.censusStart;
  const endTotal = o.censusEnd;
  const shareIL = 0.495, shareAL = 0.22, shareMC = 0.11, shareSNF = 0.175; // ~matches profile unit mix
  const dailyRows = [];
  let cur = { IL: Math.round(startTotal * shareIL), AL: Math.round(startTotal * shareAL), MC: Math.round(startTotal * shareMC) };
  cur.SNF = startTotal - cur.IL - cur.AL - cur.MC;
  const targetEnd = { IL: Math.round(endTotal * shareIL), AL: Math.round(endTotal * shareAL), MC: Math.round(endTotal * shareMC) };
  targetEnd.SNF = endTotal - targetEnd.IL - targetEnd.AL - targetEnd.MC;

  let admissionsTotal = 0, dischargesTotal = 0;
  let snfSkilledRunningTotal = 0;
  const snfSkilledShare = 0.42; // Medicare/MA skilled share of SNF census, per benchmark mix
  for (let d = 0; d < DAYS_IN_PERIOD; d++) {
    const frac = d / (DAYS_IN_PERIOD - 1);
    CARE_LEVELS.forEach((lvl) => {
      const drift = (targetEnd[lvl] - (d === 0 ? cur[lvl] : cur[lvl])) * 0.01;
      const noise = randInt(-1, 1);
      let next = Math.round(cur[lvl] + drift + noise * (rng() < 0.35 ? 1 : 0));
      const cap = UNITS[lvl];
      next = Math.max(0, Math.min(cap, next));
      cur[lvl] = next;
    });
    const total = cur.IL + cur.AL + cur.MC + cur.SNF;
    const adm = rng() < 0.22 ? randInt(0, 2) : 0;
    const dis = rng() < 0.2 ? randInt(0, 2) : 0;
    admissionsTotal += adm; dischargesTotal += dis;
    const snfSkilled = Math.round(cur.SNF * snfSkilledShare);
    snfSkilledRunningTotal += snfSkilled;
    dailyRows.push([dayOf(d), cur.IL, cur.AL, cur.MC, cur.SNF, snfSkilled, total, totalCap, adm, dis]);
  }
  // Force first/last day levels to match targets exactly (real logs pin period
  // boundaries) — adjust IL to absorb any drift so Total stays level-consistent.
  dailyRows[0][1] += startTotal - dailyRows[0][6];
  dailyRows[0][6] = startTotal;
  const lastRow = dailyRows[dailyRows.length - 1];
  lastRow[1] += endTotal - lastRow[6];
  lastRow[6] = endTotal;

  // Nudge the running resident-day total onto the target via a scaling pass
  // on a handful of mid-period rows (keeps the log looking organic).
  let sumTotal = dailyRows.reduce((a, r) => a + r[6], 0);
  let diff = o.residentDays - sumTotal;
  let guard = 0;
  while (diff !== 0 && guard < 200000) {
    const idx = randInt(30, dailyRows.length - 30);
    const row = dailyRows[idx];
    const step = diff > 0 ? 1 : -1;
    for (const lvlIdx of shuffle([1, 2, 3, 4])) {
      const lvl = CARE_LEVELS[lvlIdx - 1];
      const cap = UNITS[lvl];
      if (row[lvlIdx] + step >= 0 && row[lvlIdx] + step <= cap) {
        row[lvlIdx] += step;
        row[6] += step;
        diff -= step;
        break;
      }
    }
    guard++;
  }

  // Nudge SNF-specific occupancy onto totalPatientDays, trading against IL so
  // the (already-correct) grand total is undisturbed.
  let sumSNF = dailyRows.reduce((a, r) => a + r[4], 0);
  let diffSNF = o.totalPatientDays - sumSNF;
  guard = 0;
  while (diffSNF !== 0 && guard < 200000) {
    const idx = randInt(1, dailyRows.length - 2);
    const row = dailyRows[idx];
    const step = diffSNF > 0 ? 1 : -1;
    if (row[4] + step >= 0 && row[4] + step <= UNITS.SNF && row[1] - step >= 0 && row[1] - step <= UNITS.IL) {
      row[4] += step;
      row[1] -= step;
      diffSNF -= step;
    }
    guard++;
  }
  // Recompute skilled sub-count from the finalized SNF column, then nudge it
  // onto skilledPatientDays exactly (a sub-classification, doesn't touch totals).
  dailyRows.forEach((row) => { row[5] = Math.round(row[4] * snfSkilledShare); });
  let sumSkilled = dailyRows.reduce((a, r) => a + r[5], 0);
  let diffSkilled = o.skilledPatientDays - sumSkilled;
  guard = 0;
  while (diffSkilled !== 0 && guard < 200000) {
    const idx = randInt(0, dailyRows.length - 1);
    const row = dailyRows[idx];
    const step = diffSkilled > 0 ? 1 : -1;
    if (row[5] + step >= 0 && row[5] + step <= row[4]) {
      row[5] += step;
      diffSkilled -= step;
    }
    guard++;
  }

  // Output column order deliberately puts Total Occupied right after the 4
  // additive care-level columns, with the SNF-skilled figure moved to the
  // end as an explicit "of which" memo — it's a SUBSET of SNF Occupied, not
  // a 5th category, and sat ambiguously between SNF and Total before.
  // Per-care-level Available Units columns (IL/AL/MC/SNF) sit alongside the
  // existing blended "Available Units" total — both are real, not derived:
  // UNITS.{IL,AL,MC,SNF} is the same licensed-capacity figure already used
  // above to cap daily occupancy, just surfaced as its own columns so a
  // level-specific occupancy rate (occupied / available, same care level)
  // can be computed without guessing at a split.
  const censusAOA = [
    ["Date", "IL Occupied", "AL Occupied", "MC Occupied", "SNF Occupied", "Total Occupied", "Available Units", "Admissions", "Discharges", "— of which SNF Skilled (Medicare/MA)", "IL Available Units", "AL Available Units", "MC Available Units", "SNF Available Units"],
    ...dailyRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[6], r[7], r[8], r[9], r[5], UNITS.IL, UNITS.AL, UNITS.MC, UNITS.SNF]),
  ];

  // Resident discharge / turnover detail — sums to residentsDeparted & sumResidentTenureDays.
  const n = o.residentsDeparted;
  const tenures = splitTotal(o.sumResidentTenureDays, n, { minEach: 90 });
  const reasons = ["Deceased", "Transferred to higher level of care", "Financial / private-pay exhausted", "Family relocation", "Dissatisfaction with services", "Hospitalized — did not return"];
  const payers = ["Private Pay", "Medicare A", "Medicaid", "Long-Term Care Insurance", "Managed Care"];
  const dischargeRows = [];
  for (let i = 0; i < n; i++) {
    const lvl = pick(CARE_LEVELS);
    const disDate = addDays(PERIOD_START, randInt(5, DAYS_IN_PERIOD - 1));
    const admDate = disDate - tenures[i] * DAY_MS;
    dischargeRows.push([
      `R-${1000 + i}`, genResidentName(), lvl, pick(payers), fmt(admDate), fmt(disDate), pick(reasons), tenures[i],
    ]);
  }
  const dischargeAOA = [
    ["Resident ID", "Name", "Care Level", "Payer Source", "Admit Date", "Discharge Date", "Discharge Reason", "Length of Stay (Days)"],
    ...dischargeRows,
  ];

  // SNF patient-days by payer (sums to daysByPayer / totalPatientDays)
  const payerNames = ["Medicare A (Skilled)", "Medicaid", "Managed Care / MA", "Private Pay"];
  const payerDays = [o.skilledPatientDays, ...splitTotal(o.daysByPayer - o.skilledPatientDays, 3, { minEach: 200 })];
  const payerAOA = [
    ["Payer Source", "SNF Patient-Days (Period)"],
    ...payerNames.map((p, i) => [p, payerDays[i]]),
    ["Total", payerDays.reduce((a, b) => a + b, 0)],
  ];

  writeWorkbook("01-census.xlsx", [
    { name: "Daily Census", aoa: censusAOA, colWidths: [12, 12, 12, 12, 12, 14, 14, 11, 11, 30] },
    { name: "Discharge Detail", aoa: dischargeAOA, colWidths: [10, 20, 10, 20, 12, 14, 32, 18] },
    { name: "SNF Days by Payer", aoa: payerAOA, colWidths: [24, 22] },
  ]);
}

// =======================================================================
// 02 — PAYROLL: register + staffing + new hires + training + WC claims
// =======================================================================
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

function buildPayroll() {
  const o = operands.payroll;
  const MONTHS = 12;
  const monthLabel = (m) => new Date(Date.UTC(2025, m, 1)).toLocaleString("en-US", { month: "short", year: "numeric" });

  // Build an employee master covering everyone on payroll at some point in the year.
  const departing = o.separations;
  // Departing employees are active ~half the year on average (term date is
  // uniform over the period) — size the permanent pool so permanent + that
  // partial-year contribution reconciles to the target average headcount.
  const active = o.avgHeadcount - Math.round(departing * 0.507);
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
        id: `E-${eid++}`,
        name: genStaffName(),
        dept,
        position: pick(POSITIONS_BY_DEPT[dept]),
        status: isDeparted ? "PT" && false : true, // placeholder, unused
        ftpt: rng() < 0.72 ? "FT" : "PT",
        hireDate, termDate,
      });
    }
  });

  // Monthly payroll register: one row per employee per month they were active.
  const registerRows = [];
  const activeCountByMonth = new Array(MONTHS).fill(0);
  employees.forEach((e) => {
    for (let m = 0; m < MONTHS; m++) {
      const monthStart = addDays(PERIOD_START, Math.round((m * DAYS_IN_PERIOD) / MONTHS));
      const monthEnd = addDays(PERIOD_START, Math.round(((m + 1) * DAYS_IN_PERIOD) / MONTHS)) - DAY_MS;
      const wasActive = e.hireDate <= monthEnd && (!e.termDate || e.termDate >= monthStart);
      if (wasActive) {
        activeCountByMonth[m]++;
        registerRows.push({ emp: e, month: m });
      }
    }
  });

  const N = registerRows.length;
  const regHours = splitTotal(o.scheduledHours, N, { minEach: 40, weights: registerRows.map((r) => (r.emp.ftpt === "FT" ? 1.4 : 0.7)) });
  const otHours = splitTotal(o.overtimeHours, N, { minEach: 0 });
  const absenceHours = splitTotal(o.unscheduledAbsenceHours, N, { minEach: 0 });
  const grossPay = splitTotal(o.grossWages, N, { minEach: 400, weights: regHours.map((h, i) => h + otHours[i] * 1.5) });

  const registerAOA = [
    ["Employee ID", "Name", "Department", "Position", "Pay Period", "FT/PT", "Regular Hours", "Overtime Hours", "Unscheduled Absence Hours", "Gross Pay ($)"],
  ];
  registerRows.forEach((r, i) => {
    registerAOA.push([r.emp.id, r.emp.name, r.emp.dept, r.emp.position, monthLabel(r.month), r.emp.ftpt, regHours[i], otHours[i], absenceHours[i], grossPay[i]]);
  });

  // Agency / contract labor detail (separate from W2 register) -> agencyHours
  const agencyRows = [];
  const AGENCY_N = 60;
  const agencyHrsSplit = splitTotal(o.agencyHours, AGENCY_N, { minEach: 4 });
  for (let i = 0; i < AGENCY_N; i++) {
    const dept = pick(["Nursing", "Dining Services", "Housekeeping"]);
    agencyRows.push([`AG-${100 + i}`, pick(["Bluegrass Staffing Solutions", "CarePro Nurse Staffing", "Palmetto Health Staffing", "Trinity Contract Nursing"]), dept, monthLabel(randInt(0, 11)), agencyHrsSplit[i]]);
  }
  const agencyAOA = [["Vendor Order #", "Agency Vendor", "Department", "Week/Period", "Hours Billed"], ...agencyRows];

  // Staffing / position roster
  const posRows = [];
  let filledSoFar = 0;
  DEPARTMENTS.forEach((dept) => {
    POSITIONS_BY_DEPT[dept].forEach((pos) => {
      const approved = randInt(4, 18);
      posRows.push({ dept, pos, approved });
    });
  });
  const totalApproved = posRows.reduce((a, r) => a + r.approved, 0);
  const scale = o.approvedPositions / totalApproved;
  posRows.forEach((r) => (r.approved = Math.max(1, Math.round(r.approved * scale))));
  const openIdxs = shuffle(Array.from({ length: posRows.length }, (_, i) => i)).slice(0, Math.min(o.openPositions, posRows.length));
  const staffingAOA = [["Department", "Position", "Approved Positions", "Open/Vacant", "Filled (Budgeted)"]];
  posRows.forEach((r, i) => {
    const open = openIdxs.includes(i) ? 1 : 0;
    staffingAOA.push([r.dept, r.pos, r.approved, open, r.approved - open]);
  });

  // New hire cohort -> newHires, newHiresRetained90
  const nhRows = [];
  const retainedFlags = shuffle([...Array(o.newHiresRetained90).fill("Retained"), ...Array(o.newHires - o.newHiresRetained90).fill("Separated before 90 days")]);
  const daysToFillPool = splitTotal(o.sumDaysToFill, o.positionsFilled, { minEach: 10 });
  for (let i = 0; i < o.newHires; i++) {
    const dept = pick(DEPARTMENTS);
    const hireDate = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 95));
    nhRows.push([`NH-${300 + i}`, genStaffName(), dept, pick(POSITIONS_BY_DEPT[dept]), fmt(hireDate), retainedFlags[i], i < o.positionsFilled ? daysToFillPool[i] : ""]);
  }
  const nhAOA = [["Req/Hire ID", "Name", "Department", "Position", "Hire Date", "90-Day Status", "Days to Fill (if backfilled req)"], ...nhRows];

  // Training compliance roster -> trainingsRequired / trainingsCompleted
  const perEmpRequired = 6;
  const compRows = [];
  const employeesActive = employees.filter((e) => !e.termDate || e.termDate > addDays(PERIOD_START, DAYS_IN_PERIOD - 30));
  const shortfall = o.trainingsRequired - o.trainingsCompleted;
  const missingByEmp = new Set(shuffle(Array.from({ length: employeesActive.length }, (_, i) => i)).slice(0, shortfall));
  employeesActive.slice(0, Math.round(o.trainingsRequired / perEmpRequired)).forEach((e, i) => {
    const completed = missingByEmp.has(i) ? perEmpRequired - 1 : perEmpRequired;
    compRows.push([e.id, e.name, e.dept, perEmpRequired, completed, completed === perEmpRequired ? "Compliant" : "Overdue"]);
  });
  const compAOA = [["Employee ID", "Name", "Department", "Trainings Required", "Trainings Completed", "Status"], ...compRows];

  // Employee status log (one row per employee on payroll this year) ->
  // separations / avgHeadcount, derivable as a plain row count/filter rather
  // than an inference across the register's monthly presence pattern.
  const statusAOA = [["Employee ID", "Name", "Department", "Position", "FT/PT", "Hire Date", "Termination Date", "Status"]];
  employees.forEach((e) => {
    statusAOA.push([e.id, e.name, e.dept, e.position, e.ftpt, fmt(e.hireDate), e.termDate ? fmt(e.termDate) : "", e.termDate ? "Separated" : "Active"]);
  });

  // Workers' comp claims -> wcCost
  const WC_N = 14;
  const wcAmounts = splitTotal(o.wcCost, WC_N, { minEach: 500 });
  const wcAOA = [["Claim #", "Employee", "Department", "Date of Injury", "Claim Type", "Incurred Cost ($)"]];
  for (let i = 0; i < WC_N; i++) {
    const emp = pick(employees);
    wcAOA.push([`WC-${2025000 + i}`, emp.name, emp.dept, fmt(addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1))), pick(["Strain/Sprain", "Slip/Fall", "Needlestick", "Repetitive Motion", "Vehicle Incident"]), wcAmounts[i]]);
  }

  writeWorkbook("02-payroll.xlsx", [
    { name: "Payroll Register", aoa: registerAOA, colWidths: [10, 20, 20, 20, 12, 6, 13, 14, 16, 12] },
    { name: "Agency Labor Detail", aoa: agencyAOA, colWidths: [14, 30, 20, 12, 12] },
    { name: "Staffing Detail", aoa: staffingAOA, colWidths: [22, 26, 18, 12, 16] },
    { name: "Employee Status Log", aoa: statusAOA, colWidths: [10, 20, 20, 20, 6, 12, 14, 12] },
    { name: "New Hire Cohort", aoa: nhAOA, colWidths: [10, 20, 22, 24, 12, 24, 28] },
    { name: "Training Compliance", aoa: compAOA, colWidths: [10, 20, 20, 16, 18, 12] },
    { name: "WC Claims", aoa: wcAOA, colWidths: [12, 20, 20, 14, 18, 14] },
  ]);
}

// =======================================================================
// 03 — CLINICAL
// =======================================================================
function buildClinical() {
  const o = operands.clinical;
  const n = o.totalResidents;
  const residents = [];
  for (let i = 0; i < n; i++) {
    const lvl = pick(["AL", "MC", "SNF"]);
    residents.push({ id: `R-${2000 + i}`, name: genResidentName(), lvl });
  }

  const rosterAOA = [["Resident ID", "Name", "Unit", "PDPM CMI - PT", "PDPM CMI - OT", "PDPM CMI - SLP", "PDPM CMI - Nursing", "PDPM CMI - NTA", "Psychotropic PRN Order"]];
  const prnFlags = new Set(shuffle(Array.from({ length: n }, (_, i) => i)).slice(0, o.residentsOnPsychotropicPRN));
  residents.forEach((r, i) => {
    const isSNF = r.lvl === "SNF";
    rosterAOA.push([
      r.id, r.name, r.lvl,
      isSNF ? round2(o.cmiPT * rand(0.85, 1.15)) : "",
      isSNF ? round2(o.cmiOT * rand(0.85, 1.15)) : "",
      isSNF ? round2(o.cmiSLP * rand(0.85, 1.15)) : "",
      isSNF ? round2(o.cmiNursing * rand(0.85, 1.15)) : "",
      isSNF ? round2(o.cmiNTA * rand(0.85, 1.15)) : "",
      prnFlags.has(i) ? "Yes" : "No",
    ]);
  });

  // Care plan review log -> carePlansDue / carePlansOnTime
  const cpAOA = [["Resident ID", "Resident", "Review Type", "Due Date", "Completed Date", "On-Time"]];
  const cpOnTimeIdx = new Set(shuffle(Array.from({ length: o.carePlansDue }, (_, i) => i)).slice(0, o.carePlansOnTime));
  for (let i = 0; i < o.carePlansDue; i++) {
    const res = pick(residents);
    const due = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1));
    const onTime = cpOnTimeIdx.has(i);
    const completed = due + (onTime ? -randInt(0, 3) : randInt(1, 12)) * DAY_MS;
    cpAOA.push([res.id, res.name, pick(["Quarterly Review", "Significant Change", "Annual Review"]), fmt(due), fmt(completed), onTime ? "Yes" : "No"]);
  }

  // MDS assessment log -> mdsTotal / mdsOnTime / auditedAssessments / accurateAssessments
  const mdsAOA = [["Resident ID", "Resident", "Assessment Type", "Target Date", "Completed Date", "On-Time", "Audited", "Coded Accurately"]];
  const mdsOnTimeIdx = new Set(shuffle(Array.from({ length: o.mdsTotal }, (_, i) => i)).slice(0, o.mdsOnTime));
  const auditedIdx = new Set(shuffle(Array.from({ length: o.mdsTotal }, (_, i) => i)).slice(0, o.auditedAssessments));
  const auditedOrder = [...auditedIdx];
  const accurateSet = new Set(shuffle(auditedOrder).slice(0, o.accurateAssessments));
  for (let i = 0; i < o.mdsTotal; i++) {
    const res = pick(residents.filter((r) => r.lvl === "SNF").length ? residents : residents);
    const target = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1));
    const onTime = mdsOnTimeIdx.has(i);
    const completed = target + (onTime ? -randInt(0, 2) : randInt(1, 8)) * DAY_MS;
    const audited = auditedIdx.has(i);
    mdsAOA.push([res.id, res.name, pick(["Admission", "Quarterly", "Annual", "Significant Change"]), fmt(target), fmt(completed), onTime ? "Yes" : "No", audited ? "Yes" : "No", audited ? (accurateSet.has(i) ? "Yes" : "No") : ""]);
  }

  // Clinical event log -> medErrors, fallsWithMajorInjury, newPressureInjuries, hospitalDischarges, utiCount, elopementCount
  const events = [];
  for (let i = 0; i < o.medErrors; i++) events.push(["Medication Error", pick(["Wrong time", "Omission", "Wrong dose", "Wrong resident"])]);
  for (let i = 0; i < o.fallsWithMajorInjury; i++) events.push(["Fall — Major Injury", pick(["Fracture", "Head injury", "Laceration requiring sutures"])]);
  for (let i = 0; i < o.newPressureInjuries; i++) events.push(["New Pressure Injury (Stage 2+)", pick(["Sacrum", "Heel", "Coccyx"])]);
  for (let i = 0; i < o.hospitalDischarges; i++) events.push(["Hospital Transfer/Discharge", pick(["Cardiac", "Respiratory", "UTI/Sepsis", "Fall-related", "GI"])]);
  for (let i = 0; i < o.utiCount; i++) events.push(["UTI", "Confirmed by culture"]);
  for (let i = 0; i < o.elopementCount; i++) events.push(["Elopement", "Recovered on grounds"]);
  const hospReadmitIdx = new Set(shuffle(events.map((_, i) => i).filter((i) => events[i][0] === "Hospital Transfer/Discharge")).slice(0, o.hospitalReadmissions30d));
  const eventAOA = [["Event #", "Date", "Resident", "Unit", "Event Type", "Detail", "30-Day Readmission Flag"]];
  events.forEach((e, i) => {
    const res = pick(residents);
    eventAOA.push([`CE-${4000 + i}`, fmt(addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1))), res.name, res.lvl, e[0], e[1], hospReadmitIdx.has(i) ? "Yes" : ""]);
  });

  // Medication administration summary -> dosesAdministered (monthly)
  const doseByMonth = splitTotal(o.dosesAdministered, 12, { minEach: 12000 });
  const errByMonth = splitTotal(o.medErrors, 12, { minEach: 5 });
  const medAOA = [["Month", "Doses Scheduled", "Doses Administered", "Administration Errors"]];
  for (let m = 0; m < 12; m++) {
    const label = new Date(Date.UTC(2025, m, 1)).toLocaleString("en-US", { month: "long", year: "numeric" });
    medAOA.push([label, doseByMonth[m] + randInt(0, 40), doseByMonth[m], errByMonth[m]]);
  }

  // Medicare/skilled discharge log -> medicareDischarges / sumMedicareLOSDays
  const losDays = splitTotal(o.sumMedicareLOSDays, o.medicareDischarges, { minEach: 5 });
  const medDischargeAOA = [["Resident ID", "Resident", "Admit Date", "Discharge Date", "LOS (Days)", "Discharge To"]];
  for (let i = 0; i < o.medicareDischarges; i++) {
    const res = pick(residents.filter((r) => r.lvl === "SNF"));
    const disDate = addDays(PERIOD_START, randInt(10, DAYS_IN_PERIOD - 1));
    const admDate = disDate - losDays[i] * DAY_MS;
    medDischargeAOA.push([res ? res.id : "R-2000", res ? res.name : residents[0].name, fmt(admDate), fmt(disDate), losDays[i], pick(["Home", "Assisted Living", "Long-Term Care (same building)", "Home Health"])]);
  }

  const snfRows = rosterAOA.slice(1).filter((r) => typeof r[3] === "number");
  const avg = (idx) => round2(sum(snfRows.map((r) => r[idx])) / snfRows.length);
  writeWorkbook("03-clinical.xlsx", [
    { name: "Resident Roster", aoa: rosterAOA, colWidths: [10, 20, 8, 10, 10, 10, 12, 10, 18] },
    { name: "Care Plan Reviews", aoa: cpAOA, colWidths: [10, 20, 18, 12, 14, 8] },
    { name: "MDS Assessment Log", aoa: mdsAOA, colWidths: [10, 20, 18, 12, 14, 8, 8, 14] },
    { name: "Clinical Event Log", aoa: eventAOA, colWidths: [10, 12, 20, 6, 24, 30, 18] },
    { name: "Medication Admin Summary", aoa: medAOA, colWidths: [16, 16, 18, 18] },
    { name: "Medicare Discharge Log", aoa: medDischargeAOA, colWidths: [10, 20, 12, 14, 10, 28] },
  ]);
}
function round2(x) { return Math.round(x * 100) / 100; }

// =======================================================================
// 04 — DINING
// =======================================================================
function buildDining() {
  const o = operands.dining;
  const MEALS = ["Breakfast", "Lunch", "Dinner"];
  const mealShare = { Breakfast: 0.28, Lunch: 0.35, Dinner: 0.37 };
  const dinerRows = [];
  const mealTargets = splitTotal(o.mealsServed, DAYS_IN_PERIOD * 3, {
    weights: Array.from({ length: DAYS_IN_PERIOD * 3 }, (_, i) => mealShare[MEALS[i % 3]]),
  });
  const dietTotalsPerRow = splitTotal(o.therapeuticDietsTotal, DAYS_IN_PERIOD * 3, { minEach: 0 });
  const specialTotalsPerRow = splitTotal(o.specialDietMealsServed, DAYS_IN_PERIOD * 3, { minEach: 0 });
  const rawFoodPerRow = splitTotal(o.rawFoodCost, DAYS_IN_PERIOD * 3, { minEach: 40 });
  const laborTotal = o.totalDiningCost - o.rawFoodCost - Math.round(o.rawFoodCost * 0.12);
  const suppliesTotal = o.totalDiningCost - o.rawFoodCost - laborTotal;
  const laborPerRow = splitTotal(laborTotal, DAYS_IN_PERIOD * 3, { minEach: 40 });
  const suppliesPerRow = splitTotal(suppliesTotal, DAYS_IN_PERIOD * 3, { minEach: 3 });
  const dietErrorIdx = new Set(shuffle(Array.from({ length: DAYS_IN_PERIOD * 3 }, (_, i) => i)).slice(0, o.specialDietErrors));

  let idx = 0;
  for (let d = 0; d < DAYS_IN_PERIOD; d++) {
    MEALS.forEach((meal) => {
      dinerRows.push([
        dayOf(d), meal, mealTargets[idx], dietTotalsPerRow[idx], specialTotalsPerRow[idx],
        dietErrorIdx.has(idx) ? 1 : 0, rawFoodPerRow[idx], laborPerRow[idx], suppliesPerRow[idx],
      ]);
      idx++;
    });
  }
  const dinerAOA = [
    ["Date", "Meal", "Diners Served", "Therapeutic Diet Trays", "Special Diet Trays", "Special Diet Errors", "Raw Food Cost ($)", "Labor Cost ($)", "Supplies Cost ($)"],
    ...dinerRows,
  ];

  // Therapeutic diet accuracy roll-up
  const errRows = o.therapeuticDietsTotal - o.therapeuticDietsCorrect;
  const dietAccAOA = [
    ["Metric", "Value"],
    ["Therapeutic diet trays served (period)", o.therapeuticDietsTotal],
    ["Served correctly", o.therapeuticDietsCorrect],
    ["Diet-order errors (wrong tray/texture/allergen)", errRows],
  ];

  // Nutritional assessments -> nutAssessmentsDue/Completed
  const residents = Array.from({ length: o.totalResidents }, () => genResidentName());
  const nutAOA = [["Resident", "Assessment Due Date", "Completed Date", "On-Time"]];
  const nutOnTimeIdx = new Set(shuffle(Array.from({ length: o.nutAssessmentsDue }, (_, i) => i)).slice(0, o.nutAssessmentsCompleted));
  for (let i = 0; i < o.nutAssessmentsDue; i++) {
    const due = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1));
    const onTime = nutOnTimeIdx.has(i);
    nutAOA.push([pick(residents), fmt(due), fmt(due + (onTime ? -randInt(0, 3) : randInt(1, 10)) * DAY_MS), onTime ? "Yes" : "No"]);
  }

  // Hydration monitoring -> hydrationRequired/Monitored
  const hydAOA = [["Resident", "Hydration Monitoring Required", "Monitored Per Protocol"]];
  const hydMonitoredIdx = new Set(shuffle(Array.from({ length: o.hydrationRequired }, (_, i) => i)).slice(0, o.hydrationMonitored));
  for (let i = 0; i < o.hydrationRequired; i++) {
    hydAOA.push([pick(residents), "Yes", hydMonitoredIdx.has(i) ? "Yes" : "No"]);
  }

  // Weight loss tracking -> residentsWithWeightLoss
  const wlAOA = [["Resident", "Weight 90 Days Ago (lb)", "Current Weight (lb)", "% Change"]];
  for (let i = 0; i < o.residentsWithWeightLoss; i++) {
    const base = randInt(105, 190);
    const pct = -rand(5.1, 9.5);
    wlAOA.push([pick(residents), base, round2(base * (1 + pct / 100)), round2(pct)]);
  }

  // Sanitation inspection log -> sanitationScore (avg)
  const sanScores = Array.from({ length: 12 }, () => round2(o.sanitationScore + rand(-2.5, 2.5)));
  const sumAdj = sanScores.reduce((a, b) => a + b, 0) / 12 - o.sanitationScore;
  sanScores[0] = round2(sanScores[0] - sumAdj * 12);
  const sanAOA = [["Month", "Kitchen Sanitation / Food-Safety Inspection Score"]];
  for (let m = 0; m < 12; m++) {
    sanAOA.push([new Date(Date.UTC(2025, m, 1)).toLocaleString("en-US", { month: "long", year: "numeric" }), sanScores[m]]);
  }

  const dinnerRows = dinerRows.filter((r) => r[1] === "Dinner");
  writeWorkbook("04-dining.xlsx", [
    { name: "Daily Meal Service Log", aoa: dinerAOA, colWidths: [12, 10, 12, 16, 14, 14, 16, 14, 14] },
    { name: "Diet Accuracy Summary", aoa: dietAccAOA, colWidths: [40, 14] },
    { name: "Nutritional Assessments", aoa: nutAOA, colWidths: [20, 16, 16, 10] },
    { name: "Hydration Monitoring", aoa: hydAOA, colWidths: [20, 24, 22] },
    { name: "Weight Loss Tracking", aoa: wlAOA, colWidths: [20, 20, 18, 10] },
    { name: "Sanitation Inspections", aoa: sanAOA, colWidths: [20, 40] },
  ]);
}

// =======================================================================
// 05 — SALES / CRM
// =======================================================================
function buildSales() {
  const o = operands.sales;
  const SOURCES = ["Website Inquiry", "Referral - Resident/Family", "Referral - Physician/Discharge Planner", "Google/Online Ads", "Walk-In", "Senior Referral Service", "Caring.com / A Place for Mom"];
  const leadRows = [];
  const touredIdx = new Set(shuffle(Array.from({ length: o.totalLeads }, (_, i) => i)).slice(0, o.tours));
  const depositIdx = new Set(shuffle([...touredIdx]).slice(0, o.deposits));
  const moveInFromDepositIdx = new Set(shuffle([...depositIdx]).slice(0, o.moveInsFromDeposits));
  const directMoveIns = o.moveInCount - o.moveInsFromDeposits;
  const nonDepositLeads = Array.from({ length: o.totalLeads }, (_, i) => i).filter((i) => !depositIdx.has(i));
  const directMoveInIdx = new Set(shuffle(nonDepositLeads).slice(0, Math.max(0, directMoveIns)));
  const activeIdx = new Set(shuffle(Array.from({ length: o.totalLeads }, (_, i) => i).filter((i) => !depositIdx.has(i) && !directMoveInIdx.has(i))).slice(0, o.activeLeads));

  const rateAmounts = splitTotal(Math.round(o.achievedRateSum), o.moveInCount, { minEach: 2800 });
  let rateCursor = 0;

  for (let i = 0; i < o.totalLeads; i++) {
    const inquiryDate = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1));
    const toured = touredIdx.has(i);
    const deposited = depositIdx.has(i);
    const movedInFromDeposit = moveInFromDepositIdx.has(i);
    const movedInDirect = directMoveInIdx.has(i);
    const movedIn = movedInFromDeposit || movedInDirect;
    const isActive = activeIdx.has(i);
    let status = "Lost/Closed";
    if (movedIn) status = "Move-In";
    else if (isActive) status = "Active";
    else if (deposited) status = "Deposit — Pending Move-In";
    leadRows.push([
      `L-${10000 + i}`, genResidentName(), pick(SOURCES), fmt(inquiryDate),
      toured ? fmt(inquiryDate + randInt(2, 21) * DAY_MS) : "",
      deposited ? fmt(inquiryDate + randInt(10, 45) * DAY_MS) : "",
      movedIn ? fmt(inquiryDate + randInt(20, 75) * DAY_MS) : "",
      status,
      movedIn ? rateAmounts[rateCursor++] : "",
    ]);
  }
  const leadAOA = [
    ["Lead ID", "Prospect Name", "Source", "Inquiry Date", "Tour Date", "Deposit Date", "Move-In Date", "Status", "Achieved Monthly Rate ($)"],
    ...leadRows,
  ];

  // Move-out log -> totalMoveOuts (shared narrative with census discharges)
  const REASONS = ["Death", "Transferred to Higher Level of Care", "Financial", "Dissatisfaction with Services"];
  const moveOutAOA = [["Resident", "Unit", "Move-Out Date", "Reason"]];
  for (let i = 0; i < o.totalMoveOuts; i++) {
    moveOutAOA.push([genResidentName(), pick(CARE_LEVELS), fmt(addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1))), pick(REASONS)]);
  }

  const moveIns = leadRows.filter((r) => r[7] === "Move-In");
  writeWorkbook("05-sales.xlsx", [
    { name: "Lead Activity Log", aoa: leadAOA, colWidths: [10, 20, 32, 12, 12, 12, 12, 24, 20] },
    { name: "Move-Out Log", aoa: moveOutAOA, colWidths: [20, 8, 14, 32] },
  ]);
}

// =======================================================================
// 06 — PLANT / MAINTENANCE
// =======================================================================
function buildPlant() {
  const o = operands.plant;
  const CATS = ["Plumbing", "Electrical", "HVAC", "Grounds", "Housekeeping Support", "Life Safety", "General Repair"];
  const openIdx = new Set(shuffle(Array.from({ length: o.workOrdersTotal }, (_, i) => i)).slice(0, o.openWOCount));
  const closedCount = o.workOrdersTotal - o.openWOCount;
  const onTimeIdxAmongClosed = new Set(shuffle(Array.from({ length: closedCount }, (_, i) => i)).slice(0, o.workOrdersCompletedOnTime));
  const openAges = splitTotal(o.sumOpenWODays, o.openWOCount, { minEach: 1 });

  const woAOA = [["WO #", "Date Opened", "Unit/Area", "Category", "Priority", "Date Closed", "Age/Days Open", "Completed On-Time"]];
  let openCursor = 0, closedCursor = 0;
  for (let i = 0; i < o.workOrdersTotal; i++) {
    const opened = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1));
    const isOpen = openIdx.has(i);
    if (isOpen) {
      woAOA.push([`WO-${20000 + i}`, fmt(opened), `${pick(CARE_LEVELS)}-${randInt(100, 399)}`, pick(CATS), pick(["Routine", "Urgent", "Emergency"]), "", openAges[openCursor++], ""]);
    } else {
      const onTime = onTimeIdxAmongClosed.has(closedCursor);
      closedCursor++;
      const days = onTime ? randInt(0, 3) : randInt(4, 21);
      woAOA.push([`WO-${20000 + i}`, fmt(opened), `${pick(CARE_LEVELS)}-${randInt(100, 399)}`, pick(CATS), pick(["Routine", "Urgent", "Emergency"]), fmt(opened + days * DAY_MS), days, onTime ? "Yes" : "No"]);
    }
  }

  const pmOnTimeIdx = new Set(shuffle(Array.from({ length: o.pmScheduled }, (_, i) => i)).slice(0, o.pmCompletedOnTime));
  const pmAOA = [["PM Task #", "Equipment/Asset", "Frequency", "Scheduled Date", "Completed Date", "On-Time"]];
  const EQUIP = ["HVAC Rooftop Unit", "Boiler", "Emergency Generator", "Fire Alarm Panel", "Elevator", "Kitchen Hood/Ansul", "Nurse Call System", "Water Softener", "Sprinkler System"];
  for (let i = 0; i < o.pmScheduled; i++) {
    const sched = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1));
    const onTime = pmOnTimeIdx.has(i);
    pmAOA.push([`PM-${300 + i}`, pick(EQUIP), pick(["Monthly", "Quarterly", "Semi-Annual", "Annual"]), fmt(sched), fmt(sched + (onTime ? randInt(-2, 0) : randInt(1, 15)) * DAY_MS), onTime ? "Yes" : "No"]);
  }

  const lsAOA = [["Inspection", "Required", "Status"]];
  const LS_TYPES = ["Fire Alarm System Test", "Sprinkler System Certification", "Fire Extinguisher Inspection", "Emergency Generator Load Test", "Kitchen Suppression System Test", "Egress/Life Safety Walkthrough"];
  for (let i = 0; i < o.lifeSafetyRequired; i++) {
    lsAOA.push([LS_TYPES[i % LS_TYPES.length], "Yes", i < o.lifeSafetyCurrent ? "Current / Passed" : "Overdue"]);
  }

  const vpAOA = [["Vehicle", "PM Scheduled", "Completed On Schedule"]];
  const vpCompletedIdx = new Set(shuffle(Array.from({ length: o.vehiclePMScheduled }, (_, i) => i)).slice(0, o.vehiclePMCompleted));
  for (let i = 0; i < o.vehiclePMScheduled; i++) {
    vpAOA.push([`Community Van/Bus #${(i % 4) + 1}`, "Yes", vpCompletedIdx.has(i) ? "Yes" : "No"]);
  }

  const energyCurByMonth = splitTotal(o.energyUsageCurrent, 12, { minEach: 1000000 });
  const energyPriorByMonth = splitTotal(o.energyUsagePrior, 12, { minEach: 1000000 });
  const enAOA = [["Month", "Site Energy — Current Period (kBtu)", "Site Energy — Prior Period (kBtu)"]];
  for (let m = 0; m < 12; m++) {
    enAOA.push([new Date(Date.UTC(2025, m, 1)).toLocaleString("en-US", { month: "long", year: "numeric" }), energyCurByMonth[m], energyPriorByMonth[m]]);
  }

  writeWorkbook("06-plant.xlsx", [
    { name: "Work Order Log", aoa: woAOA, colWidths: [12, 12, 12, 20, 10, 12, 14, 16] },
    { name: "Preventive Maintenance", aoa: pmAOA, colWidths: [10, 22, 14, 14, 14, 8] },
    { name: "Life Safety Inspections", aoa: lsAOA, colWidths: [32, 10, 20] },
    { name: "Vehicle PM Log", aoa: vpAOA, colWidths: [22, 14, 22] },
    { name: "Energy-Utility Log", aoa: enAOA, colWidths: [18, 30, 30] },
  ]);
}

// =======================================================================
// 07 — INCIDENT & GRIEVANCE
// =======================================================================
function buildIncident() {
  const o = operands.incident;
  const TYPES = ["Fall (no major injury)", "Skin/Wound", "Behavioral Event", "Medication Related", "Property/Equipment", "Visitor/Family Concern", "Elopement Attempt", "Other"];
  const incAOA = [["Incident #", "Date", "Location/Unit", "Type", "Severity", "Family Notified"]];
  for (let i = 0; i < o.incidentCount; i++) {
    incAOA.push([`INC-${5000 + i}`, fmt(addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1))), pick(CARE_LEVELS), pick(TYPES), pick(["Minor", "Moderate", "Significant"]), pick(["Yes", "Yes", "Yes", "No"])]);
  }

  const CATS = ["Care Quality", "Food Service", "Billing/Financial", "Housekeeping", "Communication", "Staffing"];
  const resolvedOnTimeIdx = new Set(shuffle(Array.from({ length: o.grievanceCount }, (_, i) => i)).slice(0, o.grievancesResolvedOnTime));
  const grvAOA = [["Complaint #", "Date Filed", "Category", "Filed By", "Date Resolved", "Resolved On-Time"]];
  for (let i = 0; i < o.grievanceCount; i++) {
    const filed = addDays(PERIOD_START, randInt(0, DAYS_IN_PERIOD - 1));
    const onTime = resolvedOnTimeIdx.has(i);
    grvAOA.push([`GRV-${700 + i}`, fmt(filed), pick(CATS), pick(["Resident", "Family Member"]), fmt(filed + (onTime ? randInt(1, 5) : randInt(10, 30)) * DAY_MS), onTime ? "Yes" : "No"]);
  }

  writeWorkbook("07-incident.xlsx", [
    { name: "Incident Log", aoa: incAOA, colWidths: [12, 12, 12, 24, 12, 14] },
    { name: "Grievance Log", aoa: grvAOA, colWidths: [12, 12, 18, 14, 14, 16] },
  ]);
}

// =======================================================================
// 08 — LIFE ENRICHMENT
// =======================================================================
function buildLifeEnrichment() {
  const o = operands["life-enrichment"];
  const ACTIVITIES_GEN = ["Morning Exercise", "Bingo", "Current Events Discussion", "Arts & Crafts", "Music Therapy", "Devotional Service", "Van Outing", "Happy Hour Social", "Trivia", "Book Club"];
  const ACTIVITIES_MC = ["Memory Care Music Group", "Sensory Stimulation", "Structured Reminiscence", "Adapted Exercise", "Hand Massage/Aromatherapy", "Structured Art Group"];

  const attendanceAOA = [["Date", "Activity", "Setting", "Structured MC Session", "Duration (Hrs)", "Attendee Count"]];
  const perDayCount = 4;
  const totalSessions = DAYS_IN_PERIOD * perDayCount;
  // ~1 in 6 sessions is a structured MC session; durations sum to structuredEngagementHours.
  const structuredSlots = [];
  for (let d = 0; d < DAYS_IN_PERIOD; d++) {
    for (let s = 0; s < perDayCount; s++) {
      if (s === 0 && d % 4 === 0) structuredSlots.push(d * perDayCount + s);
    }
  }
  const structuredDurations = splitTotalFloat(o.structuredEngagementHours, structuredSlots.length, 1);
  const structuredSet = new Map(structuredSlots.map((slot, i) => [slot, structuredDurations[i]]));

  let idx = 0;
  for (let d = 0; d < DAYS_IN_PERIOD; d++) {
    for (let s = 0; s < perDayCount; s++) {
      const isStructured = structuredSet.has(idx);
      const setting = isStructured || rng() < 0.25 ? "Memory Care" : "General";
      const activity = setting === "Memory Care" ? pick(ACTIVITIES_MC) : pick(ACTIVITIES_GEN);
      const duration = isStructured ? structuredSet.get(idx) : round2(rand(0.5, 1.5));
      attendanceAOA.push([dayOf(d), activity, setting, isStructured ? "Yes" : "No", duration, randInt(6, 28)]);
      idx++;
    }
  }

  // Weekly unique-participant summary -> participatingResidents (avg weekly)
  const weeklyAOA = [["Week Ending", "Unique Residents Participating"]];
  const weeklyCounts = Array.from({ length: 52 }, () => Math.round(o.participatingResidents + rand(-15, 15)));
  const avgAdj = o.participatingResidents - weeklyCounts.reduce((a, b) => a + b, 0) / 52;
  weeklyCounts[0] = Math.round(weeklyCounts[0] + avgAdj * 52);
  for (let w = 0; w < 52; w++) {
    weeklyAOA.push([fmt(addDays(PERIOD_START, (w + 1) * 7 - 1)), weeklyCounts[w]]);
  }

  writeWorkbook("08-lifeEnrichment.xlsx", [
    { name: "Activity Attendance Log", aoa: attendanceAOA, colWidths: [12, 26, 14, 18, 12, 14] },
    { name: "Weekly Participation", aoa: weeklyAOA, colWidths: [14, 26] },
  ]);
}

// =======================================================================
// 09 — GENERAL LEDGER
// =======================================================================
const GL_ACCOUNTS = [
  { code: "4000", name: "Resident Fees - Independent Living", dept: "Independent Living", type: "Revenue" },
  { code: "4010", name: "Resident Fees - Assisted Living", dept: "Assisted Living", type: "Revenue" },
  { code: "4020", name: "Resident Fees - Memory Care", dept: "Memory Care", type: "Revenue" },
  { code: "4030", name: "Resident Fees - Skilled Nursing (Medicare A)", dept: "Skilled Nursing", type: "Revenue" },
  { code: "4031", name: "Resident Fees - Skilled Nursing (Medicaid)", dept: "Skilled Nursing", type: "Revenue" },
  { code: "4032", name: "Resident Fees - Skilled Nursing (Managed Care)", dept: "Skilled Nursing", type: "Revenue" },
  { code: "4040", name: "Ancillary Service Income", dept: "Skilled Nursing", type: "Revenue" },
  { code: "4050", name: "Entrance Fee Amortization", dept: "CCRC / Entity", type: "Revenue" },
  { code: "4900", name: "Other Operating Income", dept: "Administration", type: "Revenue" },
  { code: "5100", name: "Wages - Direct Care", dept: "Nursing", type: "Expense", wageShare: 0.44 },
  { code: "5110", name: "Wages - Dining Services", dept: "Dining", type: "Expense", wageShare: 0.16 },
  { code: "5120", name: "Wages - Housekeeping", dept: "Housekeeping", type: "Expense", wageShare: 0.11 },
  { code: "5130", name: "Wages - Plant Operations", dept: "Plant and Maintenance", type: "Expense", wageShare: 0.09 },
  { code: "5140", name: "Wages - Administration", dept: "Administration", type: "Expense", wageShare: 0.10 },
  { code: "5150", name: "Wages - Sales and Marketing", dept: "Sales and Marketing", type: "Expense", wageShare: 0.05 },
  { code: "5160", name: "Wages - Life Enrichment", dept: "Life Enrichment", type: "Expense", wageShare: 0.05 },
  { code: "5200", name: "Payroll Taxes and Benefits", dept: "Human Resources", type: "Expense" },
  { code: "5210", name: "Agency and Contract Labor", dept: "Human Resources", type: "Expense" },
  { code: "5300", name: "Raw Food Cost", dept: "Dining", type: "Expense" },
  { code: "5310", name: "Dining Supplies", dept: "Dining", type: "Expense" },
  { code: "5400", name: "Housekeeping Supplies", dept: "Housekeeping", type: "Expense" },
  { code: "5500", name: "Plant Maintenance and Repairs", dept: "Plant and Maintenance", type: "Expense" },
  { code: "5510", name: "Utilities", dept: "Plant and Maintenance", type: "Expense" },
  { code: "5520", name: "Grounds and Landscaping", dept: "Plant and Maintenance", type: "Expense" },
  { code: "5600", name: "Marketing and Advertising", dept: "Sales and Marketing", type: "Expense" },
  { code: "5700", name: "Insurance", dept: "Administration", type: "Expense" },
  { code: "5710", name: "Property Taxes", dept: "Administration", type: "Expense" },
  { code: "5800", name: "Depreciation and Amortization", dept: "Administration", type: "Expense" },
  { code: "5900", name: "Interest Expense", dept: "Finance", type: "Expense" },
  { code: "6000", name: "Corporate/Management Fee", dept: "Administration", type: "Expense" },
];
const VENDORS = ["Sysco Food Services", "US Foods", "Duke Energy", "City Water & Sewer", "ABC Medical Supply", "Cintas Uniform Services", "Waste Management Inc.", "CarePro Nurse Staffing", "Bluegrass Staffing Solutions", "Southern Landscape Group", "AAA Elevator Service", "Trane Mechanical Services", "Liberty Mutual Insurance", "County Tax Assessor", "Regional Bank & Trust", "Office Depot", "Comcast Business", "Verizon Wireless", "ADP Payroll Services", "Corporate Management Co."];

function buildGL() {
  const fin = operands.financial;
  const monthLabel = (m) => new Date(Date.UTC(2025, m, 1)).toLocaleString("en-US", { month: "short", year: "numeric" });

  // --- Annual $ target per account, all reconciling to dataset.json financial family ---
  const grossWages = operands.payroll.grossWages; // 8,420,000 -> wage accounts
  // laborCost = grossWages + benefits + agencyDollar. Recreate the same split build-dataset.js used.
  const benefitsAmt = round0(grossWages * 0.22);
  const agencyDollar = fin.laborCost - grossWages - benefitsAmt;
  const nonLaborTotal = fin.operatingExpenses - fin.laborCost; // 6,940,000
  const depreciationAmt = fin.annualDepreciationExpense; // fixed 5800 total
  const otherNonLabor = nonLaborTotal - depreciationAmt;

  const wageAccounts = GL_ACCOUNTS.filter((a) => a.wageShare);
  const wageWeights = wageAccounts.map((a) => a.wageShare);
  const wageAmounts = splitTotal(grossWages, wageAccounts.length, { minEach: 10000, weights: wageWeights });

  const nonLaborExpenseAccounts = GL_ACCOUNTS.filter((a) => a.type === "Expense" && !a.wageShare && a.code !== "5200" && a.code !== "5210" && a.code !== "5800");
  const nonLaborShares = { "5300": 0.30, "5310": 0.05, "5400": 0.045, "5500": 0.11, "5510": 0.22, "5520": 0.045, "5600": 0.09, "5700": 0.075, "5710": 0.05, "5900": 0.015, "6000": 0.045 };
  const nlWeights = nonLaborExpenseAccounts.map((a) => nonLaborShares[a.code] || 0.05);
  const nonLaborAmounts = splitTotal(otherNonLabor, nonLaborExpenseAccounts.length, { minEach: 5000, weights: nlWeights });

  const revenueAccounts = GL_ACCOUNTS.filter((a) => a.type === "Revenue");
  const skilledCodes = new Set(["4030", "4031", "4032", "4040"]);
  const skilledAccounts = revenueAccounts.filter((a) => skilledCodes.has(a.code));
  const otherRevAccounts = revenueAccounts.filter((a) => !skilledCodes.has(a.code));
  const skilledAmounts = splitTotal(fin.skilledRevenue, skilledAccounts.length, { minEach: 200000 });
  const otherRevAmounts = splitTotal(fin.totalRevenue - fin.skilledRevenue, otherRevAccounts.length, { minEach: 500000, weights: [0.55, 0.22, 0.14, 0.03, 0.06] });

  const annualByCode = {};
  wageAccounts.forEach((a, i) => (annualByCode[a.code] = wageAmounts[i]));
  nonLaborExpenseAccounts.forEach((a, i) => (annualByCode[a.code] = nonLaborAmounts[i]));
  skilledAccounts.forEach((a, i) => (annualByCode[a.code] = skilledAmounts[i]));
  otherRevAccounts.forEach((a, i) => (annualByCode[a.code] = otherRevAmounts[i]));
  annualByCode["5200"] = benefitsAmt;
  annualByCode["5210"] = agencyDollar;
  annualByCode["5800"] = depreciationAmt;

  // --- Build monthly + transaction-line detail per account, reconciling exactly ---
  const glAOA = [["JE #", "Date", "Account Code", "Account Name", "Department", "Description", "Vendor/Payee", "Debit ($)", "Credit ($)"]];
  let je = 400001;
  GL_ACCOUNTS.forEach((acct) => {
    const annual = annualByCode[acct.code];
    const monthlyAmounts = splitTotal(annual, 12, { minEach: Math.max(1, Math.round(annual / 12 / 4)) });
    const isRevenue = acct.type === "Revenue";
    const linesPerMonth = acct.wageShare || acct.code === "5200" || acct.code === "5210" ? 2 : isRevenue ? 2 : (acct.code === "5800" ? 1 : 5);
    for (let m = 0; m < 12; m++) {
      const lineAmts = splitTotal(monthlyAmounts[m], linesPerMonth, { minEach: 1 });
      for (let l = 0; l < linesPerMonth; l++) {
        const amt = lineAmts[l];
        if (amt <= 0) continue;
        const date = fmt(addDays(PERIOD_START, Math.min(DAYS_IN_PERIOD - 1, Math.round((m * DAYS_IN_PERIOD) / 12) + randInt(0, 24))));
        const desc = isRevenue
          ? `${monthLabel(m)} resident billing — ${acct.dept}`
          : acct.wageShare ? `${monthLabel(m)} payroll batch — ${acct.dept}`
          : acct.code === "5200" ? `${monthLabel(m)} benefits/payroll tax accrual`
          : acct.code === "5210" ? `${monthLabel(m)} agency staffing invoice`
          : acct.code === "5800" ? `${monthLabel(m)} depreciation entry`
          : `${monthLabel(m)} ${acct.name.toLowerCase()} invoice`;
        const vendor = isRevenue ? "" : pick(VENDORS);
        glAOA.push([
          `JE-${je++}`, date, acct.code, acct.name, acct.dept, desc, vendor,
          isRevenue ? "" : amt,
          isRevenue ? amt : "",
        ]);
      }
    }
  });

  // --- Balance sheet ending balances (period-end snapshot, not transaction-summed) ---
  const bsAOA = [
    ["Account", "Ending Balance ($)"],
    ["Unrestricted Cash & Equivalents", fin.unrestrictedCash],
    ["Total Accounts Receivable", fin.totalAR],
    ["Accumulated Depreciation", fin.accumulatedDepreciation],
    ["Prior-Period Net Operating Income", fin.priorNOI],
  ];

  // --- A/R Aging ---
  const arCurrent = fin.totalAR - fin.arOver90 - Math.round(fin.totalAR * 0.18);
  const ar3060 = fin.totalAR - fin.arOver90 - arCurrent;
  const arAOA = [
    ["Aging Bucket", "Amount ($)"],
    ["Current (0-30 days)", arCurrent],
    ["31-60 days", Math.round(ar3060 * 0.55)],
    ["61-90 days", Math.round(ar3060 * 0.45)],
    ["Over 90 days", fin.arOver90],
    ["Total A/R", fin.totalAR],
    ["Bad Debt Write-Offs (period)", fin.writeOffs],
  ];

  // --- Budget vs actual by department ---
  const deptExpense = {};
  GL_ACCOUNTS.filter((a) => a.type === "Expense").forEach((a) => {
    deptExpense[a.dept] = (deptExpense[a.dept] || 0) + annualByCode[a.code];
  });
  const budgetShare = fin.budgetExpense / fin.actualExpense;
  const deptEntries = Object.entries(deptExpense);
  const budgetAmounts = splitTotal(fin.budgetExpense, deptEntries.length, { weights: deptEntries.map(([, actual]) => actual) });
  const bvaAOA = [["Department", "Actual Expense ($)", "Budget ($)", "Variance ($)"]];
  deptEntries.forEach(([dept, actual], i) => {
    bvaAOA.push([dept, actual, budgetAmounts[i], actual - budgetAmounts[i]]);
  });

  const glCredit = sum(glAOA.slice(1).map((r) => (typeof r[8] === "number" ? r[8] : 0)));
  const glDebit = sum(glAOA.slice(1).map((r) => (typeof r[7] === "number" ? r[7] : 0)));
  const skilledCredit = sum(glAOA.slice(1).filter((r) => skilledCodes.has(r[2])).map((r) => r[8]));
  const laborDebit = sum(glAOA.slice(1).filter((r) => r[2] === "5100" || r[2] === "5110" || r[2] === "5120" || r[2] === "5130" || r[2] === "5140" || r[2] === "5150" || r[2] === "5160" || r[2] === "5200" || r[2] === "5210").map((r) => r[7]));
  const deprDebit = sum(glAOA.slice(1).filter((r) => r[2] === "5800").map((r) => r[7]));
  writeWorkbook("09-gl.xlsx", [
    { name: "GL Detail", aoa: glAOA, colWidths: [12, 12, 10, 32, 20, 36, 26, 14, 14] },
    { name: "Balance Sheet Summary", aoa: bsAOA, colWidths: [34, 18] },
    { name: "AR Aging", aoa: arAOA, colWidths: [26, 16] },
    { name: "Budget vs Actual", aoa: bvaAOA, colWidths: [24, 18, 16, 16] },
  ]);
}
function round0(x) { return Math.round(x); }

// =======================================================================
buildCensus();
buildPayroll();
buildClinical();
buildDining();
buildSales();
buildPlant();
buildIncident();
buildLifeEnrichment();
buildGL();
console.log("\nAll raw-format synthetic reports written to:", OUT_DIR);
