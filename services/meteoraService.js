/**
 * Meteora DLMM transaction service.
 *
 * Purpose: expose the modular entry points the interactive Telegram LP UI (and
 * any future caller) needs:
 *   - `getPoolsByTokenMint()` — token CA → every Meteora DLMM pair (SOL first);
 *   - `openDlmmPosition()`    — open a real DLMM position from explicit
 *     user parameters (pool, amount, range, strategy).
 *
 * This is intentionally separate from `tools/dlmm.js#deployPosition()`:
 *   - `deployPosition` is the autonomous screener path (config-driven, cooldowns,
 *     volatility heuristics, relay support).
 *   - `openDlmmPosition` is the *manual* path (user picked everything in Telegram).
 * It still reuses the same hard safety invariants: DRY_RUN / ENABLE_LIVE_TRADING
 * gate, `MIN_SAFE_BINS_BELOW` floor, bin-array rent guard, and `state.trackPosition`
 * so the exit-management cycle knows about manually opened positions.
 *
 * The SDK is imported lazily (same reason as tools/dlmm.js): `@meteora-ag/dlmm`
 * pulls `@coral-xyz/anchor` CJS directory imports that break ESM on newer Node.
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { config, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import { trackPosition } from "../state.js";
import { appendDecision } from "../decision-log.js";
import { swapToken } from "../tools/wallet.js";

const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_SLIPPAGE_PCT = 10;

// ─── Lazy SDK loader ───────────────────────────────────────────────
let _sdk = null;

async function getDlmmSdk() {
  if (!_sdk) {
    const mod = await import("@meteora-ag/dlmm");
    _sdk = {
      DLMM: mod.default,
      StrategyType: mod.StrategyType,
      getBinIdFromPrice: mod.default?.getBinIdFromPrice ?? mod.getBinIdFromPrice,
      getPriceOfBinByBinId: mod.getPriceOfBinByBinId,
      getBinArrayKeysCoverage: mod.getBinArrayKeysCoverage,
      getBinArrayIndexesCoverage: mod.getBinArrayIndexesCoverage,
      deriveBinArrayBitmapExtension: mod.deriveBinArrayBitmapExtension,
      isOverflowDefaultBinArrayBitmap: mod.isOverflowDefaultBinArrayBitmap,
      BIN_ARRAY_FEE: mod.BIN_ARRAY_FEE,
      BIN_ARRAY_BITMAP_FEE: mod.BIN_ARRAY_BITMAP_FEE,
    };
  }
  return _sdk;
}

// ─── Lazy wallet / connection ─────────────────────────────────────
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    if (!config.rpc?.url) {
      throw new Error(
        "RPC_URL is not set — add it to .env (Helius: https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY)",
      );
    }
    _connection = new Connection(config.rpc.url, "confirmed");
  }
  return _connection;
}

async function loadWallet() {
  if (_wallet) return _wallet;
  if (!process.env.WALLET_PRIVATE_KEY) {
    throw new Error("WALLET_PRIVATE_KEY is not set — cannot sign DLMM transactions.");
  }
  const { default: bs58 } = await import("bs58");
  _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY.trim()));
  return _wallet;
}

// ─── Strategies ───────────────────────────────────────────────────
/**
 * UI strategy kind → SDK `StrategyType` legs.
 *
 * `@meteora-ag/dlmm@1.9.4` only exposes Spot (0), Curve (1) and BidAsk (2) —
 * there is no `SpotBalanced`/`BidAskImbalanced` enum in this version. Composite
 * UI choices ("Spot & BA", "Spot & Curve") are therefore implemented as TWO
 * positions that split the deposit 50/50, which is how mixed-strategy zap UIs
 * behave on Meteora.
 */
export const STRATEGY_KINDS = Object.freeze(["spot", "bid_ask", "curve", "spot_ba", "spot_curve"]);

export const STRATEGY_LABELS = Object.freeze({
  spot: "Spot",
  bid_ask: "BidAsk",
  curve: "Curve",
  spot_ba: "Spot & BA",
  spot_curve: "Spot & Curve",
});

const STRATEGY_ALIASES = Object.freeze({
  spot: "spot",
  spot_balanced: "spot",
  balanced: "spot",
  bidask: "bid_ask",
  bid_ask: "bid_ask",
  bid_ask_imbalanced: "bid_ask",
  bidaskimbalanced: "bid_ask",
  curve: "curve",
  curve_balanced: "curve",
  spot_ba: "spot_ba",
  "spot&ba": "spot_ba",
  "spot and ba": "spot_ba",
  spot_and_ba: "spot_ba",
  spot_curve: "spot_curve",
  "spot&curve": "spot_curve",
  "spot and curve": "spot_curve",
  spot_and_curve: "spot_curve",
});

/** Normalise any UI alias into a supported strategy kind. */
export function normalizeStrategyKind(value, fallback = "bid_ask") {
  const raw = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const resolved = STRATEGY_ALIASES[raw] ?? STRATEGY_ALIASES[raw.replace(/\s/g, "")] ?? (STRATEGY_KINDS.includes(raw) ? raw : null);
  if (resolved) return resolved;
  if (fallback) return normalizeStrategyKind(fallback, null);
  throw new Error(`Unsupported strategy "${value}". Use one of: ${STRATEGY_KINDS.join(", ")}`);
}

/**
 * Deposit legs for a strategy kind. Weights always sum to 1.
 * Single strategies return a single leg so the caller never splits unnecessarily.
 */
export function strategyLegs(kind) {
  const normalized = normalizeStrategyKind(kind);
  if (["spot", "bid_ask", "curve"].includes(normalized)) {
    return [{ kind: normalized, weight: 1 }];
  }
  return normalized === "spot_ba"
    ? [{ kind: "spot", weight: 0.5 }, { kind: "bid_ask", weight: 0.5 }]
    : [{ kind: "spot", weight: 0.5 }, { kind: "curve", weight: 0.5 }];
}

/** Map a single leg kind onto the SDK enum exported by @meteora-ag/dlmm. */
export function toSdkStrategyType(kind, StrategyType) {
  const map = {
    spot: StrategyType?.Spot,
    curve: StrategyType?.Curve,
    bid_ask: StrategyType?.BidAsk,
  };
  const value = map[normalizeStrategyKind(kind)];
  if (value === undefined) {
    throw new Error(`SDK StrategyType missing for "${kind}" — check @meteora-ag/dlmm version.`);
  }
  return value;
}

/** Human-readable strategy label for Telegram messages. */
export function strategyLabel(kind) {
  return STRATEGY_LABELS[normalizeStrategyKind(kind)] || String(kind);
}

// ─── Bin-array rent guard (same invariant as tools/dlmm.js) ────────
async function assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId) {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDlmmSdk();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization risk; refusing deploy.");
  }

  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, DLMM_PROGRAM_ID);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");
  const missing = accounts
    .map((account, index) => (account ? null : {
      index: indexes[index]?.toString?.() ?? String(index),
      address: keys[index].toString(),
    }))
    .filter(Boolean);

  if (missing.length > 0) {
    const feeEach = Number(BIN_ARRAY_FEE ?? 0.07143744);
    const totalFee = missing.length * feeEach;
    const sample = missing.slice(0, 3).map((entry) => `${entry.index}:${entry.address.slice(0, 8)}`).join(", ");
    throw new Error(
      `Selected range needs ${missing.length} uninitialised bin-array rent payment(s) ` +
      `(~${totalFee.toFixed(4)} SOL non-refundable; ${feeEach} SOL each). ` +
      `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick a tighter / already-initialised range.`,
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, DLMM_PROGRAM_ID);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Selected range needs a Meteora bin-array bitmap extension (~${Number(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL rent). ` +
          "Pick a closer, already-initialised range.",
        );
      }
    }
  }
}

const _poolCache = new Map(); // address -> DLMM instance (5 min)
const _metadataCache = new Map(); // address -> { name, tokenXSymbol, tokenYSymbol }
const POOL_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getDlmmPool(poolAddress) {
  const key = String(poolAddress);
  const cached = _poolCache.get(key);
  if (cached && Date.now() - cached.at < POOL_CACHE_TTL_MS) return cached.pool;
  const { DLMM } = await getDlmmSdk();
  const pool = await DLMM.create(getConnection(), new PublicKey(key));
  _poolCache.set(key, { pool, at: Date.now() });
  return pool;
}

export function clearDlmmPoolCache(poolAddress = null) {
  if (poolAddress == null) _poolCache.clear();
  else _poolCache.delete(String(poolAddress));
}

/** Pool symbols from Meteora's public data API (best effort, cached). */
export async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (_metadataCache.has(key)) return _metadataCache.get(key);
  const fallback = { address: key, name: null, tokenXSymbol: null, tokenYSymbol: null };
  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) throw new Error(`metadata HTTP ${res.status}`);
    const data = await res.json();
    const tokenXSymbol = data?.token_x?.symbol || null;
    const tokenYSymbol = data?.token_y?.symbol || null;
    const meta = {
      address: data?.address || key,
      name: data?.name || (tokenXSymbol && tokenYSymbol ? `${tokenXSymbol}-${tokenYSymbol}` : null),
      tokenXSymbol,
      tokenYSymbol,
    };
    _metadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `LP UI metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    _metadataCache.set(key, fallback);
    return fallback;
  }
}

function baseFeePctFromPool(pool) {
  const binStep = Number(pool.lbPair?.binStep ?? 0);
  const params = pool.lbPair?.parameters || {};
  const baseFactor = Number(params.baseFactor ?? 0);
  const powerFactor = Number(params.baseFeePowerFactor ?? 0);
  if (!baseFactor || !binStep) return null;
  // SDK: feeFraction = baseFactor × binStep × 10 × 10^powerFactor / FEE_PRECISION(1e9)
  const fraction = (baseFactor * binStep * 10 * Math.pow(10, powerFactor)) / 1e9;
  return Number((fraction * 100).toFixed(4));
}

// ─── Token mint → pool discovery ──────────────────────────────────
/**
 * Find every Meteora DLMM pair that holds `tokenMintAddress` on either side.
 *
 * `https://dlmm-api.meteora.ag/pair/all_by_groups` is retired (it answers 404),
 * so search goes through the same discovery API the screener uses. Its `query`
 * parameter is a text search, so results are filtered client-side to an exact
 * token-address match and blacklisted pairs are dropped.
 *
 * `openDlmmPosition()` deposits SOL as token Y, therefore:
 *   - `solIsQuote` (token is X, SOL is Y) → usable from the Telegram menu;
 *   - `isSolPair` but SOL is token X       → listed, but not deployable here.
 *
 * Ranking (see `rankPoolsForToken`) puts SOL-quoted pools first, then scores by
 * 24h fee/TVL ratio, 24h volume and TVL — fee efficiency dominates, then
 * activity, then depth.
 */
const POOL_DISCOVERY_BASE = "https://dlmm.datapi.meteora.ag";
const TOKEN_POOL_PAGE_SIZE = 50;
const TOKEN_POOL_RESULT_LIMIT = 12;
const TOKEN_POOL_CACHE_TTL_MS = 60_000;
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const _tokenPoolCache = new Map(); // mint -> { at, data }

/** Relative attractiveness of a single token pool (higher = better). */
export function scoreTokenPool(pool) {
  const safe = (n) => (Number.isFinite(n) ? n : 0);
  const feeTvl = safe(Number(pool?.feeTvl ?? 0)); // 24h fee/TVL in %
  const volume = safe(Number(pool?.volume ?? 0)); // 24h volume, USD
  const tvl = safe(Number(pool?.tvl ?? 0)); // total value locked, USD
  return feeTvl * 100 + volume / 1_000 + tvl / 10_000;
}

/** Sort token pools: SOL-quoted first, then by score, then by TVL. */
export function rankPoolsForToken(pools = []) {
  return [...pools].sort((a, b) => {
    if (Boolean(a?.solIsQuote) !== Boolean(b?.solIsQuote)) return a?.solIsQuote ? -1 : 1;
    if (Boolean(a?.isSolPair) !== Boolean(b?.isSolPair)) return a?.isSolPair ? -1 : 1;
    const delta = scoreTokenPool(b) - scoreTokenPool(a);
    if (Number.isFinite(delta) && delta !== 0) return delta;
    return Number(b?.tvl ?? 0) - Number(a?.tvl ?? 0);
  });
}

/** Meteora discovery pair → compact UI entry (same fields the LP menu renders). */
export function toTokenPoolEntry(pool, tokenMint = null) {
  const tokenX = pool?.token_x || {};
  const tokenY = pool?.token_y || {};
  const binStep = Number(pool?.pool_config?.bin_step ?? 0);
  const baseFee = Number(pool?.pool_config?.base_fee_pct ?? 0);
  const feeTvlPct = Number(pool?.fee_tvl_ratio?.["24h"] ?? 0) * 100;
  const volume24h = Number(pool?.volume?.["24h"] ?? 0);
  const tvl = Number(pool?.tvl ?? 0);
  const solIsTokenX = tokenX.address === SOL_MINT;
  const solIsTokenY = tokenY.address === SOL_MINT;
  const apr = Number.isFinite(feeTvlPct) && feeTvlPct > 0 ? feeTvlPct * 365 : null;

  return {
    address: pool?.address || null,
    name: pool?.name || `${tokenX.symbol || "?"}/${tokenY.symbol || "?"}`,
    tokenMint: tokenMint || null,
    baseSymbol: tokenX.symbol ?? null,
    quoteSymbol: tokenY.symbol ?? null,
    tokenXMint: tokenX.address ?? null,
    tokenYMint: tokenY.address ?? null,
    binStep: binStep > 0 ? binStep : null,
    baseFee: Number.isFinite(baseFee) && baseFee > 0 ? baseFee : null,
    tvl: tvl > 0 ? tvl : null,
    feeTvl: Number.isFinite(feeTvlPct) ? Number(feeTvlPct.toFixed(4)) : null,
    apr: apr != null ? Number(apr.toFixed(2)) : null,
    volume: volume24h > 0 ? volume24h : null,
    activePrice: Number(pool?.current_price ?? 0) || null,
    mcap: Number(tokenX.market_cap ?? tokenY.market_cap ?? 0) || null,
    isSolPair: solIsTokenX || solIsTokenY,
    solIsQuote: solIsTokenY,
    usable: solIsTokenY,
  };
}

/**
 * @param {string} tokenMintAddress Solana mint address (token CA).
 * @param {{ limit?: number, force?: boolean }} [options]
 * @returns {Promise<{
 *   tokenMint: string, symbol: string|null, name: string|null, decimals: number|null,
 *   pools: object[], totalPools: number, solPools: number, usablePools: number,
 * }>}
 */
export async function getPoolsByTokenMint(tokenMintAddress, { limit = TOKEN_POOL_RESULT_LIMIT, force = false } = {}) {
  const mint = String(tokenMintAddress ?? "").trim();
  if (!mint) throw new Error("getPoolsByTokenMint: tokenMintAddress is required.");
  if (!BASE58_ADDRESS_RE.test(mint)) {
    throw new Error("getPoolsByTokenMint: not a valid Solana mint address.");
  }

  const cached = _tokenPoolCache.get(mint);
  if (!force && cached && Date.now() - cached.at < TOKEN_POOL_CACHE_TTL_MS) return cached.data;

  const url = `${POOL_DISCOVERY_BASE}/pools?query=${encodeURIComponent(mint)}` +
    `&sort_by=${encodeURIComponent("tvl:desc")}&page_size=${TOKEN_POOL_PAGE_SIZE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora pool search failed (HTTP ${res.status}).`);
  const payload = await res.json().catch(() => null);
  const rawPools = Array.isArray(payload?.data) ? payload.data : [];

  const matched = rawPools.filter((pool) =>
    Boolean(pool?.address) &&
    pool?.is_blacklisted !== true &&
    (pool?.token_x?.address === mint || pool?.token_y?.address === mint),
  );

  const ranked = rankPoolsForToken(matched.map((pool) => toTokenPoolEntry(pool, mint)));

  // The searched mint's display metadata comes from whichever side matched.
  let tokenMeta = { symbol: null, name: null, decimals: null };
  for (const pool of matched) {
    const token = [pool?.token_x, pool?.token_y].find((side) => side?.address === mint);
    if (token) {
      tokenMeta = {
        symbol: token.symbol ?? null,
        name: token.name ?? null,
        decimals: Number.isFinite(Number(token.decimals)) ? Number(token.decimals) : null,
      };
      break;
    }
  }

  const data = {
    tokenMint: mint,
    ...tokenMeta,
    pools: ranked.slice(0, Math.max(1, Number(limit) || TOKEN_POOL_RESULT_LIMIT)),
    totalPools: ranked.length,
    solPools: ranked.filter((pool) => pool.isSolPair).length,
    usablePools: ranked.filter((pool) => pool.usable).length,
  };
  _tokenPoolCache.set(mint, { at: Date.now(), data });
  if (_tokenPoolCache.size > 100) _tokenPoolCache.clear();
  return data;
}

export function clearTokenPoolCache(tokenMint = null) {
  if (tokenMint == null) _tokenPoolCache.clear();
  else _tokenPoolCache.delete(String(tokenMint).trim());
}

// ─── Top trending scanner ─────────────────────────────────────────
/**
 * Meteora's `/pair/all_by_groups` endpoint is retired (404), so trending pools
 * are read from the same discovery API, sorted server-side by 24h volume, then
 * filtered to liquid SOL-quoted pairs and ranked locally.
 *
 * Jupiter's token API is queried in batches (`/tokens/v2/search?query=mint,…`)
 * for organic score / holders / market cap, so the ranking blends on-chain
 * liquidity with Jupiter's top-token signal instead of trusting a single feed.
 *
 * `openDlmmPosition()` deposits SOL as token Y, so only `usable` pools (SOL is
 * the quote side) are eligible — otherwise the Quick Zap dashboard could not
 * open them.
 */
const JUPITER_TOKENS_BASE = "https://lite-api.jup.ag/tokens/v2";
const TRENDING_PAGE_SIZE = 100;
const TRENDING_POOL_LIMIT = 10;
const TRENDING_CACHE_TTL_MS = 60_000;
const TRENDING_JUPITER_BATCH = 50;
const JUPITER_TOKEN_TTL_MS = 5 * 60_000;

/** Trending filters (exported so the UI/tests can show/override thresholds). */
export const TRENDING_MIN_TVL_USD = 2_000;
export const TRENDING_MIN_VOLUME_24H_USD = 5_000;
/**
 * Ceiling for the fee/TVL term. Fresh pools whose TVL collapsed after a fee
 * burst can report five-figure daily ratios; without a cap a $600-volume pool
 * outranks a $5M one. 25%/day is already extreme.
 */
export const TRENDING_FEE_TVL_CAP_PCT = 25;

const _trendingCache = { at: 0, data: null };
const _jupiterTokenCache = new Map(); // mint -> { at, stats }

/**
 * Trending score — 24h volume dominates, then TVL, then fee/TVL efficiency
 * (clamped), with Jupiter's organic score as a small quality nudge. Weights are
 * relative only: they exist so a high-volume dust pool cannot outrank a deep one.
 */
export function scoreTrendingPool(pool) {
  const safe = (n) => (Number.isFinite(n) ? n : 0);
  const volume = safe(Number(pool?.volume ?? 0)); // 24h volume, USD
  const tvl = safe(Number(pool?.tvl ?? 0)); // total value locked, USD
  const feeTvl = Math.min(safe(Number(pool?.feeTvl ?? 0)), TRENDING_FEE_TVL_CAP_PCT);
  const organic = safe(Number(pool?.organicScore ?? pool?.organic ?? 0)); // Jupiter 0..100
  return (volume / 1_000) * 1 + (tvl / 10_000) * 0.5 + feeTvl * 10 * 0.3 + organic * 0.2;
}

/**
 * TVL ceiling from the loaded configuration (`user-config.json` → `maxTvl`).
 *
 * Read lazily (not captured at import time) so `reloadScreeningThresholds()`
 * changes are honoured without a restart. Mirrors the screener convention in
 * `tools/screening.js#passesScreeningFilters`: `null` / `0` / non-numeric
 * values disable the cap.
 */
export function getConfiguredMaxTvl() {
  const raw = config?.screening?.maxTvl;
  if (raw == null || raw === "") return null;
  const cap = Number(raw);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * Pool TVL in USD. Discovery payloads use `tvlUsd`, `toTokenPoolEntry()` uses
 * `tvl`; accept either (and `null` when the pool carries no usable number).
 */
function poolTvlUsd(pool) {
  for (const key of ["tvlUsd", "tvl"]) {
    const raw = pool?.[key];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** Normalise a TVL cap override: anything non-positive/non-numeric disables it. */
function normalizeTvlCap(value) {
  if (value == null || value === "") return null;
  const cap = Number(value);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * Drop illiquid, non-SOL-quoted or bin-step-less pools, plus any pool whose TVL
 * is above the configured ceiling (`maxTvl` in `user-config.json`) so oversized
 * pools cannot crowd out the smaller, higher-yield ranges this agent targets.
 */
export function filterTrendingPools(
  pools = [],
  {
    minTvl = TRENDING_MIN_TVL_USD,
    minVolume = TRENDING_MIN_VOLUME_24H_USD,
    maxTvl = getConfiguredMaxTvl(),
  } = {},
) {
  const floorTvl = Number(minTvl ?? 0);
  const floorVolume = Number(minVolume ?? 0);
  const capTvl = normalizeTvlCap(maxTvl);

  return (Array.isArray(pools) ? pools : []).filter((pool) => {
    if (!pool?.address) return false;
    if (pool?.usable !== true) return false; // SOL must be token Y — the only side this menu deposits
    if (!(Number(pool?.binStep ?? 0) > 0)) return false;

    const tvl = poolTvlUsd(pool) ?? 0; // unknown TVL behaves like 0 (old lower-bound semantics)
    if (tvl < floorTvl) return false;
    if (capTvl != null && tvl > capTvl) return false; // configured TVL ceiling

    return Number(pool?.volume ?? 0) >= floorVolume;
  });
}

/**
 * Rank trending pools (best first), keeping at most `perToken` pool(s) per base
 * mint so the list shows distinct tokens like a "trending tokens" board.
 */
export function rankTrendingPools(pools = [], { limit = TRENDING_POOL_LIMIT, perToken = 1 } = {}) {
  const scored = (Array.isArray(pools) ? pools : [])
    .map((pool) => ({ ...pool, trendScore: Number(scoreTrendingPool(pool).toFixed(4)) }))
    .sort((a, b) => b.trendScore - a.trendScore || Number(b.volume ?? 0) - Number(a.volume ?? 0));

  const maxPerToken = Math.max(1, Number(perToken) || 1);
  const capped = Math.max(1, Number(limit) || TRENDING_POOL_LIMIT);
  const seen = new Map();
  const ranked = [];
  for (const pool of scored) {
    const key = pool?.tokenXMint || pool?.baseMint || pool?.address;
    const count = seen.get(key) ?? 0;
    if (count >= maxPerToken) continue;
    seen.set(key, count + 1);
    ranked.push(pool);
    if (ranked.length >= capped) break;
  }
  return ranked;
}

/**
 * Jupiter token stats (organic score / holders / mcap) keyed by mint.
 * `force` bypasses the 5-minute cache — used by the open-position views so the
 * `🧢 MC` line reflects the current market cap on every refresh.
 */
export async function fetchJupiterTokenStats(mints = [], { force = false } = {}) {
  const unique = [...new Set((Array.isArray(mints) ? mints : [])
    .map((mint) => String(mint ?? "").trim())
    .filter((mint) => BASE58_ADDRESS_RE.test(mint)))];

  const stats = new Map();
  const pending = [];
  for (const mint of unique) {
    const cached = _jupiterTokenCache.get(mint);
    if (!force && cached && Date.now() - cached.at < JUPITER_TOKEN_TTL_MS) stats.set(mint, cached.stats);
    else pending.push(mint);
  }

  for (let i = 0; i < pending.length; i += TRENDING_JUPITER_BATCH) {
    const chunk = pending.slice(i, i + TRENDING_JUPITER_BATCH);
    try {
      const res = await fetch(`${JUPITER_TOKENS_BASE}/search?query=${encodeURIComponent(chunk.join(","))}`);
      if (!res.ok) throw new Error(`Jupiter token search HTTP ${res.status}`);
      const rows = await res.json();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row?.id) continue;
        const entry = {
          symbol: row.symbol ?? null,
          name: row.name ?? null,
          organicScore: Number(row.organicScore ?? 0) || 0,
          holders: Number(row.holderCount ?? 0) || 0,
          mcap: Number(row.mcap ?? row.fdv ?? 0) || 0,
          usdPrice: Number(row.usdPrice ?? 0) || 0,
          launchpad: row.launchpad ?? null,
        };
        stats.set(row.id, entry);
        _jupiterTokenCache.set(row.id, { at: Date.now(), stats: entry });
      }
    } catch (error) {
      log("trending_warn", `Jupiter token enrichment failed: ${error.message}`);
    }
  }

  if (_jupiterTokenCache.size > 500) _jupiterTokenCache.clear();
  return stats;
}

/**
 * Top liquid SOL-quoted DLMM pools, ranked by 24h volume + TVL + fee/TVL
 * (Jupiter organic score as a tie-breaker). Cached for 60 s unless `force`.
 *
 * @param {{ limit?: number, force?: boolean, minTvl?: number, minVolume?: number, maxTvl?: number|null }} [options]
 * @returns {Promise<{
 *   pools: object[], totalScanned: number, liquidPools: number,
 *   jupiterTokens: number, minTvl: number, minVolume: number, maxTvl: number|null,
 * }>}
 */
export async function getTopTrendingPools({
  limit = TRENDING_POOL_LIMIT,
  force = false,
  minTvl = TRENDING_MIN_TVL_USD,
  minVolume = TRENDING_MIN_VOLUME_24H_USD,
  maxTvl = getConfiguredMaxTvl(), // user-config.json → maxTvl (TVL ceiling)
} = {}) {
  if (!force && _trendingCache.data && Date.now() - _trendingCache.at < TRENDING_CACHE_TTL_MS) {
    return _trendingCache.data;
  }

  // Server-side sort keeps the payload small: the top 100 pools by 24h volume.
  const url = `${POOL_DISCOVERY_BASE}/pools?sort_by=${encodeURIComponent("volume_24h:desc")}` +
    `&page_size=${TRENDING_PAGE_SIZE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora trending fetch failed (HTTP ${res.status}).`);
  const payload = await res.json().catch(() => null);
  const rawPools = Array.isArray(payload?.data) ? payload.data : [];

  const scanned = rawPools
    .filter((pool) => pool?.is_blacklisted !== true)
    .map((pool) => toTokenPoolEntry(pool));
  const liquid = filterTrendingPools(scanned, { minTvl, minVolume, maxTvl });

  // Jupiter enrichment: organic score / holders / mcap for the surviving tokens.
  const jupiter = await fetchJupiterTokenStats(liquid.map((pool) => pool.tokenXMint));
  const enriched = liquid.map((pool) => {
    const stats = pool.tokenXMint ? jupiter.get(pool.tokenXMint) : null;
    if (!stats) return pool;
    return {
      ...pool,
      baseSymbol: stats.symbol || pool.baseSymbol,
      organicScore: stats.organicScore,
      organic: stats.organicScore,
      holders: stats.holders || null,
      mcap: stats.mcap || pool.mcap,
      name: `${stats.symbol || pool.baseSymbol || "?"}/SOL`,
    };
  });

  const data = {
    pools: rankTrendingPools(enriched, { limit }),
    totalScanned: rawPools.length,
    liquidPools: liquid.length,
    jupiterTokens: jupiter.size,
    minTvl,
    minVolume,
    maxTvl: normalizeTvlCap(maxTvl),
  };
  _trendingCache.at = Date.now();
  _trendingCache.data = data;
  return data;
}

export function clearTrendingCache() {
  _trendingCache.at = 0;
  _trendingCache.data = null;
  _jupiterTokenCache.clear();
}

/**
 * Convert a price-delta range (percent) or explicit bin counts into bin IDs.
 *
 * `downsidePct = 50`  → lower bound is the bin at (activePrice × 0.5)
 * `upsidePct = 40`    → upper bound is the bin at (activePrice × 1.4)
 * `upperPct = -20`    → "below the price" limit order: the upper bound sits 20 %
 *                       BELOW the active price, so `minBinId` and `maxBinId` are
 *                       both below the active bin (e.g. downsidePct 80 = -80 %).
 * Explicit `binsBelow` / `binsAbove` always win when provided.
 */
export async function computeBinRange({
  poolAddress,
  snapshot = null,
  downsidePct = 0,
  upsidePct = 0,
  upperPct = null,
  binsBelow = null,
  binsAbove = null,
}) {
  const state = snapshot || (await getPoolSnapshot(poolAddress));
  const { getBinIdFromPrice, getPriceOfBinByBinId } = await getDlmmSdk();
  const { activeBinId, binStep, activePrice } = state;

  let below = binsBelow != null && Number.isFinite(Number(binsBelow)) ? Math.round(Number(binsBelow)) : null;
  let above = binsAbove != null && Number.isFinite(Number(binsAbove)) ? Math.round(Number(binsAbove)) : null;

  const down = Math.max(0, Number(downsidePct) || 0);
  const up = Math.max(0, Number(upsidePct) || 0);
  const upper = Number(upperPct);
  // Below-the-price (limit order) mode: an upper bound that is still below the
  // active price. Explicit binsAbove wins over it.
  const belowOnly = Number.isFinite(upper) && upper < 0 && upper > -100 && binsAbove == null;

  if (below == null) {
    if (down <= 0) {
      below = 0;
    } else {
      if (down >= 100) throw new Error("downside_pct must be below 100% (price would go to zero).");
      const target = activePrice * (1 - down / 100);
      const lowerBinId = getBinIdFromPrice(target, binStep, true);
      below = Math.max(0, activeBinId - Number(lowerBinId));
    }
  }
  if (above == null) {
    if (belowOnly) {
      // Upper bound 20 % below active → bin id below the active bin.
      const target = activePrice * (1 + upper / 100);
      const upperBinId = Number(getBinIdFromPrice(target, binStep, false));
      above = Math.min(0, upperBinId - activeBinId);
      // Guarantee the range stays strictly below the active price.
      if (above >= 0) above = -1;
    } else if (up <= 0) {
      above = 0;
    } else {
      const target = activePrice * (1 + up / 100);
      const upperBinId = getBinIdFromPrice(target, binStep, false);
      above = Math.max(0, Number(upperBinId) - activeBinId);
    }
  }

  below = Math.max(0, Math.round(below));
  above = belowOnly ? Math.min(-1, Math.round(above)) : Math.max(0, Math.round(above));

  if (belowOnly && below + above < 0) {
    throw new Error(
      `Invalid below-price range: -${down}% to ${upper}% — the upper bound must be closer to the active price (e.g. -80 -20).`,
    );
  }

  const minBinId = activeBinId - below;
  const maxBinId = activeBinId + above;
  const minPrice = Number(getPriceOfBinByBinId(minBinId, binStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, binStep).toString());

  return {
    activeBinId,
    activePrice,
    binStep,
    binsBelow: below,
    // Nothing is deposited above the active bin in a below-price range.
    binsAbove: belowOnly ? 0 : above,
    totalBins: belowOnly ? maxBinId - minBinId + 1 : below + above,
    minBinId,
    maxBinId,
    minPrice,
    maxPrice,
    belowOnly,
    upperPct: belowOnly ? upper : null,
    downsideCoveragePct: activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null,
    upsideCoveragePct: activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null,
  };
}

export async function getPoolSnapshot(poolAddress) {
  const { getPriceOfBinByBinId } = await getDlmmSdk();
  const pool = await getDlmmPool(poolAddress);
  const activeBin = await pool.getActiveBin();
  const binStep = Number(pool.lbPair.binStep);
  const xDecimals = Number(pool.tokenX?.mint?.decimals ?? 9);
  const yDecimals = Number(pool.tokenY?.mint?.decimals ?? 9);
  const tokenXMint = pool.lbPair.tokenXMint.toString();
  const tokenYMint = pool.lbPair.tokenYMint.toString();
  const solIsTokenY = tokenYMint === SOL_MINT;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, binStep).toString());

  return {
    poolAddress: String(poolAddress),
    activeBinId: activeBin.binId,
    binStep,
    baseFeePct: baseFeePctFromPool(pool),
    activePrice,
    tokenXMint,
    tokenYMint,
    tokenXDecimals: xDecimals,
    tokenYDecimals: yDecimals,
    solIsTokenY,
    // SOL in the active bin (only meaningful when SOL is token Y — the usual quote side)
    activeBinSol: solIsTokenY ? Number(activeBin.yAmount ?? 0) / 10 ** yDecimals : null,
    activeBinToken: Number(activeBin.xAmount ?? 0) / 10 ** xDecimals,
  };
}

/**
 * Read-only pre-flight check exposed for diagnostics/tests: verifies the
 * selected bin range does not require paying non-refundable bin-array rent.
 */
export async function assertBinArraysCovered(poolAddress, minBinId, maxBinId) {
  const pool = await getDlmmPool(poolAddress);
  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);
  return true;
}

// ─── Manual position open ─────────────────────────────────────────
async function openStrategyLeg({ pool, wallet, connection, sdk, leg, range, slippagePct, xLamports, yLamports }) {
  const positionKeypair = new Keypair();
  const strategyType = toSdkStrategyType(leg.kind, sdk.StrategyType);
  const strategy = { minBinId: range.minBinId, maxBinId: range.maxBinId, strategyType };
  const txs = [];

  if (range.totalBins > 69) {
    // Solana caps instruction realloc at 10 240 bytes, so wide ranges need the
    // two-phase path used by tools/dlmm.js: create the extended account, then
    // top it up in chunked transactions. Both SDK calls may return arrays.
    const created = await pool.createExtendedEmptyPosition(
      range.minBinId,
      range.maxBinId,
      positionKeypair.publicKey,
      wallet.publicKey,
    );
    const createTxs = Array.isArray(created) ? created : [created];
    for (let i = 0; i < createTxs.length; i++) {
      const signers = i === 0 ? [wallet, positionKeypair] : [wallet];
      txs.push(await sendAndConfirmTransaction(connection, createTxs[i], signers));
    }

    const added = await pool.addLiquidityByStrategyChunkable({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: xLamports,
      totalYAmount: yLamports,
      strategy,
      slippage: slippagePct,
    });
    const addTxs = Array.isArray(added) ? added : [added];
    for (const tx of addTxs) {
      txs.push(await sendAndConfirmTransaction(connection, tx, [wallet]));
    }
  } else {
    const tx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: xLamports,
      totalYAmount: yLamports,
      strategy,
      slippage: slippagePct,
    });
    txs.push(await sendAndConfirmTransaction(connection, tx, [wallet, positionKeypair]));
  }

  return {
    position: positionKeypair.publicKey.toString(),
    strategy: leg.kind,
    strategyType,
    tx: txs[0] || null,
    txs,
  };
}

/**
 * Open a Meteora DLMM position from explicit user parameters.
 *
 * @param {object} params
 * @param {string} params.poolAddress       DLMM pool (lbPair) address.
 * @param {string} [params.poolName]        Display name, e.g. "Anakin/SOL".
 * @param {string} [params.strategy]        spot | bid_ask | curve | spot_ba | spot_curve.
 * @param {number} params.amountSol         Total SOL to deposit (before the optional zap swap).
 * @param {number} [params.downsidePct]     Lower bound as % below active price (50 = -50%).
 * @param {number} [params.upsidePct]       Upper bound as % above active price (0 = single-sided).
 * @param {number} [params.upperPct]        Below-the-price limit order: upper bound as a
 *                                          negative % (e.g. -20 with downsidePct 80).
 * @param {number} [params.binsBelow]       Explicit bin count below the active bin (overrides %).
 * @param {number} [params.binsAbove]       Explicit bin count above the active bin (overrides %).
 * @param {number} [params.slippagePct]     Deposit slippage in percent (default 10).
 * @param {boolean} [params.dryRun]         Defaults to the DRY_RUN env check.
 * @param {boolean} [params.track]          Persist to state.json for exit management.
 * @param {object} [params.meta]            Extra screening metadata for tracking/decision log.
 * @param {string} [params.source]          Decision-log actor tag.
 */
export async function openDlmmPosition({
  poolAddress,
  poolName = null,
  strategy = "bid_ask",
  amountSol,
  downsidePct = 0,
  upsidePct = 0,
  upperPct = null,
  binsBelow = null,
  binsAbove = null,
  slippagePct = DEFAULT_SLIPPAGE_PCT,
  dryRun = process.env.DRY_RUN === "true",
  track = true,
  meta = {},
  source = "TELEGRAM_LP_UI",
}) {
  const isDryRun = Boolean(dryRun);
  if (!isDryRun && process.env.ENABLE_LIVE_TRADING !== "true") {
    throw new Error(
      "Live deploy refused: set ENABLE_LIVE_TRADING=true (and DRY_RUN=false) to open real positions. " +
      "Set DRY_RUN=true to preview the position instead.",
    );
  }

  const address = String(poolAddress || "").trim();
  if (!address) throw new Error("openDlmmPosition: poolAddress is required.");
  const amount = Number(amountSol);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("openDlmmPosition: amountSol must be a positive number.");
  }

  const snapshot = await getPoolSnapshot(address);
  if (!snapshot.solIsTokenY) {
    throw new Error(
      "This flow deposits SOL as token Y. The selected pool quotes a different token — " +
      "pick a pool where SOL is the quote side (e.g. TOKEN/SOL).",
    );
  }

  const strategyKind = normalizeStrategyKind(strategy);
  const legs = strategyLegs(strategyKind);
  const range = await computeBinRange({ poolAddress: address, snapshot, downsidePct, upsidePct, upperPct, binsBelow, binsAbove });

  const minTotalBins = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  if (range.totalBins < minTotalBins) {
    throw new Error(
      `Range too narrow: ${range.totalBins} bin(s) < minimum ${minTotalBins}. Widen the range or add bins below.`,
    );
  }

  const totalLamports = Math.floor(amount * 1e9);
  const twoSided = range.binsAbove > 0;
  let yLamports = totalLamports;
  let xLamportsTotal = new BN(0);
  let swap = null;
  let amountToken = 0;

  if (twoSided) {
    // Half the SOL buys token X; the other half is deposited as token Y (SOL).
    yLamports = Math.floor(totalLamports / 2);
  }

  if (isDryRun) {
    return {
      success: true,
      dry_run: true,
      message: "DRY RUN — no transaction sent",
      pool: address,
      pool_name: poolName,
      strategy: strategyKind,
      strategy_label: strategyLabel(strategyKind),
      legs,
      amount_sol: amount,
      amount_token: amountToken,
      two_sided: twoSided,
      bin_range: range,
      active_bin: snapshot.activeBinId,
      base_fee: snapshot.baseFeePct,
      bin_step: snapshot.binStep,
    };
  }

  const wallet = await loadWallet();
  const connection = getConnection();
  const sdk = await getDlmmSdk();
  const pool = await getDlmmPool(address);

  await assertRangeDoesNotRequireBinArrayInitialization(pool, range.minBinId, range.maxBinId);

  // Guard passed — only now spend SOL on the zap swap for two-sided ranges.
  if (twoSided) {
    swap = await swapToken({
      input_mint: SOL_MINT,
      output_mint: snapshot.tokenXMint,
      amount: yLamports / 1e9,
    });
    if (!swap?.success) {
      throw new Error(`Zap swap SOL → token X failed: ${swap?.error || "unknown swap error"}`);
    }
    xLamportsTotal = new BN(String(swap.amount_out ?? "0"));
    amountToken = Number(xLamportsTotal.toString()) / 10 ** snapshot.tokenXDecimals;
  }

  log(
    "lp_ui",
    `Manual DLMM open ${poolName || address}: ${strategyKind} bins ${range.minBinId}→${range.maxBinId} ` +
    `(${amount} SOL${twoSided ? ` + ${amountToken} token X` : ", single-sided"})`,
  );

  const positions = [];
  for (const leg of legs) {
    const xLeg = new BN(Math.floor(Number(xLamportsTotal.toString()) * leg.weight));
    const yLeg = new BN(Math.floor(yLamports * leg.weight));
    const opened = await openStrategyLeg({
      pool,
      wallet,
      connection,
      sdk,
      leg,
      range,
      slippagePct,
      xLamports: xLeg,
      yLamports: yLeg,
    });
    positions.push(opened);

    if (track) {
      trackPosition({
        position: opened.position,
        pool: address,
        pool_name: poolName,
        strategy: leg.kind,
        bin_range: {
          min: range.minBinId,
          max: range.maxBinId,
          bins_below: range.binsBelow,
          bins_above: range.binsAbove,
        },
        bin_step: snapshot.binStep,
        volatility: meta.volatility ?? null,
        fee_tvl_ratio: meta.fee_tvl_ratio ?? null,
        organic_score: meta.organic_score ?? null,
        amount_sol: Number((yLeg.toNumber() / 1e9).toFixed(6)),
        amount_x: Number((xLeg.toNumber() / 10 ** snapshot.tokenXDecimals).toFixed(6)),
        active_bin: snapshot.activeBinId,
        initial_value_usd: meta.initial_value_usd ?? null,
      });
    }
  }

  appendDecision({
    type: "deploy",
    actor: source,
    pool: address,
    pool_name: poolName,
    position: positions[0]?.position || null,
    summary: `Manual deploy ${amount} SOL with ${strategyLabel(strategyKind)}`,
    reason: `User-selected range ${range.minBinId}→${range.maxBinId} around active bin ${snapshot.activeBinId}`,
    risks: [
      twoSided ? "two-sided zap (half the SOL swapped into token X before deposit)" : "single-sided SOL",
    ],
    metrics: {
      amount_sol: amount,
      strategy: strategyKind,
      active_bin: snapshot.activeBinId,
      min_bin: range.minBinId,
      max_bin: range.maxBinId,
      downside_pct: downsidePct ?? null,
      upside_pct: upsidePct ?? null,
      upper_pct: upperPct ?? null,
      below_only: Boolean(range.belowOnly),
      positions: positions.map((p) => p.position),
    },
  });

  return {
    success: true,
    pool: address,
    pool_name: poolName,
    strategy: strategyKind,
    strategy_label: strategyLabel(strategyKind),
    amount_sol: amount,
    amount_token: amountToken,
    two_sided: twoSided,
    swap_tx: swap?.tx || null,
    bin_range: range,
    active_bin: snapshot.activeBinId,
    bin_step: snapshot.binStep,
    base_fee: snapshot.baseFeePct,
    positions,
    txs: positions.flatMap((p) => p.txs),
  };
}

