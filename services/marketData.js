/**
 * Native Meteora market metrics for the deploy card (`MC` / `Vol 24h` / `APR`).
 *
 * **Zero I/O by design.** This module holds no endpoint, no `fetch`, no cache and
 * no timer: every number is derived from the Meteora pool object the LP menu
 * already holds in memory (pool-discovery entry or `getPoolSnapshot`). That keeps
 * the deploy card instant whatever the outside world is doing, and removes the
 * CoinGecko / DexScreener rate-limit (`HTTP 429`) failure mode completely.
 *
 * Field mapping — raw Meteora spellings first, then the `toPoolEntry` UI entries.
 * Every source key is optional and `null` when Meteora omits it:
 *
 *   | card metric      | Meteora pool keys (raw API first)                            |
 *   |------------------|--------------------------------------------------------------|
 *   | market cap / TVL | `fdv`, `market_cap`, `liquidity`, `tvl`                      |
 *   | 24 h volume      | `trade_volume_24h`, `volume24h`, `volume.h24`                |
 *   | APR              | `apr`, else `fee_tvl_ratio × 365 × 100`                      |
 *   | fee / TVL        | `feeTvl` (%), else `fee_tvl_ratio × 100`                     |
 *   | TVL              | `tvl`, `liquidity`, `activeTvl`, `active_tvl`                |
 *   | 24 h price change| `priceChange24h`, `priceChangePct`, `price_change_pct`        |
 *
 * Rendering lives in `services/telegramFormat.js`:
 *   `formatMarketMetricsLine()` → `🧢 MC: $2.49M · 📊 Vol 24h: $123.1K · 📈 APR: 245.8%`
 *   `formatMarketActivityLine()` → `🚀 Surge (High Vol)` / `📊 Active` / `📊 Vol: …`
 */


/** Finite number or `null` — `Number(null)` / `Number("")` are 0, which would fake data. */
function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveOrNull(value) {
  const n = toFiniteNumber(value);
  return n != null && n > 0 ? n : null;
}

/** First positive finite value among `keys` (Meteora has used several spellings). */
function pickNumber(source, keys = []) {
  for (const key of keys) {
    const value = positiveOrNull(source?.[key]);
    if (value != null) return value;
  }
  return null;
}

// ─── Meteora pool key spellings (raw discovery API first, UI entries after) ───
/** 24 h volume: `trade_volume_24h` (API), `volume24h` (UI entry), `volume` map/number. */
const VOLUME_KEYS = ["trade_volume_24h", "volume24h", "volume_24h", "volume_window", "volumeWindowUsd"];
/** Market cap spellings, most specific first. */
const FDV_KEYS = ["fdv", "market_cap", "marketCap", "mcap"];
/** TVL / liquidity spellings, most specific first. */
const TVL_KEYS = ["tvl", "liquidity", "activeTvl", "active_tvl"];
/** Fee/TVL already expressed as a daily percentage (the UI entries). */
const FEE_TVL_PCT_KEYS = ["feeTvl", "feeTvlPct"];
/** Fee/TVL as a daily **fraction** (raw Meteora pools: `0.0004` = 0.04 %/day). */
const FEE_TVL_RATIO_KEYS = ["fee_tvl_ratio", "fee_active_tvl_ratio"];
const APR_KEYS = ["apr", "aprPct"];
const DAYS_PER_YEAR = 365;

/** First positive number among `keys`, unwrapping nested `{ "24h": … }` maps. */
function pickNestedNumber(source, keys = []) {
  for (const key of keys) {
    const raw = source?.[key];
    if (raw && typeof raw === "object") {
      const nested = pickNumber(raw, ["24h", "h24", "1d"]);
      if (nested != null) return nested;
      continue;
    }
    const value = positiveOrNull(raw);
    if (value != null) return value;
  }
  return null;
}

/**
 * 24 h volume: `trade_volume_24h` on raw Meteora pools, `volume24h` on the UI
 * entries, else the nested `volume: { h24 | "24h": … }` map (or a flat numeric
 * `volume`). Zero / missing yields `null` — never a fabricated 0.
 */
function pickVolume24h(source) {
  return pickNumber(source, VOLUME_KEYS) ?? pickNestedNumber(source, ["volume"]);
}

/**
 * Daily fee/TVL as a **percentage**, plus the locally annualized APR.
 *
 * Raw Meteora pools report `fee_tvl_ratio` as a fraction (`0.0004` = 0.04 %/day),
 * so their APR fallback is exactly `fee_tvl_ratio × 365 × 100`. Pool entries
 * built by `toPoolEntry` / `toTokenPoolEntry` already carry `feeTvl` in percent,
 * which annualizes with a plain `× 365`.
 */
function pickFeeTvl(source) {
  const pct = pickNumber(source, FEE_TVL_PCT_KEYS);
  if (pct != null) return { pct, apr: Number((pct * DAYS_PER_YEAR).toFixed(2)) };
  const ratio = pickNestedNumber(source, FEE_TVL_RATIO_KEYS);
  if (ratio == null) return { pct: null, apr: null };
  return {
    pct: Number((ratio * 100).toFixed(4)),
    apr: Number((ratio * DAYS_PER_YEAR * 100).toFixed(2)),
  };
}

/**
 * Meteora pool object → the deploy-card market metrics.
 *
 * Pure and synchronous: the same object always yields the same numbers, and a
 * pool missing every field simply yields `null`s (the card then prints `N/A`).
 * `apr` wins when Meteora provides it; otherwise it falls back to the fee/TVL
 * annualization described in {@link pickFeeTvl} (`fee_tvl_ratio × 365 × 100`).
 *
 * @param {object|null} pool session pool entry / discovery row / pool snapshot
 * @returns {{ mcap: number|null, volume24h: number|null, apr: number|null,
 *   feeTvl: number|null, tvl: number|null, priceChange24h: number|null }}
 */
export function marketMetricsFromPool(pool = {}) {
  const safe = pool && typeof pool === "object" ? pool : {};
  const base = safe.token_x && typeof safe.token_x === "object" ? safe.token_x : {};
  const feeTvl = pickFeeTvl(safe);
  const tvl = pickNestedNumber(safe, TVL_KEYS);
  // Market cap headline: `fdv` → `market_cap` → `liquidity` → `tvl`, so a pool
  // without supply data still shows its liquidity instead of `N/A`.
  const mcap = pickNumber(safe, FDV_KEYS)
    ?? pickNumber(safe, ["liquidity"])
    ?? pickNumber(base, ["market_cap", "fdv"])
    ?? tvl;
  return {
    mcap,
    volume24h: pickVolume24h(safe),
    apr: pickNumber(safe, APR_KEYS) ?? feeTvl.apr,
    feeTvl: feeTvl.pct,
    tvl,
    priceChange24h: toFiniteNumber(
      safe.priceChange24h ?? safe.priceChangePct ?? safe.price_change_pct ?? base.price_change_pct,
    ),
  };
}

// ─── (no network layer) ───────────────────────────────────────────
// This module used to call DexScreener for MC / volume / price. Those calls are
// gone: `marketMetricsFromPool()` above is the whole public surface, so nothing
// here can block, rate-limit or fail. See `services/telegramFormat.js` for the
// rendering of these numbers.
