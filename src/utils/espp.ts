export type PayFrequency = "weekly" | "biweekly" | "semimonthly" | "monthly";

const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

export function calcNumPeriods(
  offeringMonths: number,
  payFrequency: PayFrequency,
): number {
  return Math.round((PERIODS_PER_YEAR[payFrequency] * offeringMonths) / 12);
}

const DAYS_PER_PERIOD: Record<PayFrequency, number> = {
  weekly: 7,
  biweekly: 14,
  semimonthly: 365.25 / 24,
  monthly: 365.25 / 12,
};

export function calcNumPeriodsFromDates(
  startDate: string,
  endDate: string,
  payFrequency: PayFrequency,
): number {
  const days =
    (new Date(endDate + "T00:00:00Z").getTime() -
      new Date(startDate + "T00:00:00Z").getTime()) /
    86400000;
  return Math.max(1, Math.round(days / DAYS_PER_PERIOD[payFrequency]));
}

export function calcPurchasePrice(
  startPrice: number,
  endPrice: number,
  discountPct: number,
  lookback: boolean,
): number {
  const base = lookback ? Math.min(startPrice, endPrice) : endPrice;
  return base * (1 - discountPct / 100);
}

export function calcShares(
  totalContributions: number,
  purchasePrice: number,
): number {
  return totalContributions / purchasePrice;
}

export type PriorPeriod = {
  contributions: number;
  endPrice: number;
};

// FMV consumed = shares × startPrice = (contributions / purchasePrice) × startPrice
export function calcPriorFmvConsumed(
  periods: PriorPeriod[],
  discountPct: number,
  startPrice: number,
  lookback: boolean,
): number {
  return periods.reduce((sum, p) => {
    const pp = calcPurchasePrice(startPrice, p.endPrice, discountPct, lookback);
    return sum + calcShares(p.contributions, pp) * startPrice;
  }, 0);
}

export function calcIrsRemainingFmv(priorFmvConsumed: number): number {
  return Math.max(0, 25000 - priorFmvConsumed);
}

export function calcIrsMaxCost(
  irsRemainingFmv: number,
  startPrice: number,
  purchasePrice: number,
): number {
  const maxShares = irsRemainingFmv / startPrice;
  return maxShares * purchasePrice;
}

export function calcRecommendedPct(
  irsMaxCost: number,
  paycheckGross: number,
  numPeriods: number,
): number {
  return Math.min(15, (irsMaxCost / (paycheckGross * numPeriods)) * 100);
}

export function calcGain(
  shares: number,
  endPrice: number,
  totalContributions: number,
): number {
  return shares * endPrice - totalContributions;
}

export function calcGainPct(gain: number, totalContributions: number): number {
  return (gain / totalContributions) * 100;
}

export function calcAnnualizedGainPct(gainPct: number, days: number): number {
  return gainPct * (365.25 / days);
}
