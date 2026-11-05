/**
 * Hot Fees Opportunity screener.
 *
 * Purpose: answer one question — **which Meteora DLMM pools are generating the
 * most fees right now?** — and deliver it as a scheduled Telegram digest with
 * one-tap hand-off into the existing deploy menu.
 *
 * Data sources (all read-only, no signing, no RPC):
 *   1. Meteora Pool Discovery API (`pool-discovery-api.datapi.meteora.ag`) —
 *      four server-side sorted feeds so a single ranking can't miss a pool that
 *      is hot on a different axis:
 *        · `fee_24h:desc`             → 24h fee generation
 *        · `volume_24h:desc`          → 24h volume / turnover
 *        · `fee_tvl_ratio_24h:desc`   → APR % (fee yield annualized)
 *        · `base_token_market_cap:desc` → market-cap quality
 *   2. DexScreener (`/latest/dex/pairs/solana/<pool>`) — fallback enrichment
 *      for market cap, pair age and 24h price change when Meteora omits them.
 *
 * Design invariants (see CLAUDE.md conventions):
 *   - **Non-blocking.** Every request is bounded by `AbortSignal.timeout()` *and*
 *     `withTimeout()`, fan-out is capped (4 feeds + ≤6 DexScreener lookups, 3 at
 *     a time), and the CPU work is a few dozen plain objects. Nothing in here is
 *     awaited by the 3 s PnL poller, the management cycle or the Telegram poll
 *     loop — the scheduler only *starts* the work and walks away.
 *   - **Offline-testable.** Normalization, scoring, ranking, message rendering,
 *     keyboard building and callback parsing are pure functions of plain data.
 *   - **Cache first.** A snapshot is kept in memory (`cacheTtlSec`) with
 *     single-flight de-duplication, so a Snooze/Mute re-render or a second /hot
 *     costs zero network calls. A total feed failure re-serves the last snapshot
 *     flagged `stale` instead of throwing at the operator.
 *   - **Never deploys.** `Open n` only resolves the pool address; the caller
 *     hands it to the existing deterministic deploy menu.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { withTimeout } from "../utils/timeout.js";
import { MESSAGE_LIMIT, SECTION_DIVIDER, bold, code, escapeHtml, formatCompactUsd } from "./telegramFormat.js";

// ─── Endpoints ───────────────────────────────────────────────────
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// ─── Public constants ────────────────────────────────────────────
/** Callback-data prefix for every digest button (`scr:open:1`, `scr:snooze:6`, …). */
export const SCREENER_CALLBACK_PREFIX = "scr:";
/** Hard ceiling for one digest run (fetch + render), enforced by the caller. */
export const HOT_DIGEST_TIMEOUT_MS = 15_000;
/** Default / maximum pools per digest. */
export const DEFAULT_DIGEST_LIMIT = 3;
export const MAX_DIGEST_LIMIT = 6;

// ─── Strict fee-tier / bin-step gate ─────────────────────────────
/**
 * Absolute fee-tier floor. Meteora's DLMM tiers are 0.01 / 0.05 / 0.10 / 0.25 /
 * 0.30 / 0.40 / … %, so "> 0.25 %" is the real gate: a 0.25 % pool is a
 * low-fee pool and is never "hot" for this digest. Configuring a *higher*
 * `minBaseFeePct` (default 0.30) tightens the gate further; configuring a lower
 * one can never loosen it past this hard floor.
 */
export const HARD_MIN_BASE_FEE_PCT = 0.25;
/** Default bin-step band (0.80 %–1.25 %) when config omits the bounds. */
export const DEFAULT_MIN_BIN_STEP = 80;
export const DEFAULT_MAX_BIN_STEP = 125;
/** Default base-fee floor (0.30 %) when config omits it. */
export const DEFAULT_MIN_BASE_FEE_PCT = 0.3;
/** Supported metric windows for the discovery API. */
export const HOT_TIMEFRAMES = Object.freeze(["1h", "4h", "12h", "24h"]);
/** Hours per supported metric window. */
export const TIMEFRAME_HOURS = Object.freeze({ "1h": 1, "4h": 4, "12h": 12, "24h": 24 });

/**
 * The four server-side ranked feeds that feed the digest.
 * `sort` is the discovery API sort field; `key` is what the snapshot records so
 * a pool that tops several rankings can be recognised ("hot on many axes").
 */
export const HOT_FEEDS = Object.freeze([
  { key: "fee", label: "fees", metric: "fee" },
  { key: "volume", label: "volume", metric: "volume" },
  { key: "apr", label: "APR", metric: "fee_tvl_ratio" },
  { key: "mcap", label: "market cap", metric: "base_token_market_cap" },
]);

/**
 * Resolve the discovery API sort field for a metric + window.
 *
 * The API suffixes fee/volume/ratio fields with the window (`fee_24h`,
 * `volume_1h`, `fee_tvl_ratio_12h`, …) while token attributes such as
 * `base_token_market_cap` are window-independent. Verified against the live API
 * for all four supported windows.
 *
 * @param {string} metric - base metric name (`fee`, `volume`, `fee_tvl_ratio`, …)
 * @param {string} [timeframe="24h"]
 * @returns {string} sort field, e.g. `fee_24h`
 */
export function sortFieldFor(metric, timeframe = "24h") {
  const base = String(metric ?? "fee").trim();
  if (base === "base_token_market_cap") return base;
  const window = HOT_TIMEFRAMES.includes(String(timeframe)) ? String(timeframe) : "24h";
  return `${base}_${window}`;
}

/** DexScreener lookups are capped and serialized in small batches. */
const DEX_LOOKUP_LIMIT = 6;
const DEX_CONCURRENCY = 3;
const DEX_CACHE_TTL_MS = 5 * 60_000;

// ─── Small numeric helpers ───────────────────────────────────────
function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = finite(value);
  return n != null && n > 0 ? n : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** `[A-Za-z0-9._+-]` only — keeps the digest header and button labels clean and HTML-safe. */
export function sanitizePairLabel(value) {
  const cleaned = String(value ?? "")
    .replace(/[^A-Za-z0-9._+-]/g, "")
    .trim();
  return cleaned || "?";
}

// ─── Configuration resolution ────────────────────────────────────
/**
 * Resolve the effective screener settings from `config.screener` (read lazily —
 * never captured at import time — so config reloads are honoured).
 *
 * @param {{ limit?: number, pageSize?: number, timeframe?: string }} [overrides]
 * @returns {object} normalized settings used by every function below
 */
export function getScreenerSettings(overrides = {}) {
  const s = config.screener ?? {};
  const configuredTimeframe = String(overrides.timeframe ?? s.timeframe ?? "24h").toLowerCase();
  const timeframe = HOT_TIMEFRAMES.includes(configuredTimeframe) ? configuredTimeframe : "24h";
  // Bin-step band: keep `max >= min` even when the config is inverted.
  const minBinStep = clampInt(s.minBinStep, 1, 1_000, DEFAULT_MIN_BIN_STEP);
  const maxBinStep = Math.max(minBinStep, clampInt(s.maxBinStep, 1, 1_000, DEFAULT_MAX_BIN_STEP));
  return {
    timeframe,
    windowHours: TIMEFRAME_HOURS[timeframe] ?? 24,
    limit: clampInt(overrides.limit ?? s.limit, 1, MAX_DIGEST_LIMIT, DEFAULT_DIGEST_LIMIT),
    perToken: clampInt(s.perToken, 1, 5, 1),
    pageSize: clampInt(overrides.pageSize ?? s.pageSize, 5, 100, 50),
    minTvl: Math.max(0, finite(s.minTvl) ?? 20_000),
    maxTvl: positive(s.maxTvl),
    minVolume24h: Math.max(0, finite(s.minVolume24h) ?? 25_000),
    minFee24hUsd: Math.max(0, finite(s.minFee24hUsd) ?? 100),
    minFeeTvlPct: Math.max(0, finite(s.minFeeTvlPct) ?? 0.5),
    // Strict tier / bin-step gate (see `passesFeeTierGate`).
    minBinStep,
    maxBinStep,
    minBaseFeePct: Math.max(0, finite(s.minBaseFeePct) ?? DEFAULT_MIN_BASE_FEE_PCT),
    fetchTimeoutMs: clampInt(s.fetchTimeoutMs, 500, 30_000, 6_000),
    cacheTtlMs: Math.max(0, finite(s.cacheTtlSec) ?? 300) * 1000,
    dexScreener: s.dexScreener !== false,
    snoozeHours: positive(s.snoozeHours) ?? 6,
    muteHours: positive(s.muteHours) ?? 24,
  };
}

/**
 * `filter_by` expression for the discovery API — the same `&&`-joined dialect
 * `tools/screening.js#discoverPools` uses. Server-side floors keep the payload
 * small *and* stop dust pools (a $0.00001 TVL pool with a 5×10⁹ fee/TVL ratio
 * would otherwise own the APR feed).
 */
export function buildHotFeedFilter(settings = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  const parts = [
    "pool_type=dlmm",
    "is_blacklisted=false",
    `tvl>=${Math.round(Math.max(0, finite(s.minTvl) ?? 0))}`,
    `volume>=${Math.round(Math.max(0, finite(s.minVolume24h) ?? 0))}`,
    `fee>=${Math.round(Math.max(0, finite(s.minFee24hUsd) ?? 0))}`,
    `fee_tvl_ratio>=${Math.max(0, finite(s.minFeeTvlPct) ?? 0)}`,
    // Strict fee tier + bin step, pushed down so the payload never contains a
    // pool the digest would drop anyway. The hard 0.25 % floor is used here
    // (strictly greater), while the configured `minBaseFeePct` is re-applied
    // client-side in `passesFeeTierGate`.
    `fee_pct>${HARD_MIN_BASE_FEE_PCT}`,
    `bin_step>=${clampInt(s.minBinStep, 1, 1_000, DEFAULT_MIN_BIN_STEP)}`,
    `bin_step<=${Math.max(
      clampInt(s.minBinStep, 1, 1_000, DEFAULT_MIN_BIN_STEP),
      clampInt(s.maxBinStep, 1, 1_000, DEFAULT_MAX_BIN_STEP),
    )}`,
  ];
  const maxTvl = positive(s.maxTvl);
  if (maxTvl != null) parts.push(`tvl<=${Math.round(maxTvl)}`);
  return parts.join("&&");
}

/** Build one discovery-API URL (`sort_by` is `<field>:desc`). */
export function buildHotFeedUrl({ sort, pageSize = 50, timeframe = "24h", filter = null } = {}) {
  const field = String(sort ?? sortFieldFor(HOT_FEEDS[0].metric, timeframe)).trim();
  const params = [
    `page_size=${clampInt(pageSize, 1, 100, 50)}`,
    `timeframe=${encodeURIComponent(timeframe)}`,
    `sort_by=${encodeURIComponent(`${field}:desc`)}`,
  ];
  if (filter) params.push(`filter_by=${encodeURIComponent(filter)}`);
  return `${POOL_DISCOVERY_BASE}/pools?${params.join("&")}`;
}

/** DexScreener pair URL for a Meteora pool address. */
export function buildDexScreenerUrl(poolAddress) {
  return `${DEXSCREENER_BASE}/pairs/solana/${encodeURIComponent(String(poolAddress ?? "").trim())}`;
}

// ─── Row normalization + client-side floors ──────────────────────
/**
 * Annualize a fee/TVL ratio into an APR percentage.
 *
 * The discovery API's `fee_tvl_ratio` is the yield over the *requested* window
 * (`fee_tvl_ratio` for the 24h feed means "fees ÷ TVL over 24h"), so the APR
 * depends on the window: ×365 for 24h, ×2190 for 4h, ×8760 for 1h.
 *
 * @param {number} feeTvlPct - window fee/TVL ratio in percent
 * @param {number} [windowHours=24]
 * @returns {number|null} annualized percent, or null when unavailable
 */
export function annualizeAprPct(feeTvlPct, windowHours = 24) {
  const ratio = finite(feeTvlPct);
  const hours = positive(windowHours) ?? 24;
  if (ratio == null || ratio <= 0) return null;
  return Number(((ratio * (24 * 365)) / hours).toFixed(2));
}

/**
 * Normalize one discovery-API row into a digest entry.
 *
 * The live API returns window-generic metric names (`fee`, `volume`,
 * `fee_tvl_ratio`) plus token metadata under `token_x`/`token_y`; older payloads
 * used `fee_24h`-style suffixed names. Both shapes are accepted, and any row
 * without a usable pool address is dropped.
 *
 * @param {object} row - one `data[]` element from the discovery API
 * @param {{ timeframeHours?: number }} [options]
 * @returns {object|null}
 */
export function normalizeHotPool(row, { timeframeHours = 24 } = {}) {
  if (!row || typeof row !== "object") return null;
  const pool = String(row.pool_address ?? row.address ?? row.pool ?? "").trim();
  if (!pool) return null;

  const hours = positive(timeframeHours) ?? 24;
  const feeTvlPct = finite(row.fee_tvl_ratio) ?? finite(row.fee_tvl_ratio_24h) ?? finite(row.fee_active_tvl_ratio);
  const tvl = finite(row.tvl) ?? finite(row.active_tvl);
  const base = row.token_x && typeof row.token_x === "object" ? row.token_x : {};
  const quote = row.token_y && typeof row.token_y === "object" ? row.token_y : {};
  const name = String(row.name ?? `${base.symbol ?? "?"}-${quote.symbol ?? "?"}`).trim();

  return {
    pool,
    name,
    pair: sanitizePairLabel(name),
    baseMint: base.address ?? null,
    baseSymbol: base.symbol ?? null,
    quoteMint: quote.address ?? null,
    quoteSymbol: quote.symbol ?? null,
    quoteIsSol: String(quote.address ?? "") === SOL_MINT,
    tvl,
    activeTvl: finite(row.active_tvl),
    feeWindowUsd: finite(row.fee) ?? finite(row.fee_24h),
    volumeWindowUsd: finite(row.volume) ?? finite(row.volume_24h),
    feeTvlPct,
    aprPct: annualizeAprPct(feeTvlPct, hours),
    mcap: finite(base.market_cap) ?? finite(row.base_token_market_cap),
    poolCreatedAt: finite(row.pool_created_at) ?? finite(row.created_at),
    // Fee tier + bin step drive the strict gate, so accept the flattened and the
    // nested spellings the discovery API has used over time.
    feePct: finite(row.fee_pct) ?? finite(row.base_fee_pct),
    binStep: finite(row.dlmm_params?.bin_step) ?? finite(row.bin_step),
    holders: finite(row.base_token_holders) ?? finite(base.holders),
    priceChangePct: finite(row.price_change_pct) ?? finite(base.price_change_pct),
    launchpad: row.launchpad ?? null,
    timeframeHours: hours,
  };
}

/**
 * Strict fee-tier + bin-step gate.
 *
 * Rules (all mandatory):
 *   1. base fee must be **> 0.25 %** — 0.01/0.05/0.10/0.25 % tiers are excluded;
 *   2. base fee must be **>= `minBaseFeePct`** (config default 0.30 %);
 *   3. `bin_step` must be inside the configured band (default 80–125).
 *
 * Both attributes are treated as mandatory: a pool whose fee tier or bin step is
 * unknown cannot be proven to clear the gate, so it is dropped. That is the
 * "strict" contract — the digest must never advertise a low-fee or odd-bin-step
 * pool because the feed omitted a field.
 *
 * @param {object} pool - normalized digest entry (`feePct`, `binStep`)
 * @param {object} [settings] - resolved screener settings
 * @returns {boolean} true only when the pool clears the tier + bin-step gate
 */
export function passesFeeTierGate(pool, settings = {}) {
  if (!pool || typeof pool !== "object") return false;
  const s = settings && typeof settings === "object" ? settings : {};
  const feePct = finite(pool.feePct);
  const binStep = finite(pool.binStep);
  if (feePct == null || binStep == null) return false;

  // 1) Hard tier floor — anything at or below 0.25 % is a low-fee pool.
  if (feePct <= HARD_MIN_BASE_FEE_PCT) return false;
  // 2) Configured floor (default 0.30 %); a config below 0.25 % cannot loosen it.
  const minBaseFeePct = Math.max(0, finite(s.minBaseFeePct) ?? DEFAULT_MIN_BASE_FEE_PCT);
  if (feePct < minBaseFeePct) return false;
  // 3) Bin-step band.
  const minBinStep = clampInt(s.minBinStep, 1, 1_000, DEFAULT_MIN_BIN_STEP);
  const maxBinStep = Math.max(minBinStep, clampInt(s.maxBinStep, 1, 1_000, DEFAULT_MAX_BIN_STEP));
  if (binStep < minBinStep || binStep > maxBinStep) return false;
  return true;
}

/**
 * Client-side floors — a safety net on top of the server-side `filter_by`.
 * Keeps a pool whose TVL/volume/fees/ratio fall below the configured minimums
 * out of the digest even when the API ignored part of the filter expression.
 * The strict fee-tier/bin-step gate runs first so a low-fee pool can never be
 * rescued by a strong fee/TVL ratio.
 *
 * @param {object} pool - normalized digest entry
 * @param {object} [settings]
 * @returns {boolean}
 */
export function passesDigestFloors(pool, settings = {}) {
  if (!pool?.pool) return false;
  const s = settings && typeof settings === "object" ? settings : {};
  if (!passesFeeTierGate(pool, s)) return false;
  const minTvl = Math.max(0, finite(s.minTvl) ?? 0);
  const maxTvl = positive(s.maxTvl);
  const minVolume = Math.max(0, finite(s.minVolume24h) ?? 0);
  const minFee = Math.max(0, finite(s.minFee24hUsd) ?? 0);
  const minFeeTvl = Math.max(0, finite(s.minFeeTvlPct) ?? 0);

  const tvl = finite(pool.tvl) ?? finite(pool.activeTvl);
  if (tvl != null) {
    if (tvl < minTvl) return false;
    if (maxTvl != null && tvl > maxTvl) return false;
  } else if (minTvl > 0) {
    return false;
  }
  if ((finite(pool.volumeWindowUsd) ?? 0) < minVolume) return false;
  if ((finite(pool.feeWindowUsd) ?? 0) < minFee) return false;
  if ((finite(pool.feeTvlPct) ?? 0) < minFeeTvl) return false;
  return true;
}

// ─── Network ─────────────────────────────────────────────────────
/**
 * GET JSON with a hard deadline.
 *
 * Two independent guards: `AbortSignal.timeout()` tears the socket down (so the
 * request can't keep a handle on the loop) and {@link withTimeout} rejects the
 * awaited promise even if the abort is ignored. Failures are *thrown* so the
 * caller can decide between "retry next cycle" and "serve the stale snapshot".
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, { timeoutMs = 6_000, label = "screener fetch" } = {}) {
  const ms = Math.max(500, Number(timeoutMs) || 6_000);
  const request = fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  const res = await withTimeout(request, ms + 500, label);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
  }
  return res.json();
}

/**
 * Fetch and normalize ONE ranked feed. A pool already seen in an earlier feed is
 * *merged* (the later feed only fills gaps and records the axis), so the digest
 * can tell "hot on 4 axes" from "spiked on fees once".
 *
 * @returns {Promise<{ feed: string, pools: object[], error: string|null }>}
 */
export async function fetchHotFeed(feed, settings = {}, { fetchImpl = fetchJson } = {}) {
  const def = HOT_FEEDS.find((entry) => entry.key === feed?.key) ?? HOT_FEEDS[0];
  const s = settings && typeof settings === "object" ? settings : {};
  const url = buildHotFeedUrl({
    // The discovery API suffixes metric fields with the window (`fee_24h`,
    // `volume_1h`, …), so the sort field is resolved per feed *and* timeframe.
    sort: sortFieldFor(def.metric, s.timeframe),
    pageSize: s.pageSize,
    timeframe: s.timeframe,
    filter: buildHotFeedFilter(s),
  });
  try {
    const payload = await fetchImpl(url, {
      timeoutMs: s.fetchTimeoutMs,
      label: `hot ${def.label}`,
    });
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const pools = rows
      .map((row) => normalizeHotPool(row, { timeframeHours: s.windowHours }))
      .filter(Boolean)
      .map((pool, position) => ({ ...pool, feeds: [def.key], feedPosition: position }));
    return { feed: def.key, pools, error: null };
  } catch (error) {
    return { feed: def.key, pools: [], error: error?.message || String(error) };
  }
}

// ─── Ranking ─────────────────────────────────────────────────────
/**
 * Weight of each ranked axis in the composite "Hot Fees" score.
 * Fees dominate (that *is* the question), volume proves the fees are real,
 * APR measures LP yield per dollar and market cap measures survivability.
 */
export const HOT_SCORE_WEIGHTS = Object.freeze({
  fee: 0.4,
  volume: 0.2,
  apr: 0.25,
  mcap: 0.15,
});

/** Saturation targets — a metric at or above its target earns a full sub-score. */
export const HOT_SCORE_TARGETS = Object.freeze({
  fee: 5_000,          // $5k of 24h fees
  volume: 1_000_000,   // $1M 24h volume
  apr: 300,            // 300 % APR
  mcap: 50_000_000,    // $50M market cap
});

/** Coverage bonus: every additional axis a pool appears on, up to +15. */
export const HOT_FEED_COVERAGE_BONUS = 5;
export const HOT_FEED_COVERAGE_MAX = 15;

/** Saturating 0..1 ratio — log-scaled so a 10× metric never swamps the blend. */
function saturate(value, target) {
  const v = Math.max(0, finite(value) ?? 0);
  const t = positive(target);
  if (t == null) return 0;
  if (v <= 0) return 0;
  if (v >= t) return 1;
  return Math.log10(1 + v) / Math.log10(1 + t);
}

/**
 * Composite Hot Fees score (0..100).
 *
 * Deterministic and pure: same pool in → same score out. The multi-axis bonus
 * rewards pools that rank on several feeds at once, which is what "hot right
 * now" actually means (fees + volume + APR together, not a single spike).
 *
 * @param {object} pool - normalized digest entry
 * @returns {number} 0..100, two decimals
 */
export function computeHotScore(pool) {
  if (!pool || typeof pool !== "object") return 0;
  const base =
    HOT_SCORE_WEIGHTS.fee * saturate(pool.feeWindowUsd, HOT_SCORE_TARGETS.fee) +
    HOT_SCORE_WEIGHTS.volume * saturate(pool.volumeWindowUsd, HOT_SCORE_TARGETS.volume) +
    HOT_SCORE_WEIGHTS.apr * saturate(pool.aprPct, HOT_SCORE_TARGETS.apr) +
    HOT_SCORE_WEIGHTS.mcap * saturate(pool.mcap, HOT_SCORE_TARGETS.mcap);

  const feeds = Array.isArray(pool.feeds) ? pool.feeds.length : 0;
  const bonus = Math.min(HOT_FEED_COVERAGE_MAX, Math.max(0, feeds - 1) * HOT_FEED_COVERAGE_BONUS);
  return Number(Math.min(100, base * 100 + bonus).toFixed(2));
}

/** Fill missing fields on `existing` from a duplicate row without overwriting data. */
function mergePoolRows(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "feeds") continue;
    if (merged[key] == null && value != null) merged[key] = value;
  }
  const feeds = new Set([...(existing.feeds ?? []), ...(incoming.feeds ?? [])]);
  merged.feeds = HOT_FEEDS.filter((feed) => feeds.has(feed.key)).map((feed) => feed.key);
  merged.feedCount = merged.feeds.length;
  // Keep the best (lowest) feed position so "topped the fee ranking" is visible.
  const positions = [existing.feedPosition, incoming.feedPosition].filter((n) => Number.isFinite(n));
  merged.feedPosition = positions.length ? Math.min(...positions) : null;
  return merged;
}

/**
 * Merge every feed into one ranked candidate list.
 *
 * Steps: normalize → dedupe/merge by pool address → apply client-side floors →
 * score → sort (score desc, then 24h fees desc, then volume desc) → cap per base
 * mint → slice to `limit`.
 *
 * @param {Array<{ feed: string, pools: object[], error: string|null }>} feedResults
 * @param {object} [settings]
 * @returns {{ pools: object[], feedErrors: string[], scanned: number }}
 */
export function rankHotPools(feedResults = [], settings = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  const byAddress = new Map();
  const feedErrors = [];
  let scanned = 0;

  for (const result of Array.isArray(feedResults) ? feedResults : []) {
    if (result?.error) feedErrors.push(`${result.feed}: ${result.error}`);
    for (const pool of Array.isArray(result?.pools) ? result.pools : []) {
      scanned += 1;
      const key = pool.pool;
      byAddress.set(key, byAddress.has(key) ? mergePoolRows(byAddress.get(key), pool) : { ...pool });
    }
  }

  const scored = [...byAddress.values()]
    .filter((pool) => passesDigestFloors(pool, s))
    .map((pool) => ({ ...pool, score: computeHotScore(pool) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const feeDelta = (finite(b.feeWindowUsd) ?? 0) - (finite(a.feeWindowUsd) ?? 0);
      if (feeDelta !== 0) return feeDelta;
      return (finite(b.volumeWindowUsd) ?? 0) - (finite(a.volumeWindowUsd) ?? 0);
    });

  // Cap per base mint so one hot token cannot own every slot.
  const perToken = clampInt(s.perToken, 1, 5, 1);
  const perMintCount = new Map();
  const limited = [];
  for (const pool of scored) {
    const mint = String(pool.baseMint ?? pool.baseSymbol ?? pool.pool);
    const count = perMintCount.get(mint) ?? 0;
    if (count >= perToken) continue;
    perMintCount.set(mint, count + 1);
    limited.push(pool);
  }

  const limit = clampInt(s.limit, 1, MAX_DIGEST_LIMIT, DEFAULT_DIGEST_LIMIT);
  const pools = limited.slice(0, limit).map((pool, index) => ({ ...pool, index: index + 1 }));
  return { pools, feedErrors, scanned };
}

// ─── DexScreener enrichment (fallback only) ──────────────────────
const _dexCache = new Map(); // pool address -> { at, pair }

/**
 * Fetch one DexScreener pair with a short-lived cache. Never throws: enrichment
 * is optional, so a rate-limited or missing pair simply leaves the Meteora
 * values in place.
 */
export async function fetchDexScreenerPair(poolAddress, { timeoutMs = 4_000, now = Date.now(), fetchImpl = fetchJson } = {}) {
  const address = String(poolAddress ?? "").trim();
  if (!address) return null;
  const cached = _dexCache.get(address);
  if (cached && now - cached.at < DEX_CACHE_TTL_MS) return cached.pair;

  try {
    const payload = await fetchImpl(buildDexScreenerUrl(address), {
      timeoutMs,
      label: "dexscreener pair",
    });
    const pair = Array.isArray(payload?.pairs)
      ? payload.pairs.find((entry) => String(entry?.pairAddress ?? "") === address) ?? payload.pairs[0] ?? null
      : null;
    _dexCache.set(address, { at: now, pair });
    // Bound the cache: enrichment is best-effort, never a memory leak.
    if (_dexCache.size > 200) {
      const oldest = [..._dexCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      for (const [key] of oldest) _dexCache.delete(key);
    }
    return pair;
  } catch (error) {
    log("screener_warn", `DexScreener enrichment failed for ${address.slice(0, 8)}: ${error?.message || error}`);
    return null;
  }
}

/**
 * Fill gaps (market cap, pair age, 24h price change) from DexScreener.
 * Only the top `DEX_LOOKUP_LIMIT` pools are looked up, `DEX_CONCURRENCY` at a
 * time — the digest must never fan out into dozens of requests.
 *
 * @returns {Promise<object[]>} pools (same order) with `dexScreener: true` when enriched
 */
export async function enrichWithDexScreener(pools = [], settings = {}, { now = Date.now(), fetchImpl = fetchJson } = {}) {
  const list = (Array.isArray(pools) ? pools : []).map((pool) => ({ ...pool }));
  if (settings?.dexScreener === false) return list;

  const targets = list.filter((pool) => pool?.pool).slice(0, DEX_LOOKUP_LIMIT);
  for (let i = 0; i < targets.length; i += DEX_CONCURRENCY) {
    const batch = targets.slice(i, i + DEX_CONCURRENCY);
    const pairs = await Promise.all(
      batch.map((pool) =>
        fetchDexScreenerPair(pool.pool, { timeoutMs: settings?.fetchTimeoutMs, now, fetchImpl }),
      ),
    );
    batch.forEach((pool, offset) => {
      const pair = pairs[offset];
      if (!pair) return;
      const target = list.find((entry) => entry.pool === pool.pool);
      if (!target) return;
      target.dexScreener = true;
      target.mcap = target.mcap ?? finite(pair.marketCap) ?? finite(pair.fdv);
      target.dexLiquidity = finite(pair.liquidity?.usd);
      target.priceChangePct = target.priceChangePct ?? finite(pair.priceChange?.h24);
      target.dexVolume24h = finite(pair.volume?.h24);
      const createdAt = finite(pair.pairCreatedAt);
      // DexScreener's `pairCreatedAt` is epoch **milliseconds**; Meteora's is too.
      if (target.poolCreatedAt == null && createdAt != null && createdAt > 1e12) target.poolCreatedAt = createdAt;
      if (target.volumeWindowUsd == null && target.dexVolume24h != null) target.volumeWindowUsd = target.dexVolume24h;
      // Re-score: market cap and volume may have just become known.
      target.score = computeHotScore(target);
    });
  }
  return list;
}

// ─── Snapshot cache + single flight ──────────────────────────────
/**
 * The digest snapshot is cached in memory so a Snooze/Mute re-render, a second
 * `/hot`, or a button press costs zero network calls. `_inflight` de-duplicates
 * concurrent runs: two triggers arriving together share one fetch.
 */
const _cache = { snapshot: null, at: 0, key: null };
let _inflight = null;
/** Last successful snapshot regardless of TTL — the stale fallback and the source for `scr:open:<n>`. */
let _lastSnapshot = null;

/** The most recent snapshot (fresh or stale) — used to resolve `Open <n>` indices. */
export function getLastSnapshot() {
  return _lastSnapshot;
}

/** Resolve a 1-based digest index to its pool entry. */
export function resolveHotPool(index, snapshot = _lastSnapshot) {
  const n = Number(index);
  if (!Number.isFinite(n) || n < 1) return null;
  const pools = Array.isArray(snapshot?.pools) ? snapshot.pools : [];
  return pools.find((pool) => pool.index === n) ?? pools[n - 1] ?? null;
}

/** Drop the cached snapshot (used by `🔄 Refresh` and tests). */
export function invalidateHotDigest() {
  _cache.snapshot = null;
  _cache.at = 0;
  _cache.key = null;
}

// ─── Snooze / mute (in-memory, cleared on restart) ───────────────
/**
 * Per-process suppression state. Deliberately NOT persisted: a restart is an
 * explicit operator action, so it should never inherit a stale "muted forever"
 * flag. `/hot` and `🔄 Refresh` always bypass suppression — only the *automatic*
 * broadcast is silenced.
 */
const _suppression = { until: 0, mode: null, hours: null, setAt: null };

/** Silence automatic digests for `hours` (`mode: "snooze" | "mute"`). */
export function suppressDigest(hours, mode = "snooze", { now = Date.now() } = {}) {
  const h = Math.max(0.1, Number(hours) || 0);
  _suppression.until = now + h * 3_600_000;
  _suppression.mode = mode === "mute" ? "mute" : "snooze";
  _suppression.hours = h;
  _suppression.setAt = now;
  log("screener", `Hot Fees digest ${_suppression.mode}d for ${h}h`);
  return getSuppressionState({ now });
}

/** Current suppression state (`active`, `until`, `mode`, `hours`). */
export function getSuppressionState({ now = Date.now() } = {}) {
  const active = _suppression.until > now;
  return {
    active,
    mode: active ? _suppression.mode : null,
    hours: active ? _suppression.hours : null,
    until: active ? _suppression.until : null,
    minutesLeft: active ? Math.max(0, Math.ceil((_suppression.until - now) / 60_000)) : 0,
  };
}

/** True when the automatic digest should stay quiet right now. */
export function isDigestSuppressed({ now = Date.now() } = {}) {
  return getSuppressionState({ now }).active;
}

/** Clear snooze/mute immediately. */
export function clearDigestSuppression() {
  _suppression.until = 0;
  _suppression.mode = null;
  _suppression.hours = null;
  _suppression.setAt = null;
  return getSuppressionState();
}

/** Test seam: reset every module-level cache and suppression flag. */
export function resetScreenerState() {
  _cache.snapshot = null;
  _cache.at = 0;
  _cache.key = null;
  _inflight = null;
  _lastSnapshot = null;
  _dexCache.clear();
  _suppression.until = 0;
  _suppression.mode = null;
  _suppression.hours = null;
  _suppression.setAt = null;
}

// ─── Orchestration ───────────────────────────────────────────────
/** Cache fingerprint — one snapshot per distinct settings combination. */
function cacheKeyFor(settings) {
  return [
    settings.timeframe,
    settings.limit,
    settings.pageSize,
    settings.perToken,
    settings.minTvl,
    settings.maxTvl ?? "-",
    settings.minVolume24h,
    settings.minFee24hUsd,
    settings.minFeeTvlPct,
    // Strict gate settings — a change must invalidate the cached snapshot.
    settings.minBinStep,
    settings.maxBinStep,
    settings.minBaseFeePct,
    settings.dexScreener ? "dex" : "nodex",
  ].join("|");
}

/**
 * Fetch every ranked feed in parallel, merge, rank and enrich.
 * Rejects only when *all four* feeds fail — a partial payload is still a digest.
 *
 * @returns {Promise<{ pools: object[], feedErrors: string[], scanned: number }>}
 */
export async function collectHotPools(settings, { fetchImpl = fetchJson } = {}) {
  const results = await Promise.all(
    HOT_FEEDS.map((feed) => fetchHotFeed(feed, settings, { fetchImpl })),
  );
  const ok = results.filter((result) => !result.error);
  if (ok.length === 0) {
    const reason = results.map((result) => `${result.feed}: ${result.error}`).join("; ");
    throw new Error(`every hot feed failed (${reason})`);
  }

  const ranked = rankHotPools(results, settings);
  const pools = ranked.pools.length > 0 ? await enrichWithDexScreener(ranked.pools, settings, { fetchImpl }) : [];
  // Enrichment can change the score (market cap / volume gaps filled), so keep
  // the published order consistent with the published score.
  pools.sort((a, b) => {
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    return (finite(b.feeWindowUsd) ?? 0) - (finite(a.feeWindowUsd) ?? 0);
  });
  const ordered = pools.map((pool, index) => ({ ...pool, index: index + 1 }));
  return { pools: ordered, feedErrors: ranked.feedErrors, scanned: ranked.scanned };
}

/**
 * Public entry point — the Hot Fees snapshot.
 *
 * Contract:
 *   - returns the cached snapshot while it is younger than `cacheTtlMs`;
 *   - otherwise fetches once (single flight) and refreshes the cache;
 *   - if every feed fails, returns the last good snapshot flagged `stale: true`
 *     (and never throws when a previous snapshot exists) so the operator always
 *     gets *something*.
 *
 * @param {{ force?: boolean, limit?: number, timeframe?: string, now?: number, fetchImpl?: Function }} [options]
 * @returns {Promise<{ pools: object[], updatedAt: string|null, timeframe: string, windowHours: number, limit: number, scanned: number, feedErrors: string[], stale: boolean, source: string }>}
 */
export async function getHotDigest({ force = false, limit, timeframe, now = Date.now(), fetchImpl = fetchJson } = {}) {
  const settings = getScreenerSettings({ limit, timeframe });
  const key = cacheKeyFor(settings);

  if (!force && _cache.snapshot && _cache.key === key && now - _cache.at < settings.cacheTtlMs) {
    return { ..._cache.snapshot, source: "cache" };
  }
  if (_inflight && _inflight.key === key) return _inflight.promise;

  const run = (async () => {
    try {
      const { pools, feedErrors, scanned } = await collectHotPools(settings, { fetchImpl });
      const snapshot = {
        pools,
        updatedAt: new Date(now).toISOString(),
        timeframe: settings.timeframe,
        windowHours: settings.windowHours,
        limit: settings.limit,
        scanned,
        feedErrors,
        stale: false,
        source: "meteora",
      };
      _cache.snapshot = snapshot;
      _cache.at = now;
      _cache.key = key;
      _lastSnapshot = snapshot;
      log(
        "screener",
        `Hot Fees digest refreshed — ${pools.length} pool(s) from ${scanned} row(s)` +
          (feedErrors.length ? ` | ${feedErrors.length} feed error(s)` : ""),
      );
      return snapshot;
    } catch (error) {
      if (_lastSnapshot) {
        log("screener_warn", `Hot Fees refresh failed (${error?.message || error}) — serving stale snapshot`);
        return { ..._lastSnapshot, stale: true, source: "stale-cache", feedErrors: [...(_lastSnapshot.feedErrors ?? []), String(error?.message || error)] };
      }
      throw error;
    }
  })();

  _inflight = { key, promise: run };
  try {
    return await run;
  } finally {
    if (_inflight?.promise === run) _inflight = null;
  }
}

// ─── Formatting (pure) ───────────────────────────────────────────
/** `12m` / `5.9h` / `3d` — compact pair age; `?` when the pool has no timestamp. */
export function formatPairAge(poolCreatedAt, { now = Date.now() } = {}) {
  const created = finite(poolCreatedAt);
  if (created == null || created <= 0) return "?";
  // Meteora returns epoch ms; tolerate a seconds timestamp as well.
  const ms = created > 1e12 ? created : created * 1000;
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  // One decimal for hours (`5.9h`) — a pool that is hours old is still "new",
  // so the digit carries real signal. Floored to 0.1 h (so 23.98 h never reads
  // "24h") and whole hours stay short (`2h`, not `2.0h`).
  if (minutes < 24 * 60) return `${(Math.floor(minutes / 6) / 10).toFixed(1).replace(/\.0$/, "")}h`;
  const days = Math.floor(minutes / (24 * 60));
  if (days < 1000) return `${days}d`;
  return "999d+";
}

/** `21900%` / `1.2K%` — compact APR percentage. */
export function formatApr(aprPct) {
  const n = finite(aprPct);
  if (n == null || n <= 0) return "?";
  if (n >= 10_000) return `${Math.round(n / 1000)}K%`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K%`;
  return `${Math.round(n)}%`;
}

// ─── Deep links (Meteora · GMGN) ─────────────────────────────────
/**
 * `https://app.meteora.ag/pools/<pool_address>` — the Meteora LP page.
 *
 * The address is percent-encoded, so a malformed feed value can never break out
 * of the `href` attribute (Telegram parses our HTML).
 *
 * @param {string} poolAddress - Meteora DLMM pool address
 * @returns {string|null} link, or null when the address is missing
 */
export function buildMeteoraPoolUrl(poolAddress) {
  const address = String(poolAddress ?? "").trim();
  return address ? `https://app.meteora.ag/pools/${encodeURIComponent(address)}` : null;
}

/**
 * `https://gmgn.ai/sol/token/<mint_or_pool>` — GMGN chart for the pool's token.
 *
 * @param {string} mintOrPool - base-token mint (falls back to the pool address)
 * @returns {string|null} link, or null when the address is missing
 */
export function buildGmgnTokenUrl(mintOrPool) {
  const address = String(mintOrPool ?? "").trim();
  return address ? `https://gmgn.ai/sol/token/${encodeURIComponent(address)}` : null;
}

/** `<a href="…">label</a>` — both sides escaped so a symbol can't break the markup. */
function digestLink(label, url) {
  if (!url) return null;
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/**
 * One digest candidate as an itemized block (clean list layout, no ASCII table):
 *
 *   <b>1. AMD-SOL</b>
 *   📈 APR <code>196K%</code> · 💧 TVL <code>$62.0K</code> · 💸 Fees 24h <code>$33.3K</code>
 *   🧢 MC <code>$558.6K</code> · ⏱️ Age <code>5.9h</code>
 *   <code>3uijTWAzhQKnqZ59Wwgay7sccFWAk5reEibKg2ZRAGZ9</code>
 *   🌊 <a href="https://app.meteora.ag/pools/…">Meteora</a> · 👁️ <a href="https://gmgn.ai/sol/token/…">GMGN</a>
 *
 * Every interpolated value goes through {@link code} / {@link bold} /
 * {@link escapeHtml}, so a symbol containing `&`, `<` or `>` renders verbatim
 * instead of being parsed as markup.
 *
 * @param {object} pool - normalized digest entry
 * @param {{ now?: number, windowLabel?: string }} [options] - windowLabel labels the fee column
 * @returns {string|null} HTML block, or null when there is no usable pool
 */
export function formatHotDigestPoolBlock(pool, { now = Date.now(), windowLabel = "24h" } = {}) {
  if (!pool || typeof pool !== "object") return null;
  const window = HOT_TIMEFRAMES.includes(String(windowLabel)) ? String(windowLabel) : "24h";
  const label = String(pool.name ?? pool.pair ?? "").trim() || "unknown pool";
  const index = Number.isFinite(Number(pool.index)) ? Number(pool.index) : null;
  const address = String(pool.pool ?? "").trim();

  const lines = [`<b>${escapeHtml(`${index != null ? `${index}. ` : ""}${label}`)}</b>`];
  lines.push(
    [
      `📈 APR ${code(formatApr(pool.aprPct))}`,
      `💧 TVL ${code(formatCompactUsd(pool.tvl ?? pool.activeTvl) ?? "?")}`,
      `💸 Fees ${escapeHtml(window)} ${code(formatCompactUsd(pool.feeWindowUsd) ?? "?")}`,
    ].join(" · "),
  );
  lines.push(
    [`🧢 MC ${code(formatCompactUsd(pool.mcap) ?? "?")}`, `⏱️ Age ${code(formatPairAge(pool.poolCreatedAt, { now }))}`].join(
      " · ",
    ),
  );
  if (address) lines.push(code(address));

  // Direct deep links — one tap into Meteora or the GMGN chart.
  const links = [];
  const meteora = digestLink("Meteora", buildMeteoraPoolUrl(address));
  if (meteora) links.push(`🌊 ${meteora}`);
  const gmgn = digestLink("GMGN", buildGmgnTokenUrl(pool.baseMint ?? address));
  if (gmgn) links.push(`👁️ ${gmgn}`);
  if (links.length > 0) lines.push(links.join(" · "));

  return lines.join("\n");
}

/** `12:34 UTC` — short, timezone-stable stamp for the digest header. */
export function formatDigestStamp(isoOrMs = Date.now()) {
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(String(isoOrMs ?? ""));
  const when = Number.isFinite(ms) ? new Date(ms) : new Date();
  const hh = String(when.getUTCHours()).padStart(2, "0");
  const mm = String(when.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/** Human label for the suppression window (`😴 Snoozed 6h — 214 min left`). */
export function describeSuppression(state = getSuppressionState()) {
  if (!state?.active) return null;
  const icon = state.mode === "mute" ? "🔕" : "😴";
  const label = state.mode === "mute" ? "Muted" : "Snoozed";
  const hours = Number.isFinite(state.hours) ? `${Number(state.hours.toFixed(2))}h` : "?";
  return `${icon} ${label} ${hours} — ${state.minutesLeft} min left`;
}

/**
 * Render the "Hot Fees Right Now" digest as Telegram HTML.
 *
 * Layout (clean itemized list, no monospaced ASCII table):
 *
 *   🔥 <b>Hot Fees Right Now</b>
 *   <code>24h</code> window · every 6h · <code>09:59 UTC</code>
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   <b>1. AMD-SOL</b>
 *   📈 APR <code>196K%</code> · 💧 TVL <code>$62.0K</code> · 💸 Fees 24h <code>$33.3K</code>
 *   🧢 MC <code>$558.6K</code> · ⏱️ Age <code>5.9h</code>
 *   <code>3uijTWAzhQKnqZ59Wwgay7sccFWAk5reEibKg2ZRAGZ9</code>
 *   🌊 <a href="…">Meteora</a> · 👁️ <a href="…">GMGN</a>
 *
 * …followed by the action hint and optional stale/error/suppression notes. Every
 * interpolated value is escaped by {@link code} / {@link bold} /
 * {@link escapeHtml}, so a token symbol containing `&`, `<` or `>` renders
 * verbatim instead of being parsed as markup.
 *
 * @param {object} snapshot - output of {@link getHotDigest}
 * @param {{ now?: number, intervalHours?: number, suppression?: object }} [options]
 * @returns {string} HTML ready for `sendHTMLWithButtons`
 */
export function formatHotDigest(snapshot, { now = Date.now(), intervalHours = null, suppression = null } = {}) {
  const pools = Array.isArray(snapshot?.pools) ? snapshot.pools : [];
  const windowLabel = snapshot?.timeframe ?? "24h";
  const header = [];

  header.push(`🔥 ${bold("Hot Fees Right Now")}`);
  const cadence = Number.isFinite(Number(intervalHours)) ? ` · every ${Number(intervalHours)}h` : "";
  header.push(
    `${code(windowLabel)} window${cadence} · ${code(formatDigestStamp(snapshot?.updatedAt ?? now))}` +
      (snapshot?.stale ? " · ⚠️ cached" : ""),
  );
  header.push(SECTION_DIVIDER);

  const blocks = pools.map((pool) => formatHotDigestPoolBlock(pool, { now, windowLabel })).filter(Boolean);

  if (blocks.length === 0) {
    return [
      ...header,
      "No pool currently clears the fee/volume/TVL floors.",
      "Try again later, or loosen the screener floors in /settings.",
    ]
      .join("\n")
      .slice(0, MESSAGE_LIMIT);
  }

  const footer = ["Tap <b>Open n</b> to load the pool in the deploy menu · links open Meteora / GMGN."];

  const suppressed = suppression ?? getSuppressionState({ now });
  const suppressedNote = describeSuppression(suppressed);
  if (suppressedNote) footer.push(`${suppressedNote} — automatic digests paused.`);

  const feedErrors = Array.isArray(snapshot?.feedErrors) ? snapshot.feedErrors : [];
  if (feedErrors.length > 0) {
    footer.push(`⚠️ Partial data: ${escapeHtml(feedErrors.join(" | ").slice(0, 200))}`);
  }

  // Telegram rejects messages over 4096 characters, and slicing the HTML could
  // cut through a tag or a link. Drop WHOLE candidate blocks instead and leave a
  // "+N more" counter, so what reaches `sendHTMLWithButtons` is always well-formed.
  const compose = (visibleCount) => {
    const hidden = blocks.length - visibleCount;
    return [
      ...header,
      "",
      [...blocks.slice(0, visibleCount), hidden > 0 ? `… +${hidden} more` : null].filter(Boolean).join("\n\n"),
      "",
      ...footer,
    ].join("\n");
  };
  for (let visibleCount = blocks.length; visibleCount > 1; visibleCount -= 1) {
    const html = compose(visibleCount);
    if (html.length <= MESSAGE_LIMIT) return html;
  }
  return compose(Math.min(1, blocks.length)).slice(0, MESSAGE_LIMIT);
}

// ─── Inline keyboard ─────────────────────────────────────────────
/** Build one inline button (`{text, callback_data}`), truncated to Telegram's limits. */
function digestButton(text, data) {
  return {
    text: String(text ?? "").slice(0, 64),
    callback_data: String(data ?? "").slice(0, 64),
  };
}

/**
 * Inline keyboard for the digest.
 *
 *   [ Open 1 · AMD-SOL ]        ← one row per pool, index matches the list item
 *   [ Open 2 · BTC-SOL ]
 *   [ 🔄 Refresh ] [ 😴 Snooze 6h ] [ 🔕 Mute 24h ]   (+ 🔔 Resume when silenced)
 *
 * `Open n` carries only the *index* (`scr:open:n`): the pool address is resolved
 * from the in-memory snapshot, so callback data stays far below 64 bytes and the
 * button always points at the same pool the operator just read.
 *
 * @param {object[]} pools - snapshot pools (already indexed)
 * @param {{ settings?: object, suppression?: object }} [options]
 * @returns {Array<Array<{text: string, callback_data: string}>>}
 */
export function buildHotDigestKeyboard(pools = [], { settings = null, suppression = null } = {}) {
  const s = settings ?? getScreenerSettings();
  const list = (Array.isArray(pools) ? pools : []).filter((pool) => pool?.pool).slice(0, MAX_DIGEST_LIMIT);
  const rows = list.map((pool) =>
    [digestButton(`Open ${pool.index} · ${pool.pair}`, `${SCREENER_CALLBACK_PREFIX}open:${pool.index}`)],
  );

  const snoozeLabel = `😴 Snooze ${Number(s.snoozeHours ?? 6)}h`;
  const muteLabel = `🔕 Mute ${Number(s.muteHours ?? 24)}h`;
  const state = suppression ?? getSuppressionState();
  const actionRow = [digestButton("🔄 Refresh", `${SCREENER_CALLBACK_PREFIX}refresh`)];
  if (state?.active) {
    actionRow.push(digestButton("🔔 Resume", `${SCREENER_CALLBACK_PREFIX}resume`));
  } else {
    actionRow.push(digestButton(snoozeLabel, `${SCREENER_CALLBACK_PREFIX}snooze:${Number(s.snoozeHours ?? 6)}`));
    actionRow.push(digestButton(muteLabel, `${SCREENER_CALLBACK_PREFIX}mute:${Number(s.muteHours ?? 24)}`));
  }
  rows.push(actionRow);
  return rows;
}

/**
 * Parse a digest callback payload (`scr:<action>[:<arg>]`).
 * Returns `null` for anything that is not ours, so `index.js` can keep its
 * callback router flat.
 *
 * @param {string} data - `callback_data` string
 * @returns {{ action: "open"|"refresh"|"snooze"|"mute"|"resume"|"help", arg: string|null, index: number|null, hours: number|null }|null}
 */
export function parseScreenerCallback(data) {
  const raw = String(data ?? "").trim();
  if (!raw.startsWith(SCREENER_CALLBACK_PREFIX)) return null;
  const [actionRaw, argRaw] = raw.slice(SCREENER_CALLBACK_PREFIX.length).split(":");
  const action = String(actionRaw ?? "").toLowerCase();
  const arg = argRaw == null || argRaw === "" ? null : String(argRaw);
  const numeric = arg != null && Number.isFinite(Number(arg)) ? Number(arg) : null;
  switch (action) {
    case "open":
      return { action, arg, index: numeric != null && numeric >= 1 ? numeric : null, hours: null };
    case "snooze":
    case "mute":
      return { action, arg, index: null, hours: numeric != null && numeric > 0 ? numeric : null };
    case "refresh":
    case "resume":
    case "help":
      return { action, arg, index: null, hours: null };
    default:
      return null;
  }
}

/**
 * Everything `index.js` needs to broadcast one digest: rendered HTML, keyboard
 * and the snapshot behind them. Kept here so the cron tick and the /hot command
 * produce byte-identical messages.
 *
 * @param {{ force?: boolean, limit?: number, timeframe?: string, intervalHours?: number, now?: number }} [options]
 * @returns {Promise<{ html: string, keyboard: Array, snapshot: object, suppressed: object }>}
 */
export async function buildHotDigestMessage({
  force = false,
  limit,
  timeframe,
  intervalHours = null,
  now = Date.now(),
} = {}) {
  const settings = getScreenerSettings({ limit, timeframe });
  // Hard ceiling on the whole run. Individual requests are already bounded, but
  // a stuck DNS/socket chain must still never hold a cron tick open: on timeout
  // the last good snapshot is re-rendered (flagged stale) instead.
  let snapshot;
  try {
    snapshot = await withTimeout(
      getHotDigest({ force, limit, timeframe, now }),
      HOT_DIGEST_TIMEOUT_MS,
      "hot digest",
    );
  } catch (error) {
    const fallback = _lastSnapshot;
    if (!fallback) throw error;
    log("screener_warn", `Hot Fees digest timed out (${error?.message || error}) — serving stale snapshot`);
    snapshot = { ...fallback, stale: true, source: "stale-cache" };
  }
  const suppression = getSuppressionState({ now });
  const cadence = Number.isFinite(Number(intervalHours))
    ? Number(intervalHours)
    : config.screener?.intervalHours;
  return {
    html: formatHotDigest(snapshot, { now, intervalHours: cadence, suppression }),
    keyboard: buildHotDigestKeyboard(snapshot.pools, { settings, suppression }),
    snapshot,
    suppressed: suppression,
  };
}
