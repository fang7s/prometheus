/**
 * Native Meteora market metrics for the deploy card (`MC` / `Vol 24h` / `APR`).
 *
 * **Zero I/O by design.** This module holds no endpoint, no `fetch`, no cache and
 * no timer: every number is derived from the Meteora pool object the LP menu
 * already holds in memory (pool-discovery entry or `getPoolSnapshot`). That keeps
 * the deploy card instant whatever the outside world is doing, and removes the
 * CoinGecko / DexScreener rate-limit (`HTTP 429`) failure mode completely.
 *
 * Field mapping — every source key is optional and `null` when Meteora omits it:
 *
 *   | card metric      | Meteora pool keys                                            |
 *   |------------------|--------------------------------------------------------------|
 *   | market cap       | `mcap`, `marketCap`, `market_cap`, `fdv`                     |
 *   | 24 h volume      | `volume24h`, `volume`, `volume_window`, `volumeWindowUsd`     |
 *   | APR              | `apr`, `aprPct`, else `feeTvl × 365`                         |
 *   | fee / TVL        | `feeTvl`, `feeTvlPct`, `fee_tvl_ratio`, `fee_active_tvl_ratio`|
 *   | TVL              | `tvl`, `activeTvl`, `active_tvl`                             |
 *   | 24 h price change| `priceChange24h`, `priceChangePct`, `price_change_pct`        |
 *
 * Rendering lives in `services/telegramFormat.js`:
 *   `formatMarketMetricsLine()` → `🧢 MC: $2.49M · 📊 Vol 24h: $123.1K · 📈 APR: 245.8%`
 *   `formatMarketActivityLine()` → `🚀 Surge / High Activity` or `📊 Vol: … · TVL: …`
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

/**
 * 24 h volume: a flat `volume24h` / `volume_window` number on the UI entries, or
 * the nested `volume: { "24h": … }` map the raw discovery API returns.
 */
function pickVolume24h(source) {
  const flat = pickNumber(source, ["volume24h", "volume_window", "volumeWindowUsd"]);
  if (flat != null) return flat;
  const volume = source?.volume;
  if (volume && typeof volume === "object") {
    return positiveOrNull(volume["24h"]) ?? positiveOrNull(volume.h24);
  }
  return positiveOrNull(volume);
}

/**
 * Meteora pool object → the deploy-card market metrics.
 *
 * Pure and synchronous: the same object always yields the same numbers, and a
 * pool missing every field simply yields `null`s (the card then prints `N/A`).
 * APR falls back to `fee/TVL × 365` — the same annualization the screener uses —
 * only when Meteora did not provide an explicit `apr`.
 *
 * @param {object|null} pool session pool entry / discovery row / pool snapshot
 * @returns {{ mcap: number|null, volume24h: number|null, apr: number|null,
 *   feeTvl: number|null, tvl: number|null, priceChange24h: number|null }}
 */
export function marketMetricsFromPool(pool = {}) {
  const safe = pool && typeof pool === "object" ? pool : {};
  const base = safe.token_x && typeof safe.token_x === "object" ? safe.token_x : {};
  const feeTvl = pickNumber(safe, ["feeTvl", "feeTvlPct", "fee_tvl_ratio", "fee_active_tvl_ratio"]);
  const declaredApr = pickNumber(safe, ["apr", "aprPct"]);
  // Meteora has shipped `apr` both as a percentage and as a fraction; anything
  // below 1 is indistinguishable from a fraction, so the fee/TVL annualization
  // (the same number, computed locally) wins when it is available.
  const apr = declaredApr != null && declaredApr >= 1
    ? declaredApr
    : (feeTvl != null ? Number((feeTvl * 365).toFixed(2)) : declaredApr);
  return {
    mcap: pickNumber(safe, ["mcap", "marketCap", "market_cap", "fdv"])
      ?? pickNumber(base, ["market_cap", "fdv"]),
    volume24h: pickVolume24h(safe),
    apr,
    feeTvl,
    tvl: pickNumber(safe, ["tvl", "activeTvl", "active_tvl"]),
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
