-- Seed: named benchmark sources cited across the KPI catalog (reference
-- data — real source names/scope, standing in for the full published tables).
TRUNCATE benchmark_sources;

INSERT INTO benchmark_sources (match_key, source_name, applies_to, vintage, url, notes) VALUES
('SOSH', 'State of Seniors Housing (SOSH)', 'IL, AL, MC, CCRC', '2025 edition',
  'https://ashaliving.org/research-and-analytics/',
  'Occupancy, turnover, revenue/expense per occupied unit, labor % of revenue, operating margin, dietary cost per resident day, workers'' comp % of wages.'),
('CMS', 'CMS Five-Star Technical Users'' Guide / RAI Manual / 42 CFR / Life Safety Code / state regulation', 'SNF only', 'September 2026 TUG',
  'https://www.cms.gov/medicare/health-safety-standards/certification-compliance/five-star-quality-rating-system',
  'All 36 SNF Five-Star measures and cut-points, plus regulatory requirements behind assessment timeliness, care plan timeliness, grievance response, life safety, food safety, therapeutic diets, weight loss.'),
('CARF', 'CARF 2025 Financial Ratios and Trend Analysis', 'CCRC and Life Plan, entity level', '33rd edition, 2024 medians',
  'https://carf.org/wp-content/uploads/2025/10/2025FinancialRatiosTrendAnalysis.pdf',
  'Days cash on hand, debt service coverage, days in A/R, net operating margin, operating margin, average age of plant, occupancy trend by care level.'),
('RC 2025', 'Rob Clark — 2025 CCRC Performance Benchmarks (advisor internal standard)', 'CCRC and universal people measures at every care level', '2025',
  NULL,
  'Resident/family satisfaction, online review rating, staff turnover, employee satisfaction, training hours, medication accuracy, care transition, days cash, DSC, entrance-fee refund funding, resident technology use.'),
('Aline', 'Aline Sales and Marketing Benchmark Report', 'IL, AL, MC, Life Plan Residential', 'Q1 2024 edition',
  'https://alineops.com/senior-living-sales-marketing-benchmark-report-2026/',
  'Inquiries/tours/move-ins per 100 units per month; inquiry-to-tour and tour-to-move-in conversion; inquiry channel mix.'),
('Siemens', 'Siemens / Brightly Senior Living Maintenance Benchmarks', 'All care levels, campus wide', '2026 edition, 1,000+ organizations',
  'https://www.assetmanagement.siemens.com/use-cases/senior-living',
  'Work orders per resident unit, on-time completion, labor hours per resident unit, average days overdue/open, resident billings per unit.'),
('CLA', 'CLA 40th Annual SNF Report', 'SNF, financial only', '40th edition, 2025 release on FY2024 data',
  'https://www.claconnect.com/en/resources/white-papers/snf-cost-comparison-industry-trends-report',
  'SNF payer mix, revenue and expense per patient day (~11,700 CMS SNF cost reports).'),
('ENERGY STAR', 'EPA ENERGY STAR Portfolio Manager', 'All care levels', 'Senior Care Communities DataTrends',
  NULL,
  'Energy use intensity for senior care communities; median site EUI ~214 kBtu/sqft.'),
('Kushant Shah', 'Kushant Shah — internal standard', 'IL, AL, MC, SNF', NULL, NULL,
  'A/R aged over 90 days, bad debt and write-off rate, food waste rate, deposit-to-move-in conversion (joint with Rob Clark).');
