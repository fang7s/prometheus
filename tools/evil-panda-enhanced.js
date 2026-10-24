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
// Multi-layer price data:
//   1. GeckoTerminal OHLCV (primary, keyless).
//   2. DexScreener spot price (token endpoint → pair endpoint).
//   3. DLMM active-bin spot (on-chain RPC via dlmm helpers).
// Fallback spot samples are appended to a per-pool sliding window so
// RSI/Bollinger/MACD can still be computed when OHLCV is unavailable.
const GECKO_API = "https://api.geckoterminal.com/api/v2";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const PRICE_SERIES_CACHE = new Map();
const PRICE_SERIES_CACHE_MAX = 200;
const MIN_CANDLES = 35; // MACD(12,26,9) needs slowPeriod + signalPeriod
const PRICE_BUFFER_MAX = 50;         // sliding-window cap per pool
const PRICE_BUFFER_MAX_AGE_MS = 30 * 60_000; // drop samples older than this
const STALE_SERIES_MAX_MS = 30 * 60_000;     // max age of a stale OHLCV fallback
const DEGRADED_CACHE_MS = 10_000;    // fallback re-poll window
const GECKO_COOLDOWN_MS = 60_000;    // skip GT this long after a failure
const RESOLVED_TOKEN_CACHE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

/** poolAddress -> number[] (oldest → newest, max PRICE_BUFFER_MAX) */
const inMemoryPriceBuffers = new Map();
/** poolAddress -> number[] sample timestamps (parallel to the buffer) */
const priceBufferTimes = new Map();
/** poolAddress -> source tag so incompatible price units never mix */
const priceBufferSources = new Map();
/** poolAddress -> { tokenAddress, at } */
const resolvedTokenCache = new Map();
/** poolAddress -> epoch ms until which GeckoTerminal is skipped */
const geckoCooldownUntil = new Map();
/** poolAddress -> epoch ms of the last fallback-failure log */
const spotErrorLoggedAt = new Map();

function geckoOhlcvPath(timeframe) {
  const tf = String(timeframe || "5m").trim().toLowerCase();
  const unit = tf.endsWith("h") ? "hour" : "minute";
  const aggregated = parseInt(tf, 10);
  const aggregate = Number.isFinite(aggregated) && aggregated > 0 ? aggregated : (unit === "hour" ? 1 : 5);
  return { unit, aggregate };
}

function emptySeries(timeframe) {
  return {
    prices: [],
    candles: [],
    currentPrice: null,
    timeframe,
    source: "unavailable",
    fetchedAt: new Date().toISOString(),
  };
}

function toSpotPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Snapshot of the in-memory fallback price buffer for a pool.
 * @param {string} poolAddress
 * @returns {number[]}
 */
export function getInMemoryPriceBuffer(poolAddress) {
  return [...(inMemoryPriceBuffers.get(poolAddress) || [])];
}

/**
 * Append a spot price to the pool's sliding window.
 * A source change resets the window: DexScreener USD prices and active-bin
 * tokenY-per-tokenX prices are not interchangeable, so a series is always
 * built from one consistent unit.
 */
function appendInMemoryPrice(poolAddress, price, source = "unknown") {
  const value = toSpotPrice(price);
  if (!poolAddress || value == null) return inMemoryPriceBuffers.get(poolAddress) || [];

  if (priceBufferSources.get(poolAddress) !== source) {
    inMemoryPriceBuffers.set(poolAddress, []);
    priceBufferTimes.set(poolAddress, []);
    priceBufferSources.set(poolAddress, source);
  }

  const now = Date.now();
  const buffer = inMemoryPriceBuffers.get(poolAddress) || [];
  const times = priceBufferTimes.get(poolAddress) || [];

  buffer.push(value);
  times.push(now);

  // Cap the sliding window, then drop samples older than the max age so a
  // dormant buffer can never feed hours-old prices into an auto-close.
  if (buffer.length > PRICE_BUFFER_MAX) {
    const excess = buffer.length - PRICE_BUFFER_MAX;
    buffer.splice(0, excess);
    times.splice(0, excess);
  }
  const cutoff = now - PRICE_BUFFER_MAX_AGE_MS;
  let staleCount = 0;
  while (staleCount < times.length && times[staleCount] < cutoff) staleCount++;
  if (staleCount > 0) {
    buffer.splice(0, staleCount);
    times.splice(0, staleCount);
  }

  inMemoryPriceBuffers.set(poolAddress, buffer);
  priceBufferTimes.set(poolAddress, times);
  return buffer;
}

function logSpotFailure(poolAddress, message) {
  const now = Date.now();
  if (now - (spotErrorLoggedAt.get(poolAddress) || 0) < GECKO_COOLDOWN_MS) return;
  spotErrorLoggedAt.set(poolAddress, now);
  log("panda_warn", message);
}

function cachePriceSeries(cacheKey, value, ttlMs) {
  PRICE_SERIES_CACHE.set(cacheKey, { at: Date.now(), ttlMs: Math.max(0, ttlMs), value });
  if (PRICE_SERIES_CACHE.size > PRICE_SERIES_CACHE_MAX) {
    const oldestKey = [...PRICE_SERIES_CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldestKey) PRICE_SERIES_CACHE.delete(oldestKey);
  }
}

/** Fetch JSON with a hard timeout so a slow API can't stall the 3s poller. */
async function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || FETCH_TIMEOUT_MS));
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGeckoCandles(poolAddress, timeframe, limit) {
  const { unit, aggregate } = geckoOhlcvPath(timeframe);
  const url = `${GECKO_API}/networks/solana/pools/${poolAddress}/ohlcv/${unit}`
    + `?aggregate=${aggregate}&limit=${limit}`;
  const payload = await fetchJson(url);
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
  return candles;
}

/**
 * Pick the pair that actually belongs to the pool. When a pool address is
 * supplied we require an exact pairAddress match — DexScreener's token
 * endpoint returns every pair for a token and their prices can diverge.
 */
function pickDexPair(pairs, poolAddress) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const solana = pairs.filter((pair) => !pair?.chainId || String(pair.chainId).toLowerCase() === "solana");
  const candidates = solana.length ? solana : pairs;
  const target = String(poolAddress || "").toLowerCase();
  if (target) {
    const exact = candidates.find((pair) => String(pair?.pairAddress || "").toLowerCase() === target);
    if (exact) return exact;
  }
  // With no exact pool match only a single unambiguous pair is trustworthy.
  return candidates.length === 1 ? candidates[0] : null;
}

function spotFromDexPair(pair) {
  const price = toSpotPrice(pair?.priceUsd) ?? toSpotPrice(pair?.priceNative);
  if (price == null) return null;
  return {
    price,
    source: "dexscreener",
    tokenAddress: pair?.baseToken?.address || null,
    pairAddress: pair?.pairAddress || null,
  };
}

async function fetchDexScreenerTokenSpot(tokenAddress, poolAddress) {
  const payload = await fetchJson(`${DEXSCREENER_API}/tokens/${encodeURIComponent(tokenAddress)}`);
  return spotFromDexPair(pickDexPair(payload?.pairs, poolAddress));
}

async function fetchDexScreenerPairsSpot(poolAddress) {
  const payload = await fetchJson(`${DEXSCREENER_API}/pairs/solana/${encodeURIComponent(poolAddress)}`);
  const pairs = payload?.pairs || (payload?.pair ? [payload.pair] : []);
  return spotFromDexPair(pickDexPair(pairs, poolAddress));
}

/**
 * DexScreener spot price. Uses the token endpoint when the base mint is known
 * (explicit param or previously resolved), then falls back to the pool endpoint.
 */
async function fetchDexScreenerSpot({ pool_address, token_address }) {
  const cachedToken = resolvedTokenCache.get(pool_address);
  const knownToken = token_address
    || (cachedToken && Date.now() - cachedToken.at < RESOLVED_TOKEN_CACHE_MS ? cachedToken.tokenAddress : null);

  if (knownToken) {
    try {
      const tokenSpot = await fetchDexScreenerTokenSpot(knownToken, pool_address);
      if (tokenSpot) return tokenSpot;
    } catch (error) {
      logSpotFailure(pool_address, `DexScreener token price failed for ${pool_address.slice(0, 8)}: ${error.message}`);
    }
  }

  const pairSpot = await fetchDexScreenerPairsSpot(pool_address);
  if (pairSpot?.tokenAddress) {
    resolvedTokenCache.set(pool_address, { tokenAddress: pairSpot.tokenAddress, at: Date.now() });
  }
  return pairSpot;
}

/** Tertiary fallback: on-chain active-bin price via the dlmm helpers. */
async function fetchActiveBinSpot(poolAddress) {
  try {
    const { getActiveBin } = await import("./dlmm.js");
    const active = await getActiveBin({ pool_address: poolAddress });
    const price = toSpotPrice(active?.price);
    if (price == null) return null;
    return { price, source: "active_bin" };
  } catch (error) {
    logSpotFailure(poolAddress, `Active-bin price failed for ${poolAddress.slice(0, 8)}: ${error.message}`);
    return null;
  }
}

/** Build an OHLCV-shaped series from the in-memory spot buffer. */
function buildBufferSeries(poolAddress, buffer, timeframe) {
  const now = Date.now();
  const candles = buffer.map((close, index) => ({
    time: now - (buffer.length - 1 - index) * DEGRADED_CACHE_MS,
    open: close,
    high: close,
    low: close,
    close,
    volume: null,
  }));
  return {
    prices: [...buffer],
    candles,
    currentPrice: buffer[buffer.length - 1],
    timeframe,
    source: `${priceBufferSources.get(poolAddress) || "spot"}+memory_buffer`,
    degraded: true,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch an ascending close-price series for a DLMM pool.
 * Primary: GeckoTerminal OHLCV. Fallbacks: DexScreener spot → DLMM active bin,
 * accumulated into a 50-point in-memory buffer so the indicators can still
 * compute when OHLCV is unavailable. Cached per (pool, timeframe, limit) and
 * never throws; returns { prices: [], currentPrice: null } if all sources fail.
 * @returns {Promise<{prices:number[], candles:Array, currentPrice:number|null, source:string, timeframe:string}>}
 */
export async function fetchPriceSeries({
  pool_address,
  token_address = null,
  base_mint = null,
  timeframe = "5m",
  limit = 120,
  cacheSec = 60,
  refresh = false,
} = {}) {
  if (!pool_address) return emptySeries(timeframe);

  const requestedLimit = Math.max(MIN_CANDLES, Number(limit) || 120);
  const cacheKey = `${pool_address}:${timeframe}:${requestedLimit}`;
  const now = Date.now();
  const ttlMs = Math.max(0, Number(cacheSec) || 0) * 1000;
  const cached = PRICE_SERIES_CACHE.get(cacheKey);
  if (!refresh && cached && now - cached.at < (cached.ttlMs ?? ttlMs)) return cached.value;

  // ── 1) Primary: GeckoTerminal OHLCV ─────────────────────────────
  const cooldownUntil = geckoCooldownUntil.get(pool_address) || 0;
  if (refresh || now >= cooldownUntil) {
    try {
      const candles = await fetchGeckoCandles(pool_address, timeframe, requestedLimit);
      const value = {
        prices: candles.map((candle) => candle.close),
        candles,
        currentPrice: candles[candles.length - 1].close,
        timeframe,
        source: "geckoterminal",
        fetchedAt: new Date().toISOString(),
      };
      geckoCooldownUntil.delete(pool_address);
      cachePriceSeries(cacheKey, value, ttlMs);
      return value;
    } catch (error) {
      geckoCooldownUntil.set(pool_address, Date.now() + GECKO_COOLDOWN_MS);
      logSpotFailure(
        pool_address,
        `GeckoTerminal OHLCV unavailable for ${pool_address.slice(0, 8)} (${timeframe}): ${error.message}; using spot fallback`,
      );
    }
  }

  // ── 2) Secondary: DexScreener spot ──────────────────────────────
  let spot = null;
  try {
    spot = await fetchDexScreenerSpot({
      pool_address,
      token_address: token_address || base_mint,
    });
  } catch (error) {
    logSpotFailure(pool_address, `DexScreener spot failed for ${pool_address.slice(0, 8)}: ${error.message}`);
  }

  // ── 3) Tertiary: DLMM active-bin spot ───────────────────────────
  if (!spot) spot = await fetchActiveBinSpot(pool_address);

  // ── In-memory buffer: append this spot sample, build fallback ───
  const buffer = spot
    ? appendInMemoryPrice(pool_address, spot.price, spot.source)
    : (inMemoryPriceBuffers.get(pool_address) || []);

  // A buffer that hasn't received a fresh sample recently is not a valid
  // fallback — never let dormant prices feed the exit engine.
  const bufferTimes = priceBufferTimes.get(pool_address) || [];
  const lastSampleAt = bufferTimes[bufferTimes.length - 1] || 0;
  const usableBuffer = buffer.length > 0 && now - lastSampleAt <= PRICE_BUFFER_MAX_AGE_MS
    ? buffer
    : [];

  const bufferValue = usableBuffer.length > 0 ? buildBufferSeries(pool_address, usableBuffer, timeframe) : null;
  const staleValue = cached?.value?.prices?.length
    && !cached.value.degraded
    && now - cached.at <= STALE_SERIES_MAX_MS
    ? { ...cached.value, stale: true }
    : null;

  // Prefer fresh buffer data; if it cannot yet support the indicators and a
  // usable stale OHLCV series exists, serve that instead.
  let value;
  if (bufferValue && (usableBuffer.length >= MIN_CANDLES || !staleValue)) {
    value = bufferValue;
  } else if (staleValue) {
    value = staleValue;
  } else if (bufferValue) {
    value = bufferValue;
  } else {
    value = emptySeries(timeframe);
  }

  // Re-poll fallbacks frequently so the buffer keeps filling; cache the empty
  // result too, so a total outage cannot hammer the APIs every tick.
  const degradedTtl = Math.min(ttlMs > 0 ? ttlMs : DEGRADED_CACHE_MS, DEGRADED_CACHE_MS);
  cachePriceSeries(cacheKey, value, degradedTtl);
  return value;
}