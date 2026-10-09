# Demo data reference — Cedar Bluff Commons

Every value needed to fill the frontend, field by field, organized by the
screen it belongs to. This is the same data baked into `Synthetic Data/*.xlsx`
and `db/004_seed_demo_community.sql` — use this page as the answer key while
clicking through the tool by hand, or to re-enter it after a "Clear all data
& uploads".

## Screen 1 — "Tell us about your community" (Profile)

Fastest path: click **"Load demo profile (Cedar Bluff Commons)"** — it fills
everything in this section automatically. Manual values below, if typing by hand:

| Field | Value |
|---|---|
| Community Name | `Cedar Bluff Commons` |
| Operator | `Cedar Bluff Senior Living Group` |
| Address | `4400 Bluff Ridge Parkway` |
| City, State, Zip | `Asheville, NC 28806` |
| Care Levels (chips) | Independent Living, Assisted Living, Memory Care, Skilled Nursing, CCRC / Life Plan |
| Operator Services (chips) | Home Health (Medicare-certified), Hospice |
| Units — IL / AL / MC / SNF | `120` / `54` / `26` / `46` |
| Gross sq ft — AL / MC / total | `42800` / `18200` / `270600` |
| Current Occupancy % | `91.1` |
| Year Opened | `1998` |
| Market radius (miles) | `15` |
| Market drive time (min) | `20` |

### Campus structure (same screen area)

| Field | Value |
|---|---|
| CCRC / Life Plan registered? | `Yes` |
| Ownership model | `Standalone` |
| Tax status | `Nonprofit` |
| Campus configuration | `Single` |
| Optional security (non-CCRC) | `No` |

### Per-care-level occupancy (used by the staffing model — not on the demo-profile button, enter if the field exists)

| Care level | Occupancy % |
|---|---|
| IL | `92.8` |
| AL | `90.7` |
| MC | `92.3` |
| SNF | `87.0` |

## Screen 2 — Reports to Run (file uploads)

Upload each file below into its matching drop zone, click **Upload &
extract**. Every value that file contains is listed underneath it, in case
you want to type it manually instead (e.g. into a differently-shaped test
file), or just to sanity-check what the extraction found.

### Census / Occupancy Report  (`01-census.xlsx` → zone "census")

| Field | Key | Value | Unit |
|---|---|---|---|
| Available/licensed units | `availableUnits` | 246 | count |
| Occupied units (by care level) | `occupiedUnits` | 224 | count |
| Census at period start | `censusStart` | 218 | count |
| Census at period end | `censusEnd` | 224 | count |
| Total residents | `totalResidents` | 224 | count |
| Memory-care residents | `mcResidents` | 24 | count |
| Resident-days in period | `residentDays` | 81760 | count |
| Total days | `totalDays` | 81760 | days |
| Total patient-days | `totalPatientDays` | 14600 | days |
| Skilled patient-days | `skilledPatientDays` | 6132 | days |
| Medicare/skilled patient-days | `skilledDays` | 6132 | days |
| Residents departed in period | `residentsDeparted` | 58 | count |
| Sum of resident tenure days (departed) | `sumResidentTenureDays` | 44080 | days |
| Patient/resident-days keyed by payer | `daysByPayer` | 14600 | days |

### Payroll, Turnover & Staffing Report  (`02-payroll.xlsx` → zone "payroll")

| Field | Key | Value | Unit |
|---|---|---|---|
| Average headcount | `avgHeadcount` | 176 | count |
| Separations (vol+invol) in period | `separations` | 79 | count |
| Total worked hours | `totalHours` | 307840 | hours |
| Overtime hours | `overtimeHours` | 20933 | hours |
| Agency/contract labor hours | `agencyHours` | 24935 | hours |
| Scheduled hours | `scheduledHours` | 286907 | hours |
| Unscheduled absence/call-off hours | `unscheduledAbsenceHours` | 12006 | hours |
| Approved positions | `approvedPositions` | 162 | count |
| Open/vacant positions | `openPositions` | 14 | count |
| Positions filled (this period) | `positionsFilled` | 46 | count |
| New hires in cohort | `newHires` | 52 | count |
| Retained at 90 days | `newHiresRetained90` | 39 | count |
| Sum of days-to-fill | `sumDaysToFill` | 2392 | days |
| Mandatory trainings required | `trainingsRequired` | 1056 | count |
| Mandatory trainings completed | `trainingsCompleted` | 1022 | count |
| Gross wages in period | `grossWages` | 8420000 | dollar |
| Workers' compensation cost in period | `wcCost` | 176820 | dollar |

### Clinical / EHR & MDS Report  (`03-clinical.xlsx` → zone "clinical")

| Field | Key | Value | Unit |
|---|---|---|---|
| Doses administered | `dosesAdministered` | 214000 | count |
| Medication administration errors | `medErrors` | 214 | count |
| Falls with major injury in period | `fallsWithMajorInjury` | 9 | count |
| New (facility-acquired) Stage 2+ pressure injuries | `newPressureInjuries` | 4 | count |
| Total residents (AL+MC+SNF) | `totalResidents` | 113 | count |
| Hospital discharges/returns in period | `hospitalDischarges` | 96 | count |
| 30-day hospital readmissions | `hospitalReadmissions30d` | 23 | count |
| UTIs in period | `utiCount` | 21 | count |
| Residents on PRN psychotropic | `residentsOnPsychotropicPRN` | 34 | count |
| Care plans due for completion/update | `carePlansDue` | 210 | count |
| Completed/updated on time | `carePlansOnTime` | 202 | count |
| MDS assessments due | `mdsTotal` | 168 | count |
| MDS assessments completed on time | `mdsOnTime` | 166 | count |
| Assessments audited | `auditedAssessments` | 60 | count |
| Assessments coded accurately | `accurateAssessments` | 57 | count |
| Elopement incidents in period | `elopementCount` | 0 | count |
| Medicare discharges | `medicareDischarges` | 44 | count |
| Sum of Medicare LOS days | `sumMedicareLOSDays` | 1188 | days |
| PDPM CMI — PT component | `cmiPT` | 1.38 | index |
| PDPM CMI — OT component | `cmiOT` | 1.34 | index |
| PDPM CMI — SLP component | `cmiSLP` | 1.16 | index |
| PDPM CMI — Nursing component | `cmiNursing` | 1.47 | index |
| PDPM CMI — NTA component | `cmiNTA` | 1.05 | index |

### Dining / Food Service Report  (`04-dining.xlsx` → zone "dining")

| Field | Key | Value | Unit |
|---|---|---|---|
| Meals served | `mealsServed` | 181507 | count |
| Raw food cost in period | `rawFoodCost` | 971064 | dollar |
| Total dining cost (food+labor+supplies) | `totalDiningCost` | 3596533 | dollar |
| Residents attending dining room | `diningRoomAttendees` | 181 | count |
| Total residents | `totalResidents` | 224 | count |
| Nutritional assessments due | `nutAssessmentsDue` | 168 | count |
| Completed on time | `nutAssessmentsCompleted` | 164 | count |
| Therapeutic diet trays served | `therapeuticDietsTotal` | 9800 | count |
| Served correctly | `therapeuticDietsCorrect` | 9645 | count |
| Special-diet meals served | `specialDietMealsServed` | 4100 | count |
| Special-diet errors | `specialDietErrors` | 9 | count |
| Residents requiring hydration monitoring | `hydrationRequired` | 62 | count |
| Monitored per protocol | `hydrationMonitored` | 59 | count |
| Residents with significant weight loss | `residentsWithWeightLoss` | 12 | count |
| Kitchen sanitation/food-safety inspection score | `sanitationScore` | 96.5 | score |

### Sales / CRM Report  (`05-sales.xlsx` → zone "sales")

| Field | Key | Value | Unit |
|---|---|---|---|
| Total leads | `totalLeads` | 612 | count |
| Leads/inquiries | `leads` | 612 | count |
| Tours conducted | `tours` | 152 | count |
| Deposits taken | `deposits` | 71 | count |
| Deposits converting to move-in | `moveInsFromDeposits` | 58 | count |
| Move-ins in period | `moveInCount` | 61 | count |
| Move-ins | `moveIns` | 61 | count |
| New move-ins in period | `newMoveIns` | 61 | count |
| Total move-outs | `totalMoveOuts` | 58 | count |
| Active leads in pipeline | `activeLeads` | 84 | count |
| Sum of achieved rate on new move-ins | `achievedRateSum` | 314150 | dollar |
| Leads keyed by source | `leadsBySource` | 612 | count |
| Move-ins keyed by source (informational) | `moveInsBySource` | 61 | count |
| Move-out counts keyed to the 4 fixed reasons | `moveOutsByReason` | 58 | count |

### Plant / Maintenance Report  (`06-plant.xlsx` → zone "plant")

| Field | Key | Value | Unit |
|---|---|---|---|
| Work orders in period | `workOrdersTotal` | 2096 | count |
| Completed within standard | `workOrdersCompletedOnTime` | 1656 | count |
| Sum of age (days) of open work orders | `sumOpenWODays` | 2882 | days |
| Open work orders | `openWOCount` | 126 | count |
| Preventive-maintenance tasks scheduled | `pmScheduled` | 587 | count |
| Completed on schedule (PM) | `pmCompletedOnTime` | 477 | count |
| Life-safety inspections required | `lifeSafetyRequired` | 6 | count |
| Inspections current/passed | `lifeSafetyCurrent` | 6 | count |
| Vehicle PM tasks scheduled | `vehiclePMScheduled` | 24 | count |
| Completed on schedule (vehicle) | `vehiclePMCompleted` | 22 | count |
| Total site energy, prior period | `energyUsagePrior` | 42400000 | kBtu |
| Total site energy, current period | `energyUsageCurrent` | 42360000 | kBtu |

### Incident & Grievance Log  (`07-incident.xlsx` → zone "incident")

| Field | Key | Value | Unit |
|---|---|---|---|
| Incident reports in period | `incidentCount` | 376 | count |
| Grievances/complaints logged | `grievanceCount` | 34 | count |
| Resolved within standard | `grievancesResolvedOnTime` | 28 | count |

### Life Enrichment / Activity Participation Report  (`08-lifeEnrichment.xlsx` → zone "lifeEnrichment")

| Field | Key | Value | Unit |
|---|---|---|---|
| Residents participating (weekly) | `participatingResidents` | 175 | count |
| Structured MC engagement hours | `structuredEngagementHours` | 220 | hours |

### General Ledger  (`09-gl.xlsx` → zone "gl")

| Field | Key | Value | Unit |
|---|---|---|---|
| Total operating revenue | `totalRevenue` | 24180000 | dollar |
| Skilled revenue | `skilledRevenue` | 5869200 | dollar |
| Total labor cost (wages+benefits+agency) | `laborCost` | 11193127 | dollar |
| Total operating expenses | `operatingExpenses` | 18133127 | dollar |
| Operating income | `operatingIncome` | 6046873 | dollar |
| Prior-period net operating income | `priorNOI` | 5623592 | dollar |
| Annual operating expenses (cash) | `annualOperatingExpenses` | 18133127 | dollar |
| Annual depreciation expense | `annualDepreciationExpense` | 1120000 | dollar |
| Accumulated depreciation (plant) | `accumulatedDepreciation` | 14800000 | dollar |
| Total A/R | `totalAR` | 1640000 | dollar |
| A/R aged > 90 days | `arOver90` | 216480 | dollar |
| Bad debt + write-offs | `writeOffs` | 193440 | dollar |
| Unrestricted cash & equivalents | `unrestrictedCash` | 7849408 | dollar |
| Actual departmental expense | `actualExpense` | 18133127 | dollar |
| Budgeted departmental expense | `budgetExpense` | 17317136 | dollar |

### Manual Entries  (`10-manual.xlsx` → zone "manual", or type into the Manual Entries form)

| Field | Key | Value | Unit |
|---|---|---|---|
| Resident satisfaction score | `residentSatScore` | 87.6 | score |
| Family satisfaction score | `familySatScore` | 84.9 | score |
| Employee engagement & satisfaction score | `engagementScore` | 3.5 | score |
| Online review rating | `reputationScore` | 4.4 | score |
| Source platform | `reviewPlatform` | Google + Caring.com (blended) | text |
| Resident satisfaction — programming | `programmingSatScore` | 85.1 | score |
| Resident meal satisfaction score | `mealSatScore` | 78.4 | score |
| Gross building area | `grossSqFt` | 270600 | sqft |
| Monthly move-in target | `monthlyMoveInTarget` | 6 | count |
| Months in period | `months` | 12 | count |
| Published street/market rate (blended) | `streetRate` | 5350 | dollar |

### Chart of Accounts  (`11-chart-of-accounts.csv` → zone "coa") — Required, not KPI-relevant

A realistic account list (account number/name/department/type), no dollar
totals — this is what a real COA export looks like. It doesn't feed any KPI
(the tool only asks it for a descriptive summary: row count, departments,
period), but the submit checklist flags it "Required" for full onboarding
readiness, so upload it to clear that item.

### Policies & Procedures  (`12-policies-procedures.txt` → zone "pp") — Required, not KPI-relevant

An 8-section sample P&P manual (admission, medication management, emergency
preparedness, infection control, resident rights, staffing/training,
incident reporting, discharge). Feeds the separate regulatory-compliance-gap
feature (`runPPCompare`), not the KPI scorecard — upload it to clear the
checklist item; it has no effect on the 97 KPI results either way.

## Screen 3 — KPI Scorecard

Nothing to fill in — but click **"Fetch from CMS Care Compare"** here to
populate the 26 CMS Five-Star measures (this is a simulated fetch, not an
upload; see `README.md` for why those are separate).

## After filling everything in

- **Computed KPIs**: 97 of 97
- **Score mix**: 36 on benchmark / 23 watch / 19 below benchmark
- **Staffing model total**: ~175.5 FTE

If your numbers differ, something didn't get captured — check the KPI
Scorecard's "Missing inputs" tile, it names exactly which fields are still
outstanding.
