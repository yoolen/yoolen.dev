/**
 * Cloudflare Pages Function: stock price proxy
 * GET /api/stock?ticker=AAPL&date=2024-07-01  -> historical close (nearest prior trading day)
 * GET /api/stock?ticker=AAPL                   -> current price
 *
 * Uses Yahoo Finance by default (no key needed, years of history).
 * Falls back to Alpha Vantage if ALPHA_VANTAGE_KEY env var is set and Yahoo fails.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

// Walk backward from targetDate until we find a trading day in the series
function findClosestTradingDay(series, targetDate) {
  const date = new Date(targetDate + "T00:00:00Z");
  for (let i = 0; i < 10; i++) {
    const key = date.toISOString().slice(0, 10);
    if (series[key]) {
      return { price: parseFloat(series[key]["4. close"]), date: key };
    }
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return null;
}

async function fetchYahoo(ticker, date) {
  const range = date ? "5y" : "5d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("No data from Yahoo Finance");

  if (date) {
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;
    const targetTs = new Date(date + "T23:59:59Z").getTime() / 1000;

    // Find last trading day at or before the target date
    let bestIdx = -1;
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] <= targetTs) bestIdx = i;
      else break;
    }
    if (bestIdx === -1 || closes[bestIdx] == null) {
      throw new Error("No trading data found near that date");
    }
    return closes[bestIdx];
  } else {
    const price = result.meta.regularMarketPrice;
    if (!price) throw new Error("No current price from Yahoo Finance");
    return price;
  }
}

async function fetchAlphaVantage(ticker, date, key) {
  if (date) {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&apikey=${key}&outputsize=compact`;
    const data = await fetch(url).then((r) => r.json());
    const series = data["Time Series (Daily)"];
    if (!series) {
      const msg = data["Error Message"] ?? data["Note"] ?? data["Information"] ?? "Alpha Vantage returned no data";
      throw new Error(msg);
    }
    const result = findClosestTradingDay(series, date);
    if (!result) throw new Error("No trading data found near that date");
    return result.price;
  } else {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${key}`;
    const data = await fetch(url).then((r) => r.json());
    const quote = data["Global Quote"];
    if (!quote?.["05. price"]) throw new Error("Alpha Vantage returned no quote");
    return parseFloat(quote["05. price"]);
  }
}

export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker")?.toUpperCase();
  const date = searchParams.get("date") || null;

  if (!ticker) {
    return new Response(JSON.stringify({ error: "Missing ticker" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  try {
    let price;
    let source = "yahoo";

    try {
      price = await fetchYahoo(ticker, date);
    } catch (yahooErr) {
      if (env.ALPHA_VANTAGE_KEY) {
        source = "alphavantage";
        price = await fetchAlphaVantage(ticker, date, env.ALPHA_VANTAGE_KEY);
      } else {
        throw yahooErr;
      }
    }

    return new Response(JSON.stringify({ ticker, date, price, source }), {
      headers: CORS_HEADERS,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message ?? "Failed to fetch price" }),
      { status: 422, headers: CORS_HEADERS },
    );
  }
}
