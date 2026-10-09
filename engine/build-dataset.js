/*
 * Builds the synthetic demo dataset for "Cedar Bluff Commons" — a fictional
 * nonprofit CCRC used to test the Advantedge Operations POC end to end.
 * Produces one JSON file (dataset.json) containing:
 *   - profile: community profile fields (Screen 01/02 equivalent)
 *   - operands: every OPERAND_REGISTRY key -> value, grouped by source bucket
 *   - cms: mock CMS Care Compare fetch results for the 26 CMS-sourced KPIs
 * All numbers are internally consistent (census ties to resident-days,
 * payroll ties to labor cost, etc.) and deliberately produce a mix of
 * on-benchmark / watch / below-benchmark results, matching the shape of the
 * sample "Whitefield Commons" report.
 */
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Core narrative parameters
// ---------------------------------------------------------------------
const PERIOD_MONTHS = 12;
const DAYS = 365;

const CAP = { IL: 120, AL: 54, MC: 26, SNF: 46 };
const OCC_PCT = { IL: 0.928, AL: 0.907, MC: 0.923, SNF: 0.870 };
const OCC = {
  IL: Math.round(CAP.IL * OCC_PCT.IL),
  AL: Math.round(CAP.AL * OCC_PCT.AL),
  MC: Math.round(CAP.MC * OCC_PCT.MC),
  SNF: Math.round(CAP.SNF * OCC_PCT.SNF),
};
const TOTAL_CAP = CAP.IL + CAP.AL + CAP.MC + CAP.SNF;
const TOTAL_OCC = OCC.IL + OCC.AL + OCC.MC + OCC.SNF;
const SNF_REHAB_SHARE = 0.32;
const snfRehab = Math.round(OCC.SNF * SNF_REHAB_SHARE);
const snfLtc = OCC.SNF - snfRehab;

const profile = {
  communityName: "Cedar Bluff Commons",
  operator: "Cedar Bluff Senior Living Group",
  address: "4400 Bluff Ridge Parkway",
  cityStateZip: "Asheville, NC 28806",
  stateAbbr: "NC",
  units: { IL: CAP.IL, AL: CAP.AL, MC: CAP.MC, SNF: CAP.SNF },
  sqft: { IL: 168000, AL: 42800, MC: 18200, SNF: 41600, total: 168000 + 42800 + 18200 + 41600 },
  currentOccupancy: Math.round((TOTAL_OCC / TOTAL_CAP) * 1000) / 10,
  occupancyByLevel: {
    IL: Math.round(OCC_PCT.IL * 1000) / 10, AL: Math.round(OCC_PCT.AL * 1000) / 10,
    MC: Math.round(OCC_PCT.MC * 1000) / 10, SNF: Math.round(OCC_PCT.SNF * 1000) / 10,
  },
  yearOpened: 1998,
  market: { radiusMiles: 15, driveTimeMin: 20 },
  careLevels: ["Independent Living", "Assisted Living", "Memory Care", "Skilled Nursing"],
  operatorServices: ["Home Health", "Hospice (referral network)"],
  structure: { ccrc: "Yes", ownership: "Standalone", tax: "Nonprofit", config: "Single", optSecurity: "No" },
};

// ---------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------
const round1 = (x) => Math.round(x * 10) / 10;
const round0 = (x) => Math.round(x);

// ---------------------------------------------------------------------
// CENSUS family
// ---------------------------------------------------------------------
const residentDays = TOTAL_OCC * DAYS;
const totalPatientDays = OCC.SNF * DAYS; // SNF-specific patient days
const skilledPatientDays = round0(totalPatientDays * 0.42); // Medicare-A + MA skilled mix
const skilledDays = skilledPatientDays;
const censusStart = TOTAL_OCC - 6;
const censusEnd = TOTAL_OCC;
const residentsDeparted = 58; // annualized move-outs across campus
const sumResidentTenureDays = residentsDeparted * 760; // ~2.08 yr avg tenure

const census = {
  availableUnits: TOTAL_CAP,
  occupiedUnits: TOTAL_OCC,
  censusStart,
  censusEnd,
  totalResidents: TOTAL_OCC,
  mcResidents: OCC.MC,
  residentDays,
  totalDays: residentDays,
  totalPatientDays,
  skilledPatientDays,
  skilledDays,
  residentsDeparted,
  sumResidentTenureDays,
  daysByPayer: totalPatientDays, // distribution KPI — value unused, just needs to be present
};

// ---------------------------------------------------------------------
// PAYROLL family — total current headcount ~148 FTE-equivalent
// ---------------------------------------------------------------------
const avgHeadcount = 176; // headcount (not FTE) for turnover math
const separations = 79; // -> ~45% total turnover, "Below" like the sample
const totalHours = 148 * 2080;
const overtimeHours = round0(totalHours * 0.068);
const agencyHours = round0(totalHours * 0.081);
const scheduledHours = totalHours - overtimeHours;
const unscheduledAbsenceHours = round0(totalHours * 0.039);
const approvedPositions = 162;
const openPositions = 14;
const newHires = 52;
const newHiresRetained90 = 39;
const positionsFilledThisPeriod = 46; // reqs actually filled in the period (some of the 52 hires backfilled turnover, not open reqs)
const positionsFilled = positionsFilledThisPeriod;
const sumDaysToFill = positionsFilledThisPeriod * 52; // avg 52 days to fill
const trainingsRequired = 176 * 6;
const trainingsCompleted = Math.round(trainingsRequired * 0.968);
const grossWages = 8_420_000;
const wcCost = round0(grossWages * 0.021);

const payroll = {
  avgHeadcount,
  separations,
  totalHours,
  overtimeHours,
  agencyHours,
  scheduledHours,
  unscheduledAbsenceHours,
  approvedPositions,
  openPositions,
  positionsFilled,
  newHires,
  newHiresRetained90,
  sumDaysToFill,
  trainingsRequired,
  trainingsCompleted,
  grossWages,
  wcCost,
};

// ---------------------------------------------------------------------
// CLINICAL family (AL/MC/SNF)
// ---------------------------------------------------------------------
const dosesAdministered = 214_000;
const medErrors = 214; // ~0.1% error rate, on benchmark
const fallsWithMajorInjury = 9; // per 1,000 resident days -> below (target <4)
const newPressureInjuries = 4;
const totalResidentsClinical = OCC.AL + OCC.MC + OCC.SNF;
const hospitalDischarges = 96;
const hospitalReadmissions30d = 23; // ~24% -> watch
const utiCount = 21;
const residentsOnPsychotropicPRN = 34;
const carePlansDue = 210;
const carePlansOnTime = 202;
const mdsTotal = 168;
const mdsOnTime = 166;
const auditedAssessments = 60;
const accurateAssessments = 57;
const elopementCount = 0;
const medicareDischarges = 44;
const sumMedicareLOSDays = 44 * 27;

const clinical = {
  dosesAdministered,
  medErrors,
  fallsWithMajorInjury,
  newPressureInjuries,
  totalResidents: totalResidentsClinical,
  hospitalDischarges,
  hospitalReadmissions30d,
  utiCount,
  residentsOnPsychotropicPRN,
  carePlansDue,
  carePlansOnTime,
  mdsTotal,
  mdsOnTime,
  auditedAssessments,
  accurateAssessments,
  elopementCount,
  medicareDischarges,
  sumMedicareLOSDays,
  cmiPT: 1.38,
  cmiOT: 1.34,
  cmiSLP: 1.16,
  cmiNursing: 1.47,
  cmiNTA: 1.05,
};

// ---------------------------------------------------------------------
// DINING family
// ---------------------------------------------------------------------
const mealsServed = TOTAL_OCC * 3 * DAYS * 0.74; // avg meal participation ~74% campus blended
const rawFoodCost = round0(mealsServed * 5.35);
const totalDiningCost = round0(rawFoodCost / 0.27); // raw food ~27% of total dining cost
const diningRoomAttendees = round0(TOTAL_OCC * 0.81);
const nutAssessmentsDue = 168;
const nutAssessmentsCompleted = 164;
const therapeuticDietsTotal = 9800;
const therapeuticDietsCorrect = 9645;
const specialDietMealsServed = 4100;
const specialDietErrors = 9;
const hydrationRequired = 62;
const hydrationMonitored = 59;
const residentsWithWeightLoss = 12; // ~4.7% quarterly-equivalent -> on benchmark
const sanitationScore = 96.5;

const dining = {
  mealsServed: round0(mealsServed),
  rawFoodCost,
  totalDiningCost,
  diningRoomAttendees,
  totalResidents: TOTAL_OCC,
  nutAssessmentsDue,
  nutAssessmentsCompleted,
  therapeuticDietsTotal,
  therapeuticDietsCorrect,
  specialDietMealsServed,
  specialDietErrors,
  hydrationRequired,
  hydrationMonitored,
  residentsWithWeightLoss,
  sanitationScore,
};

// ---------------------------------------------------------------------
// SALES family
// ---------------------------------------------------------------------
const totalLeads = 612;
const leads = totalLeads;
const tours = 152;
const deposits = 71;
const moveInsFromDeposits = 58;
const moveInCount = 61;
const moveIns = moveInCount;
const newMoveIns = moveInCount;
const totalMoveOuts = residentsDeparted;
const activeLeads = 84;
const achievedRateSum = moveInCount * 5150; // blended achieved monthly rate per move-in

const sales = {
  totalLeads,
  leads,
  tours,
  deposits,
  moveInsFromDeposits,
  moveInCount,
  moveIns,
  newMoveIns,
  totalMoveOuts,
  activeLeads,
  achievedRateSum,
  leadsBySource: totalLeads,
  moveInsBySource: moveInCount,
  moveOutsByReason: totalMoveOuts,
};

// ---------------------------------------------------------------------
// PLANT family
// ---------------------------------------------------------------------
const workOrdersTotal = round0(TOTAL_CAP * 0.71 * PERIOD_MONTHS);
const workOrdersCompletedOnTime = round0(workOrdersTotal * 0.79);
const sumOpenWODays = round0(workOrdersTotal * 0.11 * 12.5);
const openWOCount = round0(workOrdersTotal * 0.06);
const pmScheduled = round0(workOrdersTotal * 0.28);
const pmCompletedOnTime = round0(pmScheduled * 0.812);
const lifeSafetyRequired = 6;
const lifeSafetyCurrent = 6;
const vehiclePMScheduled = 24;
const vehiclePMCompleted = 22;
const energyUsagePrior = 42_400_000;
const energyUsageCurrent = 42_360_000;

const plant = {
  workOrdersTotal,
  workOrdersCompletedOnTime,
  sumOpenWODays,
  openWOCount,
  pmScheduled,
  pmCompletedOnTime,
  lifeSafetyRequired,
  lifeSafetyCurrent,
  vehiclePMScheduled,
  vehiclePMCompleted,
  energyUsagePrior,
  energyUsageCurrent,
};

// ---------------------------------------------------------------------
// INCIDENT family
// ---------------------------------------------------------------------
const incidentCount = round0((residentDays / 1000) * 4.6);
const grievanceCount = 34;
const grievancesResolvedOnTime = 28;

const incident = { incidentCount, grievanceCount, grievancesResolvedOnTime };

// ---------------------------------------------------------------------
// LIFE ENRICHMENT family
// ---------------------------------------------------------------------
const participatingResidents = round0(TOTAL_OCC * 0.782);
const structuredEngagementHours = 220; // MC weekly structured hours annualized proxy

const lifeEnrichment = { participatingResidents, structuredEngagementHours };

// ---------------------------------------------------------------------
// FINANCIAL family (coa/gl/pl/budget all draw from these)
// ---------------------------------------------------------------------
const totalRevenue = 24_180_000;
const skilledRevenue = round0(totalPatientDays * 402);
const laborCost = grossWages + round0(grossWages * 0.22) + round0(grossWages * 0.081 * 1.35); // wages+benefits+agency premium
const nonLaborOpex = 6_940_000;
const operatingExpenses = laborCost + nonLaborOpex;
const operatingIncome = totalRevenue - operatingExpenses;
const priorNOI = round0(operatingIncome * 0.93);
const annualOperatingExpenses = operatingExpenses;
const annualDepreciationExpense = 1_120_000;
const accumulatedDepreciation = 14_800_000;
const totalAR = 1_640_000;
const arOver90 = round0(totalAR * 0.132);
const writeOffs = round0(totalRevenue * 0.008);
const unrestrictedCash = round0((operatingExpenses / 365) * 158);
const actualExpense = operatingExpenses;
const budgetExpense = round0(operatingExpenses * 0.955);

const financial = {
  totalRevenue,
  skilledRevenue,
  laborCost,
  operatingExpenses,
  operatingIncome,
  priorNOI,
  annualOperatingExpenses,
  annualDepreciationExpense,
  accumulatedDepreciation,
  totalAR,
  arOver90,
  writeOffs,
  unrestrictedCash,
  actualExpense,
  budgetExpense,
};

// ---------------------------------------------------------------------
// MANUAL family (operator-keyed)
// ---------------------------------------------------------------------
const manual = {
  residentSatScore: 87.6,
  familySatScore: 84.9,
  engagementScore: 3.5,
  reputationScore: 4.4,
  reviewPlatform: "Google + Caring.com (blended)",
  programmingSatScore: 85.1,
  mealSatScore: 78.4,
  grossSqFt: profile.sqft.total,
  monthlyMoveInTarget: 6,
  months: PERIOD_MONTHS,
  streetRate: 5350,
};

// ---------------------------------------------------------------------
// CMS Five-Star mock (simulates a Care Compare fetch for this SNF)
// ---------------------------------------------------------------------
const cms = {
  "SNF-2.01": { value: "6 deficiencies, highest scope/severity D", status: "watch", note: "Standard health inspection, most recent survey cycle." },
  "SNF-2.02": { value: "1 complaint deficiency, scope/severity D", status: "pass", note: "Single complaint survey deficiency in the last 24 months." },
  "SNF-2.03": { value: "1 infection-control deficiency, scope/severity E", status: "watch", note: "Focused infection control survey." },
  "SNF-2.04": { value: "0 open life-safety deficiencies", status: "pass", note: "Life Safety Code survey — clean." },
  "SNF-3.01": { value: "0.62 RN HPRD (case-mix adjusted)", status: "watch", note: "Below the ~0.68 national average." },
  "SNF-3.02": { value: "3.41 total nurse HPRD (case-mix adjusted)", status: "watch", note: "Just under the 3.6-3.8 national average band." },
  "SNF-3.03": { value: "54.2% total nursing staff turnover (PBJ)", status: "below", note: "Above the ~53.9% national average, trending worse." },
  "SNF-3.04": { value: "1 administrator departure (12 months)", status: "watch", note: "One change within the rating window." },
  "SNF-3.05": { value: "Weekend total nurse HPRD 2.61 vs weekday 3.41", status: "below", note: "23% weekend coverage gap — largest recoverable staffing point loss." },
  "SNF-4.01": { value: "15.8%", status: "pass", note: "Need for help with ADLs increased — long-stay." },
  "SNF-4.02": { value: "19.6%", status: "pass", note: "Ability to walk independently worsened — long-stay." },
  "SNF-4.03": { value: "7.4%", status: "pass", note: "Residents with pressure ulcers — long-stay." },
  "SNF-4.04": { value: "14.9%", status: "watch", note: "Antipsychotic medication use — long-stay." },
  "SNF-4.05": { value: "3.1%", status: "pass", note: "UTI — long-stay." },
  "SNF-4.06": { value: "1.6%", status: "pass", note: "Catheter inserted and left in bladder — long-stay." },
  "SNF-4.07": { value: "3.3%", status: "pass", note: "Falls with major injury — long-stay." },
  "SNF-4.08": { value: "1.58 per 1,000", status: "watch", note: "Hospitalizations per 1,000 long-stay resident days." },
  "SNF-4.09": { value: "1.05 per 1,000", status: "pass", note: "Outpatient ED visits per 1,000 long-stay resident days." },
  "SNF-5.01": { value: "21.9%", status: "watch", note: "Short-stay residents rehospitalized." },
  "SNF-5.02": { value: "10.8%", status: "pass", note: "Short-stay outpatient ED visit." },
  "SNF-5.03": { value: "1.7%", status: "pass", note: "Short-stay newly received antipsychotic." },
  "SNF-5.04": { value: "8.9%", status: "pass", note: "Short-stay moderate-to-severe pain." },
  "SNF-5.05": { value: "2.1%", status: "pass", note: "Short-stay new or worsened pressure ulcers." },
  "SNF-5.06": { value: "53.8%", status: "watch", note: "Short-stay discharged to community." },
  "SNF-5.07": { value: "0.59", status: "watch", note: "Discharge function score — short-stay." },
  "SNF-6.01": { value: "3 stars overall", status: "watch", note: "Capped by a 2-star health inspection rating." },
};

// ---------------------------------------------------------------------
// Assemble + write
// ---------------------------------------------------------------------
const operands = { census, payroll, clinical, dining, sales, plant, incident, "life-enrichment": lifeEnrichment, financial, manual };

const dataset = { profile, operands, cms, meta: { generatedAt: new Date().toISOString(), community: profile.communityName } };

const outPath = path.join(__dirname, "dataset.json");
fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2));
console.log("Wrote", outPath);
console.log("Operand key count:", Object.values(operands).reduce((n, o) => n + Object.keys(o).length, 0));
