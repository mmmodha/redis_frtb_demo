// Wave 5.20b — shared FRTB risk-class / bucket maps.
// Previously inlined in PivotPanel; lifted here so JsonExplorerPanel can
// reuse the same dropdown options without duplicating the lists.

export const RISK_CLASSES = [
  "GIRR",
  "Equity",
  "FX",
  "Commodity",
  "CSR-nonsec",
  "CSR-sec-nonctp",
  "CSR-sec-ctp",
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

export const BUCKETS_BY_RISK_CLASS: Record<string, string[]> = {
  GIRR: ["USD-IRS", "EUR-IRS", "GBP-IRS", "JPY-IRS", "CHF-IRS", "CAD-IRS", "AUD-IRS", "CNY-IRS", "HKD-IRS"],
  Equity: ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13"],
  FX: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "USDHKD"],
  Commodity: ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11"],
  "CSR-nonsec": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13", "B14", "B15", "B16"],
  "CSR-sec-nonctp": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"],
  "CSR-sec-ctp": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"],
};

export const SENSITIVITY_TYPES = ["", "Delta", "Vega", "Curvature"] as const;
