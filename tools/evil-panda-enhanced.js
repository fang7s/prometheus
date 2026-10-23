// ─── Evil Panda Strategy Module ───────────────────────────────────
// Implements screening filters and technical indicator exit engine for the Evil Panda Strategy

import { log } from "../logger.js";

/**
 * Calculate RSI (Relative Strength Index)
 */
export function calculateRSI(prices, period = 2) {
  try {
    if (!prices || prices.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = prices[prices.length - i] - prices[prices.length - i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    // No movement at all is neutral (50), not overbought (100).
    if (gains === 0 && losses === 0) return 50;
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  } catch (error) {
    log("error", `Error calculating RSI: ${error.message}`);
    return null;
  }
}

/**
 * Calculate Bollinger Bands
 */
export function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  try {
    if (!prices || prices.length < period) return null;
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[prices.length - 1 - i];
    }
    const sma = sum / period;
    let squaredDeviations = 0;
    for (let i = 0; i < period; i++) {
      const deviation = prices[prices.length - 1 - i] - sma;
      squaredDeviations += deviation * deviation;
    }
    const stdDeviation = Math.sqrt(squaredDeviations / period);
    return {
      sma,
      upperBand: sma + (stdDev * stdDeviation),
      lowerBand: sma - (stdDev * stdDeviation),
      stdDeviation
    };
  } catch (error) {
    log("error", `Error calculating Bollinger Bands: ${error.message}`);
    return null;
  }
}

/**
 * Calculate MACD
 */
export function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  try {
    if (!prices || prices.length < slowPeriod + signalPeriod) return null;
    const fastEMA = calculateEMA(prices, fastPeriod);
    const slowEMA = calculateEMA(prices, slowPeriod);
    if (fastEMA.length < 1 || slowEMA.length < 1) return null;

    const macdLine = fastEMA[fastEMA.length - 1] - slowEMA[slowEMA.length - 1];
    const macdLineArray = fastEMA.slice(-signalPeriod).map((_, i) => 
      fastEMA[fastEMA.length - signalPeriod + i] - slowEMA[slowEMA.length - signalPeriod + i]
    );
    const signalLine = calculateEMA(macdLineArray, signalPeriod)[0];
    const histogram = macdLine - signalLine;

    return { macdLine, signalLine, histogram };
  } catch (error) {
    log("error", `Error calculating MACD: ${error.message}`);
    return null;
  }
}

function calculateEMA(prices, period) {
  try {
    if (!prices || prices.length < period) return [];
    const multiplier = 2 / (period + 1);
    const emaValues = [];
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[prices.length - period + i];
    }
    let ema = sum / period;
    emaValues.push(ema);
    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
      emaValues.push(ema);
    }
    return emaValues;
  } catch (error) {
    log("error", `Error calculating EMA: ${error.message}`);
    return [];
  }
}

/**
 * Evaluate Evil Panda Screening Candidate
 */
export function evaluateEvilPandaCandidate(poolData) {
  try {
    const mcap = poolData?.mcap || poolData?.marketCap || 0;
    const volume24h = poolData?.volume24h || poolData?.volume || 0;
    
    const mcapPassed = mcap >= 250000;
    const volumePassed = volume24h >= 1000000;
    const passed = mcapPassed && volumePassed;

    return {
      passed,
      mcap,
      volume24h,
      reasons: [
        mcapPassed ? "MCAP >= $250k" : `MCAP $${mcap} < $250k`,
        volumePassed ? "Vol 24h >= $1M" : `Vol 24h $${volume24h} < $1M`
      ]
    };
  } catch (error) {
    log("error", `Error evaluating Evil Panda candidate: ${error.message}`);
    return { passed: false, reasons: [error.message] };
  }
}

/**
 * Check Evil Panda Confluence Exit Conditions
 */
export function checkEvilPandaExitConfluence(prices, currentPrice) {
  try {
    if (!prices || prices.length < 35) {
      return { shouldExit: false, reason: "Insufficient price history for technical indicators" };
    }

    const rsi = calculateRSI(prices, 2);
    const bb = calculateBollingerBands(prices, 20, 2);
    const macd = calculateMACD(prices, 12, 26, 9);

    if (rsi === null || !bb || !macd) {
      return { shouldExit: false, reason: "Failed to calculate indicators" };
    }

    const rsiTriggered = rsi > 90;
    // σ=0 means a flat window where price sits exactly on both bands — never an exit.
    const bbTriggered = bb.stdDeviation > 0 && currentPrice >= bb.upperBand;
    const macdTriggered = macd.histogram > 0;

    const confluence = rsiTriggered && (bbTriggered || macdTriggered);

    return {
      shouldExit: confluence,
      rsi,
      bbUpper: bb.upperBand,
      macdHistogram: macd.histogram,
      reason: confluence 
        ? `EXIT CONFLUENCE HIT: RSI(2)=${rsi.toFixed(2)} (>90) with BB/MACD confirmation`
        : "Hold position"
    };
  } catch (error) {
    log("error", `Error checking Evil Panda exit: ${error.message}`);
    return { shouldExit: false, reason: error.message };
  }
}

/**
 * Recommended DLMM Parameters for Evil Panda
 */
export function getEvilPandaRecommendedParams() {
  return {
    strategy: "SPOT / Bid-Ask",
    bins: [80, 100, 125],
    rangeMinPercent: -94,
    rangeMaxPercent: -86
  };
}

// ─── Price series (OHLCV) for the indicator exit engine ────────────
// GeckoTerminal's public OHLCV endpoint is keyless, so the exit engine can
// build a real close-price series instead of relying on a signal snapshot.
const GECKO_API = "https://api.geckoterminal.com/api/v2";
const PRICE_SERIES_CACHE = new Map();
const PRICE_SERIES_CACHE_MAX = 200;
const MIN_CANDLES = 35; // MACD(12,26,9) needs slowPeriod + signalPeriod

function geckoOhlcvPath(timeframe) {
  const tf = String(timeframe || "5m").trim().toLowerCase();
  const unit = tf.endsWith("h") ? "hour" : "minute";
  const aggregated = parseInt(tf, 10);
  const aggregate = Number.isFinite(aggregated) && aggregated > 0 ? aggregated : (unit === "hour" ? 1 : 5);
  return { unit, aggregate };
}

/**
 * Fetch an ascending close-price series for a DLMM pool.
 * Cached per (pool, timeframe, limit) to keep the 3s poller cheap.
 * Returns null when no usable series can be built.
 */
export async function fetchPriceSeries({
  pool_address,
  timeframe = "5m",
  limit = 120,
  cacheSec = 60,
  refresh = false,
} = {}) {
  if (!pool_address) return null;

  const requestedLimit = Math.max(MIN_CANDLES, Number(limit) || 120);
  const cacheKey = `${pool_address}:${timeframe}:${requestedLimit}`;
  const now = Date.now();
  const cached = PRICE_SERIES_CACHE.get(cacheKey);
  const ttlMs = Math.max(0, Number(cacheSec) || 0) * 1000;
  if (!refresh && cached && now - cached.at < ttlMs) return cached.value;

  const { unit, aggregate } = geckoOhlcvPath(timeframe);
  const url = `${GECKO_API}/networks/solana/pools/${pool_address}/ohlcv/${unit}`
    + `?aggregate=${aggregate}&limit=${requestedLimit}`;

  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const payload = await res.json();
    const rows = payload?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty ohlcv_list");

    const candles = rows
      .map((row) => ({
        time: Number(row?.[0]),
        open: Number(row?.[1]),
        high: Number(row?.[2]),
        low: Number(row?.[3]),
        close: Number(row?.[4]),
        volume: Number(row?.[5]),
      }))
      .filter((candle) => Number.isFinite(candle.time) && Number.isFinite(candle.close) && candle.close > 0)
      .sort((a, b) => a.time - b.time);

    if (candles.length < MIN_CANDLES) {
      throw new Error(`insufficient candles (${candles.length} < ${MIN_CANDLES})`);
    }

    const value = {
      prices: candles.map((candle) => candle.close),
      candles,
      currentPrice: candles[candles.length - 1].close,
      timeframe,
      source: "geckoterminal",
      fetchedAt: new Date().toISOString(),
    };

    PRICE_SERIES_CACHE.set(cacheKey, { at: now, value });
    if (PRICE_SERIES_CACHE.size > PRICE_SERIES_CACHE_MAX) {
      const oldestKey = [...PRICE_SERIES_CACHE.entries()]
        .sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldestKey) PRICE_SERIES_CACHE.delete(oldestKey);
    }
    return value;
  } catch (error) {
    log("panda_warn", `Price series fetch failed for ${pool_address.slice(0, 8)} (${timeframe}): ${error.message}`);
    // Serve stale data rather than no data on a transient API failure.
    return cached?.value ?? null;
  }
}