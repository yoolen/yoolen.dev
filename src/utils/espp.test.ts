import { describe, it, expect } from "vitest";
import {
  calcPurchasePrice,
  calcNumPeriods,
  calcNumPeriodsFromDates,
  calcShares,
  calcPriorFmvConsumed,
  calcIrsRemainingFmv,
  calcIrsMaxCost,
  calcRecommendedPct,
  calcGain,
  calcGainPct,
  calcAnnualizedGainPct,
  type PriorPeriod,
} from "./espp";

// ── calcPurchasePrice ────────────────────────────────────────────────────────

describe("calcPurchasePrice", () => {
  it("flat market, first_last lookback: 15% off start", () => {
    expect(calcPurchasePrice(100, 100, 15, "first_last")).toBeCloseTo(85);
  });

  it("rising market, first_last lookback: uses start price (lower)", () => {
    expect(calcPurchasePrice(100, 130, 15, "first_last")).toBeCloseTo(85);
  });

  it("falling market, first_last lookback: uses end price (lower)", () => {
    expect(calcPurchasePrice(100, 60, 15, "first_last")).toBeCloseTo(51);
  });

  it("no lookback: always uses end price", () => {
    expect(calcPurchasePrice(100, 80, 15, "none")).toBeCloseTo(68);
  });

  it("lowest lookback: uses lowestPrice when provided", () => {
    expect(calcPurchasePrice(100, 90, 15, "lowest", 70)).toBeCloseTo(59.5);
  });

  it("lowest lookback: falls back to min(start, end) when lowestPrice omitted", () => {
    expect(calcPurchasePrice(100, 80, 15, "lowest")).toBeCloseTo(68);
  });
});

// ── calcNumPeriods ────────────────────────────────────────────────────────────

describe("calcNumPeriods", () => {
  it("6-month biweekly = 13", () => {
    expect(calcNumPeriods(6, "biweekly")).toBe(13);
  });

  it("12-month monthly = 12", () => {
    expect(calcNumPeriods(12, "monthly")).toBe(12);
  });

  it("3-month weekly = 13", () => {
    expect(calcNumPeriods(3, "weekly")).toBe(13);
  });

  it("6-month semimonthly = 12", () => {
    expect(calcNumPeriods(6, "semimonthly")).toBe(12);
  });
});

// ── calcNumPeriodsFromDates ───────────────────────────────────────────────────

describe("calcNumPeriodsFromDates", () => {
  it("Nov 23 – May 21 biweekly = 13", () => {
    expect(calcNumPeriodsFromDates("2025-11-23", "2026-05-21", "biweekly")).toBe(13);
  });

  it("exact 6 months biweekly = 13", () => {
    expect(calcNumPeriodsFromDates("2025-01-01", "2025-07-01", "biweekly")).toBe(13);
  });

  it("exact 12 months monthly = 12", () => {
    expect(calcNumPeriodsFromDates("2025-01-01", "2026-01-01", "monthly")).toBe(12);
  });

  it("short period returns at least 1", () => {
    expect(calcNumPeriodsFromDates("2025-01-01", "2025-01-05", "biweekly")).toBe(1);
  });
});

// ── IRS cap: three example scenarios ────────────────────────────────────────

describe("IRS cap — flat market ($100 start, $100 end, 15% discount, $10k contributed)", () => {
  const startPrice = 100;
  const endPrice = 100;
  const discount = 15;
  const contributions = 10000;

  it("purchase price = $85", () => {
    expect(calcPurchasePrice(startPrice, endPrice, discount, "first_last")).toBeCloseTo(85);
  });

  it("shares ≈ 117.65", () => {
    const pp = calcPurchasePrice(startPrice, endPrice, discount, "first_last");
    expect(calcShares(contributions, pp)).toBeCloseTo(117.65, 1);
  });

  it("FMV consumed ≈ $11,765 (exact)", () => {
    const period: PriorPeriod = { contributions, endPrice };
    expect(calcPriorFmvConsumed([period], discount, startPrice, "first_last")).toBeCloseTo(11765, 0);
  });

  it("remaining cap ≈ $13,235", () => {
    const period: PriorPeriod = { contributions, endPrice };
    const fmv = calcPriorFmvConsumed([period], discount, startPrice, "first_last");
    expect(calcIrsRemainingFmv(fmv)).toBeCloseTo(13235, 0);
  });

  it("immediate gain ≈ +17.6%", () => {
    const pp = calcPurchasePrice(startPrice, endPrice, discount, "first_last");
    const shares = calcShares(contributions, pp);
    const gain = calcGain(shares, endPrice, contributions);
    expect(calcGainPct(gain, contributions)).toBeCloseTo(17.65, 1);
  });
});

describe("IRS cap — rising market ($100 start, $130 end, 15% discount, $10k contributed)", () => {
  const startPrice = 100;
  const endPrice = 130;
  const discount = 15;
  const contributions = 10000;

  it("purchase price = $85 (first_last lookback uses start, the lower price)", () => {
    expect(calcPurchasePrice(startPrice, endPrice, discount, "first_last")).toBeCloseTo(85);
  });

  it("FMV consumed ≈ $11,765 (same as flat — rising market doesn't cost more cap)", () => {
    const period: PriorPeriod = { contributions, endPrice };
    expect(calcPriorFmvConsumed([period], discount, startPrice, "first_last")).toBeCloseTo(11765, 0);
  });

  it("remaining cap ≈ $13,235 (same as flat)", () => {
    const period: PriorPeriod = { contributions, endPrice };
    const fmv = calcPriorFmvConsumed([period], discount, startPrice, "first_last");
    expect(calcIrsRemainingFmv(fmv)).toBeCloseTo(13235, 0);
  });

  it("immediate gain ≈ +52.9%", () => {
    const pp = calcPurchasePrice(startPrice, endPrice, discount, "first_last");
    const shares = calcShares(contributions, pp);
    const gain = calcGain(shares, endPrice, contributions);
    expect(calcGainPct(gain, contributions)).toBeCloseTo(52.94, 1);
  });
});

describe("IRS cap — falling market ($100 start, $60 end, 15% discount, $10k contributed)", () => {
  const startPrice = 100;
  const endPrice = 60;
  const discount = 15;
  const contributions = 10000;

  it("purchase price = $51 (first_last lookback uses end, the lower price)", () => {
    expect(calcPurchasePrice(startPrice, endPrice, discount, "first_last")).toBeCloseTo(51);
  });

  it("shares ≈ 196.1 (more shares because cheaper price)", () => {
    const pp = calcPurchasePrice(startPrice, endPrice, discount, "first_last");
    expect(calcShares(contributions, pp)).toBeCloseTo(196.1, 0);
  });

  it("immediate gain still ≈ +17.6% (discount protects you if you sell immediately)", () => {
    const pp = calcPurchasePrice(startPrice, endPrice, discount, "first_last");
    const shares = calcShares(contributions, pp);
    const gain = calcGain(shares, endPrice, contributions);
    expect(calcGainPct(gain, contributions)).toBeCloseTo(17.65, 1);
  });

  it("FMV consumed ≈ $19,608 (shares × start price)", () => {
    const period: PriorPeriod = { contributions, endPrice };
    expect(calcPriorFmvConsumed([period], discount, startPrice, "first_last")).toBeCloseTo(19608, 0);
  });

  it("remaining cap ≈ $5,392 after falling-market period", () => {
    const period: PriorPeriod = { contributions, endPrice };
    const fmv = calcPriorFmvConsumed([period], discount, startPrice, "first_last");
    expect(calcIrsRemainingFmv(fmv)).toBeCloseTo(5392, 0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("IRS cap fully exhausted by prior periods → remaining = 0", () => {
    const fmvConsumed = 30000;
    expect(calcIrsRemainingFmv(fmvConsumed)).toBe(0);
  });

  it("two prior periods each $5k flat market → combined FMV ≈ $11,765", () => {
    const periods: PriorPeriod[] = [
      { contributions: 5000, endPrice: 100 },
      { contributions: 5000, endPrice: 100 },
    ];
    expect(calcPriorFmvConsumed(periods, 15, 100, "first_last")).toBeCloseTo(11765, 0);
  });

  it("no prior periods → full $25,000 remaining", () => {
    expect(calcIrsRemainingFmv(calcPriorFmvConsumed([], 15, 100, "first_last"))).toBe(25000);
  });

  it("recommended pct is capped at 15%", () => {
    expect(calcRecommendedPct(999999, 1000, 13)).toBe(15);
  });

  it("annualized gain: 17.65% over 182 days ≈ 35.4% annualized", () => {
    expect(calcAnnualizedGainPct(17.65, 182)).toBeCloseTo(35.4, 1);
  });
});
