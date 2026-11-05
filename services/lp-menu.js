/**
 * Interactive Telegram LP menu (inline keyboards) for Meteora DLMM.
 *
 * Flow:
 *   /start · /lp  →  Main Dashboard Hub (wallet + SOL/USDC/USDT balances, 7-row grid)
 *        →  💧 New LP Position  →  landing prompt (paste a token CA / quick picks)
 *        →  🔥 Top Trending     →  live volume-ranked SOL pool scan
 *        →  pool list           →  pool dashboard (Quick Zap / Amount / Range / Strategy)
 *        →  Continue → Deploy   →  `services/meteoraService.js#openDlmmPosition`
 *
 *   /lp <token mint or pool address>  →  token search / pool dashboard
 *   paste a token CA                  →  every DLMM pair for that mint (SOL first)
 *
 * Hub sub-views: 📊 My Positions · 💰 Balance · 📅 Profit Calendar · 🔗 Chain ·
 * 👛 Wallet · 🌊 DAMM v2 · 👥 Referrals · 💖 Donate · 🆘 Help. Every one of them
 * carries a 🏠 Main Menu button, and ⚙️ Settings re-uses the existing `cfg:*`
 * router in index.js.
 *
 * All callback data is prefixed `lp:` so `index.js#telegramHandler` can route it
 * without touching the existing `cfg:` settings-menu router. Session state is
 * kept in memory (per chat + user) — restarting the bot clears it, which is the
 * safest behaviour for a wallet-signing flow.
 */

import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { isTimeoutError, withTimeout } from "../utils/timeout.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTopCandidates } from "../tools/screening.js";
import {
  sendHTMLWithButtons,
  editHTMLWithButtons,
  sendHTML,
  sendPhotoWithCaption,
  editPhotoWithCaption,
  answerCallbackQuery,
} from "../telegram.js";
import {
  openDlmmPosition,
  getPoolSnapshot,
  getPoolMetadata,
  getPoolsByTokenMint,
  getTopTrendingPools,
  fetchJupiterTokenStats,
  computeBinRange,
  strategyLabel,
  normalizeStrategyKind,
} from "./meteoraService.js";
import {
  computeRangePositionPct,
  escapeHtml,
  formatCompactUsd,
  formatMarketActivityLine,
  formatMarketMetricsLine,
  formatMoney,
  formatRangeStatus,
  formatSolAmount,
  formatUsd,
  renderProgressBar,
  SECTION_DIVIDER,
} from "./telegramFormat.js";
import { marketMetricsFromPool } from "./marketData.js";

// The pure formatters live in `services/telegramFormat.js` (shared with
// `telegram.js` and the `/positions` view). They stay re-exported here so every
// existing caller and test keeps importing them from this module.
export {
  computeRangePositionPct,
  escapeHtml,
  formatCompactUsd,
  formatMarketActivityLine,
  formatMarketMetricsLine,
  formatMoney,
  formatRangeStatus,
  formatSolAmount,
  formatUsd,
};

const CALLBACK_PREFIX = "lp:";
const POOL_LIST_LIMIT = 6;
const POOL_LIST_TTL_MS = 60_000;
const WALLET_TTL_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000;

/**
 * Hard ceiling for every RPC / Meteora / Jupiter / canvas call in this menu.
 * A stalled dependency must never leave the bot looking frozen: the view gives up
 * after 5 s, tells the user, and the Telegram poll loop is already free to serve
 * the next command (see telegram.js#dispatchUpdate).
 */
const NETWORK_TIMEOUT_MS = 5_000;
const TIMEOUT_NOTE = "⚠️ Network timeout, please try again";

// ─── Formatting helpers (see `services/telegramFormat.js`) ─────────
/**
 * Estimated APR from the screening fee/TVL percentage.
 *
 * The screener's `fee_active_tvl_ratio` is used as a *daily* fee yield (the
 * config threshold `minFeeActiveTvlRatio = 0.05` only makes sense that way),
 * so APR ≈ ratio × 365. It is labelled "APR≈" in the UI because Meteora's own
 * dashboard uses a different window. If the discovery API later returns an
 * explicit `apr` field, `toPoolEntry` prefers that value.
 */
export function estimateApr(feeTvlPct) {
  const fee = Number(feeTvlPct);
  if (!Number.isFinite(fee) || fee <= 0) return null;
  return fee * 365;
}

// ─── Input parsing (used by the "Custom" buttons) ──────────────────
/**
 * Accepts "1.5", "1,5", "0.5 SOL", "50%".
 * Returns `{ mode: "sol" | "pct", value }` or null when unparseable.
 */
export function parseAmountInput(text) {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return null;
  const pctMatch = raw.match(/^([0-9]+(?:[.,][0-9]+)?)\s*%$/);
  if (pctMatch) {
    const pct = Number(pctMatch[1].replace(",", "."));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
    return { mode: "pct", value: pct };
  }
  const solMatch = raw.match(/^([0-9]*[.,]?[0-9]+)\s*(sol)?$/);
  if (solMatch) {
    const sol = Number(solMatch[1].replace(",", "."));
    if (!Number.isFinite(sol) || sol <= 0) return null;
    return { mode: "sol", value: sol };
  }
  return null;
}

/**
 * Accepts "-50", "-50%", "-30 +40", "+200%", "30/40", "-30,40" and the
 * below-price form "-80 -20" (lower bound -80 %, upper bound -20 %, both below
 * the active price). The first number is the downside %, the optional second is
 * the upside % — or, when both numbers are negative and the first is larger,
 * the upper bound expressed as a negative % (`upperPct`).
 */
export function parseRangeInput(text) {
  const raw = String(text ?? "").trim().replace(/%/g, "").replace(/,/g, " ");
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const numbers = parts.map((part) => Number(part.replace(/^\+/, "")));
  if (numbers.some((n) => !Number.isFinite(n))) return null;

  let downsidePct = 0;
  let upsidePct = 0;
  let upperPct = null;

  if (parts.length === 1) {
    const single = numbers[0];
    if (single < 0) downsidePct = Math.abs(single);
    else upsidePct = single;
  } else if (numbers[0] < 0 && numbers[1] < 0) {
    // Below-price limit order: "-80 -20" → lower -80 %, upper -20 %.
    const down = Math.abs(numbers[0]);
    const upper = Math.abs(numbers[1]);
    if (upper <= 0 || upper >= down) return null; // upper must sit above the lower bound
    downsidePct = down;
    upperPct = -upper;
  } else {
    downsidePct = Math.abs(numbers[0]);
    upsidePct = Math.abs(numbers[1]);
  }

  if (downsidePct >= 100) return null;
  if (downsidePct === 0 && upsidePct === 0 && upperPct == null) return null;
  return { downsidePct, upsidePct, upperPct };
}

/** True when the text looks like a Solana address (for paste-a-pool support). */
export function isSolanaAddress(text) {
  const raw = String(text ?? "").trim();
  if (raw.length < 32 || raw.length > 44) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(raw)) return false;
  try {
    new PublicKey(raw);
    return true;
  } catch {
    return false;
  }
}

// ─── Wallet + pool caches ─────────────────────────────────────────
let _walletCache = { at: 0, data: null };

async function getWalletSnapshot({ force = false } = {}) {
  if (!force && _walletCache.data && Date.now() - _walletCache.at < WALLET_TTL_MS) {
    return _walletCache.data;
  }
  try {
    const data = await networkDeadline(getWalletBalances(), "wallet balances");
    _walletCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    if (await reportTimeout("wallet balances", error)) {
      return _walletCache.data || { wallet: null, sol: 0, sol_usd: 0, tokens: [] };
    }
    log("lp_ui_warn", `Wallet snapshot failed: ${error.message}`);
    return _walletCache.data || { wallet: null, sol: 0, sol_usd: 0, tokens: [] };
  }
}

let _poolList = { at: 0, pools: [] };
const _activeBinCache = new Map(); // address -> { at, sol, binId, binStep, baseFee }
const ACTIVE_BIN_TTL_MS = 60_000;
const ACTIVE_BIN_BUDGET_MS = 3_500;

/** Non-throwing deadline: resolves `null` when the budget is exceeded. */
async function softTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bound a network call by {@link NETWORK_TIMEOUT_MS}. Rejects with TimeoutError,
 * which the callers turn into {@link TIMEOUT_NOTE}.
 */
function networkDeadline(promise, label) {
  return withTimeout(promise, NETWORK_TIMEOUT_MS, label);
}

/**
 * Tell the user a dependency timed out. Returns true when `error` was a timeout
 * so callers can pick the timeout note instead of a raw error message.
 */
async function reportTimeout(label, error) {
  if (!isTimeoutError(error)) return false;
  log("lp_ui_warn", `${label} timed out after ${NETWORK_TIMEOUT_MS}ms — releasing the UI`);
  await sendHTML(TIMEOUT_NOTE).catch(() => {});
  return true;
}

/**
 * Add "SOL in the active bin" to the screening view. The discovery API does not
 * expose it, so it comes from the pool account itself. Budgeted (≈3.5 s total)
 * and cached per pool so a Refresh never blocks the UI on RPC.
 */
async function enrichPoolLiquidity(pools) {
  return Promise.all(pools.map(async (pool) => {
    const cached = _activeBinCache.get(pool.address);
    if (cached && Date.now() - cached.at < ACTIVE_BIN_TTL_MS) {
      return { ...pool, ...cached.data };
    }
    const snapshot = await softTimeout(
      withTimeout(getPoolSnapshot(pool.address), ACTIVE_BIN_BUDGET_MS, "active bin").catch(() => null),
      ACTIVE_BIN_BUDGET_MS,
    );
    if (!snapshot) return pool;
    const data = {
      activeBinSol: snapshot.activeBinSol,
      activeBinId: snapshot.activeBinId,
      activePrice: snapshot.activePrice,
      binStep: pool.binStep ?? snapshot.binStep,
      baseFee: pool.baseFee ?? snapshot.baseFeePct,
    };
    _activeBinCache.set(pool.address, { at: Date.now(), data });
    return { ...pool, ...data };
  }));
}

/** Screening result → compact UI record. */
export function toPoolEntry(candidate, index = 0) {
  const feeTvl = Number(candidate?.fee_active_tvl_ratio ?? candidate?.fee_tvl_ratio ?? 0);
  const volume = Number(candidate?.volume_window ?? candidate?.volume_24h ?? 0);
  return {
    index,
    address: candidate?.pool || candidate?.address || null,
    name: candidate?.name || `${candidate?.base?.symbol || "?"}/${candidate?.quote?.symbol || "SOL"}`,
    quoteSymbol: candidate?.quote?.symbol || null,
    baseSymbol: candidate?.base?.symbol || null,
    baseMint: candidate?.base?.mint || null,
    quoteMint: candidate?.quote?.mint || null,
    binStep: Number(candidate?.bin_step ?? 0) || null,
    baseFee: Number(candidate?.fee_pct ?? 0) || null,
    tvl: Number(candidate?.tvl ?? candidate?.active_tvl ?? 0) || null,
    feeTvl: Number.isFinite(feeTvl) ? feeTvl : null,
    apr: Number.isFinite(Number(candidate?.apr)) ? Number(candidate.apr) : estimateApr(feeTvl),
    activeBinSol: Number.isFinite(Number(candidate?.active_bin_sol)) ? Number(candidate.active_bin_sol) : null,
    volume: Number.isFinite(volume) ? volume : null,
    mcap: Number(candidate?.mcap ?? 0) || null,
    organic: Number(candidate?.organic_score ?? 0) || null,
    volatility: Number(candidate?.volatility ?? 0) || null,
  };
}

/** Cached pool list for the screening view (60 s TTL, `force` bypasses it). */
export async function loadMenuPools({ force = false } = {}) {
  if (!force && _poolList.pools.length > 0 && Date.now() - _poolList.at < POOL_LIST_TTL_MS) {
    return _poolList.pools;
  }
  const top = await networkDeadline(getTopCandidates({ limit: POOL_LIST_LIMIT }), "candidate scan");
  const all = (top?.candidates || [])
    .slice(0, POOL_LIST_LIMIT)
    .map((candidate, index) => toPoolEntry(candidate, index))
    .filter((pool) => pool.address);
  // `openDlmmPosition` deposits SOL as token Y, so only SOL-quoted pools are
  // usable from this menu. Unknown quote symbols are kept (metadata fallback).
  const usable = all.filter((pool) => !pool.quoteSymbol || String(pool.quoteSymbol).toUpperCase() === "SOL");
  const enriched = await enrichPoolLiquidity(usable.map((pool, index) => ({ ...pool, index })));
  _poolList = { at: Date.now(), pools: enriched, rawCount: all.length };
  return enriched;
}

// ─── Session state ────────────────────────────────────────────────
const sessions = new Map();

function sessionKey(msg) {
  const chat = msg?.chat?.id ?? "chat";
  const user = msg?.from?.id ?? "user";
  return `${chat}:${user}`;
}

export function getLpSession(msg) {
  const key = sessionKey(msg);
  const existing = sessions.get(key);
  if (existing && Date.now() - existing.updatedAt < SESSION_TTL_MS) return existing;

  const session = {
    key,
    chatId: msg?.chat?.id ?? null,
    messageId: null,
    pools: [],
    pool: null,
    strategy: "bid_ask",
    amountMode: "preset",
    amountSol: Number(config.management?.deployAmountSol ?? 0.5),
    amountPct: null,
    downsidePct: 50,
    upsidePct: 0,
    rangeUpperPct: null,
    rangeLabel: "-50%",
    awaiting: null,
    tokenQuery: null,
    listKind: null,
    chartMessageId: null,
    chartSignature: null,
    deploying: false,
    updatedAt: Date.now(),
  };
  sessions.set(key, session);
  return session;
}

function touch(session) {
  session.updatedAt = Date.now();
  return session;
}

export function clearLpSession(msg) {
  sessions.delete(sessionKey(msg));
}

export function isLpAwaitingInput(msg) {
  const session = sessions.get(sessionKey(msg));
  return Boolean(session?.awaiting) && Date.now() - (session?.updatedAt ?? 0) < SESSION_TTL_MS;
}

export function extractPoolAddress(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (isSolanaAddress(raw)) return raw;
  const urlMatches = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  for (const candidate of urlMatches) {
    if (isSolanaAddress(candidate)) return candidate;
  }
  return null;
}

const LP_ADDRESS_COMMAND_RE = /^\/(?:lp|zap|newposition|pools)(?:@[A-Za-z0-9_]+)?\s+(\S+)\s*$/i;

/**
 * `/lp <pool-or-mint>` (also `/zap`, `/newposition`, `/pools`) → address.
 *
 * Only the address is extracted here: telling a pool address from a token mint
 * needs Meteora + RPC, which `openAddressQuery()` does. Returns null when the
 * text is not that command, or when the argument is not a Solana address.
 */
export function parseLpAddressCommand(text) {
  const match = String(text ?? "").trim().match(LP_ADDRESS_COMMAND_RE);
  if (!match) return null;
  return extractPoolAddress(match[1]);
}

/** True for `/lp something` where `something` is not a Solana address. */
export function isLpAddressCommandWithBadArg(text) {
  const raw = String(text ?? "").trim();
  if (!/^\/(?:lp|zap|newposition|pools)(?:@[A-Za-z0-9_]+)?\s+/i.test(raw)) return false;
  return parseLpAddressCommand(raw) === null;
}


// ─── Pool list rendering ──────────────────────────────────────────
export function formatPoolLine(pool, index) {
  const binStep = pool?.binStep != null ? `bin step ${pool.binStep}` : "bin step ?";
  const fee = pool?.baseFee != null ? `${formatSolAmount(pool.baseFee, 2)}% fee` : "fee ?";
  const parts = [
    `💵 TVL ${formatUsd(pool?.tvl)}`,
    `🟢 Fee/TVL ${pool?.feeTvl != null ? `${pool.feeTvl.toFixed(2)}%` : "?"}`,
    `📈 APR≈${pool?.apr != null && Number.isFinite(pool.apr) ? `${pool.apr.toFixed(1)}%` : "?"}`,
    `🌊 24h ${formatUsd(pool?.volume)}`,
  ];
  const activeBinSol = pool?.activeBinSol != null
    ? `🪙 ${formatSolAmount(pool.activeBinSol)} SOL in the active bin`
    : null;

  return [
    `${index + 1}. <b>${escapeHtml(pool?.name || "unknown")}</b> · ${binStep} · ${fee}`,
    `   ${parts.join(" · ")}`,
    activeBinSol ? `   ${activeBinSol}` : null,
  ].filter(Boolean).join("\n");
}

export function renderMainMenu({ pools = [], wallet = null, note = null, title = null } = {}) {
  const balanceSol = Number(wallet?.sol ?? 0);
  const walletLine = wallet?.wallet
    ? `👛 Wallet: <code>${escapeHtml(String(wallet.wallet).slice(0, 6))}…${escapeHtml(String(wallet.wallet).slice(-6))}</code>`
    : "👛 Wallet: <i>not configured</i>";
  const balanceLine = `💰 Balance: ${formatSolAmount(balanceSol)} SOL${wallet?.sol_usd ? ` · $${Number(wallet.sol_usd).toFixed(2)}` : ""}`;

  const header = [
    "🤖 <b>Prometheus LP</b> · Meteora DLMM on Solana",
    "─────────────────────────",
    walletLine,
    balanceLine,
    "",
  ];

  if (!pools.length) {
    const body = [
      `✅ <b>DLMM Pools</b> · 0 found`,
      "",
      "No pool passed the current screening filters.",
      note ? `\n<i>${escapeHtml(note)}</i>` : "",
      "",
      "Tap 🔄 Refresh to re-scan, or paste a Meteora pool address / link.",
    ];
    return { text: [...header, ...body].filter((line) => line != null).join("\n"), keyboard: buildMainKeyboard([]) };
  }

  const tf = config.screening?.timeframe || "30m";
  const body = [
    title || `✅ <b>DLMM Pools</b> · ${pools.length} found (by Fee/TVL ${escapeHtml(tf)}) · page 1/1`,
    "─────────────────────────",
    ...pools.map((pool, index) => formatPoolLine(pool, index)),
    "",
    note ? `<i>${escapeHtml(note)}</i>` : null,
    "👆 Tap a pool below to open a position, or paste a pool address / token CA.",
  ].filter((line) => line != null);

  return { text: [...header, ...body].join("\n"), keyboard: buildMainKeyboard(pools) };
}

function btn(text, data) {
  return { text, callback_data: `${CALLBACK_PREFIX}${data}` };
}

export function buildMainKeyboard(pools = []) {
  const rows = [];
  for (let i = 0; i < pools.length; i += 2) {
    const row = pools.slice(i, i + 2).map((pool, offset) => {
      const index = i + offset;
      const label = pool?.binStep != null
        ? `🌊 ${index + 1}. ${pool.name} · bs${pool.binStep}`
        : `🌊 ${index + 1}. ${pool.name}`;
      return btn(label.slice(0, 64), `pool:${index}`);
    });
    rows.push(row);
  }
  rows.push([btn("🔄 Refresh", "refresh"), btn("🏠 Main Menu", "main")]);
  return rows;
}

// ─── New LP Position landing view ─────────────────────────────────
export const NEW_POSITION_PROMPT = "Paste a Solana token's contract address to see its Meteora DLMM pools, or tap 🔥 Top Trending to pick one from there instead.";

/**
 * Quick-pick tokens. `mint` values are verified mainnet mints; keep the list
 * short — recent tokens (last token search / last screening results) are pushed
 * in front of it by `buildQuickTokenPicks`.
 */
export const DEFAULT_QUICK_TOKENS = Object.freeze([
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK" },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP" },
  { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF" },
  { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", symbol: "POPCAT" },
]);

/** Quick picks: last searched token → recent screening tokens → defaults. */
export function buildQuickTokenPicks({ pools = [], tokenQuery = null, defaults = DEFAULT_QUICK_TOKENS, limit = 3 } = {}) {
  const picks = [];
  const seen = new Set();
  const add = (mint, symbol) => {
    const address = String(mint ?? "").trim();
    if (!address || seen.has(address) || picks.length >= limit) return;
    if (!isSolanaAddress(address)) return;
    seen.add(address);
    picks.push({
      mint: address,
      symbol: symbol || null,
      label: `🪐 ${symbol ? `${symbol} · ` : ""}${truncateAddress(address)}`,
    });
  };
  if (tokenQuery?.mint) add(tokenQuery.mint, tokenQuery.symbol);
  for (const pool of Array.isArray(pools) ? pools : []) add(pool?.baseMint, pool?.baseSymbol);
  for (const token of Array.isArray(defaults) ? defaults : []) add(token?.mint, token?.symbol);
  return picks.slice(0, Math.max(1, Number(limit) || 3));
}

/**
 * 💧 New LP Position — a clean prompt shown BEFORE any pool scan. The session is
 * left awaiting a pasted token CA (mint) or pool address.
 */
export function renderNewPositionView({ picks = [], note = null } = {}) {
  const quick = Array.isArray(picks) ? picks : [];
  return {
    text: [
      "💧 <b>New LP Position</b>",
      "═══════════════════════",
      NEW_POSITION_PROMPT,
      "",
      "🪐 <b>Quick picks</b>",
      quick.length ? quick.map((pick) => `• ${escapeHtml(pick.label)}`).join("\n") : "<i>no recent tokens yet</i>",
      "",
      "Paste a <b>token CA</b> to list every Meteora DLMM pool for it, or a <b>pool address</b> to open that pool directly.",
      note ? `\n<i>${escapeHtml(note)}</i>` : null,
    ].filter((line) => line != null).join("\n"),
    keyboard: buildNewPositionKeyboard(quick),
  };
}

export function buildNewPositionKeyboard(picks = []) {
  const rows = (Array.isArray(picks) ? picks : []).map((pick) => [
    btn(String(pick?.label || pick?.mint || "token").slice(0, 64), `tok:${pick.mint}`),
  ]);
  rows.push([btn("🔥 Top Trending", "trending"), btn("⬅️ Main Menu", "main")]);
  return rows;
}

// ─── Top trending view ────────────────────────────────────────────
export function buildTrendingKeyboard(pools = []) {
  const rows = [];
  const list = Array.isArray(pools) ? pools : [];
  list.forEach((pool, position) => {
    // `index` is the position in session.pools, which `lp:pool:<n>` selects.
    const index = pool?.index ?? position;
    const label = `${index + 1}. ${pool?.name || "unknown"}${pool?.binStep != null ? ` · bs${pool.binStep}` : ""}`;
    rows.push([btn(String(label).slice(0, 64), `pool:${index}`)]);
  });
  rows.push([btn("🔄 Refresh", "trending:refresh"), btn("⬅️ Main Menu", "main")]);
  return rows;
}

/** 🔥 Top Trending — liquid SOL pools ranked by volume / TVL / fee-TVL. */
export function renderTrendingPools({ pools = [], wallet = null, note = null } = {}) {
  const all = Array.isArray(pools) ? pools : [];
  const usable = all.filter((pool) => pool?.usable !== false && pool?.address);
  const lines = [
    `🔥 <b>Top Trending</b> · ${usable.length} SOL pool(s)`,
    "═══════════════════════",
    wallet?.wallet ? `👛 <code>${escapeHtml(truncateAddress(wallet.wallet))}</code>` : null,
    "",
  ].filter((line) => line != null);

  if (!usable.length) {
    lines.push(
      "🫙 <b>No trending pool right now</b>",
      "",
      "Meteora returned no liquid SOL-quoted DLMM pools this cycle — try 🔄 Refresh.",
      note ? `\n<i>${escapeHtml(note)}</i>` : null,
    );
  } else {
    lines.push(
      ...usable.map((pool, position) => formatPoolLine(pool, pool.index ?? position)),
      "",
      note ? `<i>${escapeHtml(note)}</i>` : null,
      "👆 Tap a pool to open the Quick Zap dashboard.",
    );
  }

  return { text: lines.filter((line) => line != null).join("\n"), keyboard: buildTrendingKeyboard(usable) };
}

// ─── Token (mint) search results ──────────────────────────────────
/**
 * Token search results reuse the pool-list renderer, so the Zenith-style lines
 * (bin step, base fee, TVL, Fee/TVL, APR, 24h volume) look identical whether a
 * pool came from the screener or from a token-CA lookup.
 */
export function tokenPoolEntries(pools = []) {
  return (Array.isArray(pools) ? pools : [])
    .filter((pool) => pool?.address)
    .map((pool, index) => ({ ...pool, index }));
}

export function renderTokenPools({ tokenMint = null, symbol = null, pools = [], wallet = null, note = null } = {}) {
  const all = Array.isArray(pools) ? pools : [];
  const usable = all.filter((pool) => pool?.usable !== false && pool?.address);
  const solAsBase = all.filter((pool) => pool?.usable === false && pool?.isSolPair);
  const otherQuote = all.filter((pool) => !pool?.isSolPair);
  const title = symbol ? `<b>${escapeHtml(symbol)}</b>` : "token";

  const lines = [
    `🪙 ${title} · Meteora DLMM`,
    tokenMint ? `<code>${escapeHtml(tokenMint)}</code>` : null,
    "─────────────────────────",
    wallet?.wallet
      ? `👛 ${escapeHtml(String(wallet.wallet).slice(0, 6))}…${escapeHtml(String(wallet.wallet).slice(-6))} · ${formatSolAmount(wallet?.sol ?? 0)} SOL`
      : null,
    "",
  ].filter((line) => line != null);

  if (all.length === 0) {
    lines.push(
      "❌ <b>No DLMM pool found</b>",
      "",
      "Meteora has no DLMM pair for this address yet (or it is neither a pool nor a token mint).",
    );
  } else if (usable.length === 0) {
    lines.push(
      `❌ <b>No SOL-quoted DLMM pool</b> · ${all.length} pair(s) found`,
      "",
      "This menu deposits SOL as token Y, so only TOKEN/SOL pools can be opened here.",
      solAsBase.length ? `<i>${solAsBase.length} pair(s) quote SOL as token X.</i>` : null,
      otherQuote.length ? `<i>${otherQuote.length} pair(s) use another quote token.</i>` : null,
    );
  } else {
    const skipped = [
      solAsBase.length ? `${solAsBase.length} skipped (SOL is token X)` : null,
      otherQuote.length ? `${otherQuote.length} on other quotes` : null,
    ].filter(Boolean);
    lines.push(
      `✅ <b>DLMM Pools</b> · ${usable.length} usable${skipped.length ? ` · ${skipped.join(" · ")}` : ""}`,
      "─────────────────────────",
      ...usable.map((pool, offset) => formatPoolLine(pool, pool.index ?? offset)),
      "",
      "👆 Tap a pool to open the Quick Zap dashboard.",
    );
  }

  if (note) lines.push("", `<i>${escapeHtml(note)}</i>`);

  return {
    text: lines.filter((line) => line != null).join("\n"),
    keyboard: buildTokenPoolsKeyboard({ tokenMint, pools: usable }),
  };
}

export function buildTokenPoolsKeyboard({ tokenMint = null, pools = [] } = {}) {
  const rows = [];
  const list = Array.isArray(pools) ? pools : [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map((pool, offset) => {
      // `index` is the position in session.pools, which is what `lp:pool:<n>` selects.
      const index = pool?.index ?? i + offset;
      const label = pool?.binStep != null
        ? `⚡ ${index + 1}. ${pool.name} · bs${pool.binStep}`
        : `⚡ ${index + 1}. ${pool.name}`;
      return btn(String(label).slice(0, 64), `pool:${index}`);
    }));
  }
  const footer = [];
  if (tokenMint) footer.push(btn("🔄 Refresh", `tok:${tokenMint}`));
  footer.push(btn("🏠 Main Menu", "main"));
  rows.push(footer);
  return rows;
}

// ─── Pool dashboard rendering ─────────────────────────────────────
/** Meteora rents one bin array per 70 bins; this is the on-chain rent per array. */
export const BINS_PER_BIN_ARRAY = 70;
export const BIN_ARRAY_FEE_SOL = 0.07143744;

function mark(isSelected, label) {
  return isSelected ? `✅ ${label}` : label;
}

/** Worst-case bin-array rent for a range (every array uninitialised). */
export function estimateBinArrayRentSol(totalBins = 0) {
  const bins = Math.max(0, Math.ceil(Number(totalBins) || 0));
  if (bins === 0) return 0;
  return Number((Math.ceil(bins / BINS_PER_BIN_ARRAY) * BIN_ARRAY_FEE_SOL).toFixed(8));
}

/** Spendable SOL once the gas reserve and bin-array rent are set aside. */
export function maxSpendableSol({ sol = 0, gasReserve = 0, totalBins = 0 } = {}) {
  const available = Number(sol) - Number(gasReserve) - estimateBinArrayRentSol(totalBins);
  if (!Number.isFinite(available)) return 0;
  return Number(Math.max(0, available).toFixed(4));
}

/**
 * Pool health from the TVL / market-cap ratio: `Normal` at ≥ 2 % (liquidity is
 * deep enough relative to the token), `Thin` below that, `Unknown` without a
 * market cap.
 */
export function poolHealthLabel({ tvl = null, mcap = null } = {}) {
  const tvlValue = Number(tvl);
  const mcapValue = Number(mcap);
  if (!Number.isFinite(tvlValue) || !Number.isFinite(mcapValue) || tvlValue <= 0 || mcapValue <= 0) {
    return { label: "Unknown", emoji: "❔", ratioPct: null };
  }
  const ratioPct = Number(((tvlValue / mcapValue) * 100).toFixed(2));
  return ratioPct >= 2
    ? { label: "Normal", emoji: "🩺", ratioPct }
    : { label: "Thin", emoji: "🪶", ratioPct };
}

/** `0.08 SOL (≈ $7.36)` — percentage selections show the % used. */
export function describeAmount(
  session,
  wallet = null,
  { gasReserve = Number(config.management?.gasReserve ?? 0) } = {},
) {
  let sol;
  if (session?.amountMode === "pct") {
    const available = Math.max(0, Number(wallet?.sol ?? 0) - Number(gasReserve));
    sol = (available * Number(session.amountPct ?? 0)) / 100;
  } else {
    sol = Number(session?.amountSol ?? 0);
  }
  const price = Number(wallet?.sol_price ?? 0);
  const usd = price > 0 ? ` (≈ ${formatUsd(sol * price)})` : "";
  const pctNote = session?.amountMode === "pct" ? `${session.amountPct}% of balance · ` : "";
  return `${pctNote}${formatSolAmount(sol)} SOL${usd}`;
}

/** `-50% to 0%` (single-sided), `-30% to +40%`, or `-80% to -20% (Below Active Price)`. */
export function describeRange(session) {
  const down = Number(session?.downsidePct ?? 0);
  const up = Number(session?.upsidePct ?? 0);
  const upper = Number(session?.rangeUpperPct);
  if (session?.rangeUpperPct != null && Number.isFinite(upper) && upper < 0) {
    return `-${down}% to ${upper}% (Below Active Price)`;
  }
  if (up > 0) return `-${down}% to +${up}%`;
  return `-${down}% to 0%`;
}

export function renderDashboard(session, { wallet = null, note = null } = {}) {
  const pool = session.pool || {};
  // Market header inputs: MC / TVL, 24 h volume and APR, read straight from the
  // Meteora pool object already in memory (`services/marketData.js`). Both the
  // raw discovery spellings (`trade_volume_24h`, `fdv`, `liquidity`,
  // `fee_tvl_ratio`) and the `toPoolEntry` UI spellings are accepted, so a valid
  // pool metric always renders instead of `N/A`.
  const market = marketMetricsFromPool(pool);
  // The MC / TVL headline falls back to liquidity; a real supply figure is still
  // needed (and only it) for "Range MC" and the TVL/MC health ratio.
  const supplyMcap = market.mcap != null && market.mcap !== market.tvl ? market.mcap : null;
  const amountLabel = describeAmount(session, wallet);
  const twoSided = Number(session.upsidePct ?? 0) > 0;
  const mcap = Number(supplyMcap ?? 0);
  const down = Number(session.downsidePct ?? 0);
  const up = Number(session.upsidePct ?? 0);
  const binStep = pool.binStep ?? "?";
  const baseFee = pool.baseFee != null ? `${formatSolAmount(pool.baseFee, 2)}%` : "?";
  const health = poolHealthLabel({ tvl: market.tvl, mcap: supplyMcap });
  const gasReserve = Number(config.management?.gasReserve ?? 0);
  const totalBins = Number(session.rangePreview?.totalBins ?? config.strategy?.defaultBinsBelow ?? 69);
  const binRent = estimateBinArrayRentSol(totalBins);
  const maxSol = maxSpendableSol({ sol: wallet?.sol ?? 0, gasReserve, totalBins });
  const presetSol = Number(config.management?.deployAmountSol ?? 0.5);

  // Market header: MC / TVL, 24 h volume and APR + the ATH / surge badge. No
  // external request is made here, so the card renders instantly; fields the
  // pool genuinely lacks degrade to `N/A` instead of blocking the controls.
  const marketLine = formatMarketMetricsLine({
    mcap: market.mcap,
    volume24h: market.volume24h,
    apr: market.apr,
  });
  // Native turnover badge: 24 h volume > 2 × TVL → surge, else plain activity,
  // with a `📊 Vol: $X` fallback when one of the two metrics is zero/missing.
  const activityLine = formatMarketActivityLine({
    volume24h: market.volume24h,
    tvl: market.tvl,
  });

  const lines = [
    `🆕 <b>New Position: ${escapeHtml(pool.name || "pool")}</b>`,
    `Binstep: ${binStep} | BaseFee: ${baseFee}`,
    marketLine,
    activityLine,
    SECTION_DIVIDER,
    pool.activeBinId != null
      ? `🎯 Active bin: <b>${pool.activeBinId}</b>${pool.activeBinSol != null ? ` · ${formatSolAmount(pool.activeBinSol)} SOL in bin` : ""}`
      : null,
    pool.activeBinSol != null && pool.activeBinId != null
      ? `💧 1 bin ≈ ${formatSolAmount(pool.activeBinSol)} SOL`
      : null,
    `${health.emoji} Pool Health: <b>${health.label}</b>${health.ratioPct != null ? ` (TVL/MC ${health.ratioPct.toFixed(1)}%)` : ""}`,
    market.tvl != null
      ? `🩺 TVL ${formatUsd(market.tvl)} · Fee/TVL ${market.feeTvl != null ? `${Number(market.feeTvl).toFixed(2)}%` : "?"} · APR≈${market.apr != null ? `${Number(market.apr).toFixed(1)}%` : "?"}`
      : null,
    "",
    `💰 Amount: <b>${amountLabel}</b>`,
    `📐 Range: <b>${describeRange(session)}</b>`,
    session.rangePreview
      ? `🗂 Bins: <b>${session.rangePreview.minBinId}</b> → <b>${session.rangePreview.maxBinId}</b> (${session.rangePreview.totalBins} bins)`
      : null,
    mcap > 0
      ? `🏦 Range MC: ${formatUsd(mcap * Math.max(0, 1 - down / 100))} → ${formatUsd(mcap * (1 + up / 100))}`
      : null,
    `📊 Strategy: <b>${escapeHtml(strategyLabel(session.strategy))}</b>`,
    `💯 Max: <b>${formatSolAmount(maxSol)} SOL</b> <i>(after ${formatSolAmount(gasReserve)} gas + ${formatSolAmount(binRent)} bin-array rent)</i>`,
    `🛡 Slippage: 10% · Max deploy: ${formatSolAmount(config.risk?.maxDeployAmount ?? 0, 2)} SOL`,
    "",
    `⚡ Preset A: 1 SOL · -50% · Spot`,
    `⚡ Preset B: ${formatSolAmount(presetSol)} SOL · -90% · BidAsk`,
    twoSided
      ? "🧾 Two-sided range: half the SOL is swapped into the base token before deposit."
      : null,
    note ? `\n⚠️ ${escapeHtml(note)}` : null,
  ].filter((line) => line !== null && line !== undefined);

  return { text: lines.join("\n"), keyboard: buildDashboardKeyboard(session) };
}

export function buildDashboardKeyboard(session) {
  const amountMode = session.amountMode;
  const isSol = (value) => amountMode === "sol" && Number(session.amountSol) === value;
  const isPct = (value) => amountMode === "pct" && Number(session.amountPct) === value;
  const isCustomAmount = !isSol(1) && !isPct(50) && !isPct(100);
  const rangeSel = (label) => session.rangeLabel === label;
  const isCustomRange = rangeSel("Custom") || session.awaiting === "range";

  return [
    [btn("───────── ⚡ QUICK ZAP ─────────", "noop")],
    [btn("⚡ Preset A", "zap:a"), btn("⚡ Preset B", "zap:b"), btn("🛠 Custom", "zap:custom")],

    [btn("─────── 💧 LIQUIDITY AMOUNT ───────", "noop")],
    [btn(mark(isSol(1), "1 SOL"), "amt:1"), btn(mark(isPct(50), "50%"), "amt:50"), btn(mark(isPct(100), "100%"), "amt:100")],
    [btn(mark(isCustomAmount, "✏️ Custom"), "amt:custom"), btn("✏️ Preset", "amt:preset")],

    [btn("────────── 📐 RANGE ──────────", "noop")],
    [
      btn(mark(rangeSel("-50%"), "-50%"), "rng:-50"),
      btn(mark(rangeSel("-30 +40"), "-30 +40"), "rng:m30p40"),
      btn(mark(rangeSel("+200%"), "+200%"), "rng:p200"),
    ],
    [
      btn(mark(rangeSel("Default"), "⭐ Default"), "rng:default"),
      btn(mark(isCustomRange, "✏️ Range"), "rng:custom"),
      btn("✏️ Preset", "rng:preset"),
    ],
    [
      btn(mark(rangeSel("-80 -20"), "📉 -80% to -20%"), "rng:b80t20"),
      btn(mark(rangeSel("-50 -10"), "📉 -50% to -10%"), "rng:b50t10"),
    ],

    [btn("────────── 📊 STRATEGY ──────────", "noop")],
    [
      btn(mark(session.strategy === "spot", "➖ Spot"), "str:spot"),
      btn(mark(session.strategy === "bid_ask", "☍ BidAsk"), "str:bid_ask"),
      btn(mark(session.strategy === "curve", "🔔 Curve"), "str:curve"),
    ],
    [
      btn(mark(session.strategy === "spot_ba", "⚡ Spot & BA"), "str:spot_ba"),
      btn(mark(session.strategy === "spot_curve", "⚡ Spot & Curve"), "str:spot_curve"),
    ],

    [btn("────────── ✅ ACTION ──────────", "noop")],
    [btn("✅ Continue", "continue")],
    [btn("⚡ Deploy Position", "deploy")],
    [btn("🔄 Refresh", "refresh"), btn("⬅️ Back", "back"), btn("🏠 Main Menu", "main")],
  ];
}

// ─── Main Dashboard Hub (Zenith-style) ────────────────────────────
const SOL_MINT = config.tokens?.SOL ?? "So11111111111111111111111111111111111111112";
const USDC_MINT = config.tokens?.USDC ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = config.tokens?.USDT ?? "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const HUB_TITLE = "Prometheus LP";

/** `2hT6qabuzFvD2WixkgQCoYqpG2NrwiGnVa5T5XZWs68s` → `2hT6qa...s68s`. */
export function truncateAddress(address, head = 6, tail = 4) {
  const raw = String(address ?? "").trim();
  if (!raw) return "not linked";
  if (raw.length <= head + tail + 3) return raw;
  return `${raw.slice(0, head)}...${raw.slice(-tail)}`;
}

/** Token balance from the wallet snapshot's `tokens[]` (mint first, then symbol). */
export function findTokenBalance(tokens, mint, symbol = null) {
  const list = Array.isArray(tokens) ? tokens : [];
  const hit = list.find((token) => token?.mint === mint) ||
    (symbol
      ? list.find((token) => String(token?.symbol || "").toUpperCase() === String(symbol).toUpperCase())
      : null);
  if (!hit) return null;
  const balance = Number(hit.balance ?? 0);
  const usd = Number(hit.usd);
  return { balance: Number.isFinite(balance) ? balance : 0, usd: Number.isFinite(usd) ? usd : null };
}

/**
 * Root dashboard: banner, copyable wallet (truncated) and live SOL / USDC / USDT
 * balances, plus the 7-row Zenith-style shortcut grid.
 */
export function renderDashboardHub({ wallet = null, note = null } = {}) {
  const address = wallet?.wallet || null;
  const sol = Number(wallet?.sol ?? 0);
  const solUsd = Number(wallet?.sol_usd ?? 0);
  const usdc = Number(wallet?.usdc ?? findTokenBalance(wallet?.tokens, USDC_MINT, "USDC")?.balance ?? 0);
  const usdt = findTokenBalance(wallet?.tokens, USDT_MINT, "USDT")?.balance ?? 0;
  const totalUsd = Number(wallet?.total_usd ?? 0);

  const lines = [
    `🌌 <b>${HUB_TITLE}</b> · Meteora DLMM Hub`,
    "═══════════════════════",
    "👛 <b>Wallet</b>",
    address ? `<code>${escapeHtml(truncateAddress(address))}</code>` : "<i>not configured</i>",
    "",
    "💰 <b>Balances</b>",
    `• ◎ SOL <b>${formatSolAmount(sol)}</b>${solUsd > 0 ? ` (${formatUsd(solUsd)})` : ""}`,
    `• USDC <b>${formatSolAmount(usdc, 2)}</b>`,
    `• USDT <b>${formatSolAmount(usdt, 2)}</b>`,
    totalUsd > 0 ? `• Total ≈ <b>${formatUsd(totalUsd)}</b>` : null,
    wallet?.error ? `\n⚠️ ${escapeHtml(wallet.error)}` : null,
    note ? `\n<i>${escapeHtml(note)}</i>` : null,
    "",
    "Pick an option below to continue.",
  ].filter((line) => line != null);

  return { text: lines.join("\n"), keyboard: buildHubKeyboard(wallet) };
}

export function buildHubKeyboard(wallet = null) {
  const short = wallet?.wallet ? truncateAddress(wallet.wallet) : "not linked";
  return [
    [btn("💧 New LP Position", "new_position"), btn("📊 My Positions", "positions")],
    [btn("🔥 Top Trending", "trending"), btn("💰 Balance", "balance")],
    [btn("📅 Profit Calendar", "calendar"), btn("🔗 Chain: Solana", "chain")],
    [btn(`👛 Wallet: ${short}`.slice(0, 64), "wallet")],
    [btn("🌊 DAMM v2 Positions", "damm")],
    [btn("👥 Referrals", "referrals"), { text: "⚙️ Settings", callback_data: "cfg:page:main" }],
    [btn("💖 Donate", "donate"), btn("🆘 Help Center", "help")],
  ];
}

// ─── Sub-view rendering (positions / balances / stats) ────────────
const BACK_ROW = (refreshAction = null) => [
  refreshAction ? btn("🔄 Refresh", refreshAction) : null,
  btn("🏠 Main Menu", "main"),
].filter(Boolean);

/** PnL/values are SOL-denominated when `management.solMode` is on, else USD. */
function currencyMode({ mode = null, solMode = null } = {}) {
  if (mode) return mode === "SOL" ? "SOL" : "USD";
  return (solMode ?? config.management?.solMode) ? "SOL" : "USD";
}

// ─── Active-position text metrics (no images) ─────────────────────
// `formatMoney`, `formatRangeStatus` and `computeRangePositionPct` are the pure
// helpers from `services/telegramFormat.js` (re-exported at the top of this file).

/** `[██████░░░░]` — 10 slots, floored so 65 % fills 6 blocks. */
export function renderRangeBar(pct, slots = 10) {
  return renderProgressBar(pct, slots);
}

/** `📍 Range Position: 65% [██████░░░░]` (null when the bins are unknown). */
export function formatRangePositionLine(position) {
  const pct = computeRangePositionPct({
    lowerBinId: position?.lower_bin,
    upperBinId: position?.upper_bin,
    activeBinId: position?.active_bin,
  });
  if (pct == null) return null;
  return `📍 Range Position: <b>${pct}%</b> ${renderRangeBar(pct)}`;
}

/** `🧢 MC: $1.25M` (null when the market cap is unknown). */
export function formatMarketCapLine(mcap) {
  const compact = formatCompactUsd(mcap);
  return compact ? `🧢 MC: <b>${compact}</b>` : null;
}

/**
 * Attach the live token market cap to open positions. Jupiter's token search is
 * the same source the screening view uses, so a `/positions` refresh costs at
 * most one bounded HTTP call — and never throws.
 */
export async function enrichPositionsWithMarketCap(positions = [], { force = true } = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const mints = [...new Set(list.map((position) => position?.base_mint).filter(Boolean))];
  if (!mints.length) return list;
  try {
    const stats = await networkDeadline(fetchJupiterTokenStats(mints, { force }), "market cap");
    return list.map((position) => {
      const mcap = position?.base_mint ? Number(stats.get(position.base_mint)?.mcap ?? 0) : 0;
      return mcap > 0 ? { ...position, mcap } : position;
    });
  } catch (error) {
    log("lp_ui_warn", `Market cap enrichment skipped: ${error.message}`);
    return list;
  }
}

export function formatPositionLine(position, index, mode = "USD") {
  const pnlPct = Number(position?.pnl_pct);
  const pnlValue = Number(position?.pnl_usd);
  const pnlSign = pnlValue > 0 ? "+" : "";
  // `-$4.20` / `+$4.20` (never `$-4.20`).
  const pnlLabel = Number.isFinite(pnlValue) && pnlValue < 0
    ? `-${formatMoney(Math.abs(pnlValue), mode)}`
    : `${pnlSign}${formatMoney(pnlValue, mode)}`;
  const bins = position?.lower_bin != null && position?.upper_bin != null
    ? `🗂 ${position.lower_bin}→${position.upper_bin}${position.active_bin != null ? ` (active ${position.active_bin})` : ""}`
    : null;
  const age = Number(position?.age_minutes);
  const metrics = [formatRangePositionLine(position), formatMarketCapLine(position?.mcap)]
    .filter(Boolean)
    .join(" · ");

  return [
    `${index + 1}. <b>${escapeHtml(position?.pair || "unknown pool")}</b> ${formatRangeStatus(position?.in_range)}`,
    `   💵 ${formatMoney(position?.total_value_usd, mode)} · 📈 PnL ${pnlLabel}` +
      `${Number.isFinite(pnlPct) ? ` (${pnlSign}${pnlPct.toFixed(2)}%)` : ""}`,
    `   🎁 Unclaimed ${formatMoney(position?.unclaimed_fees_usd, mode)}${bins ? ` · ${bins}` : ""}`,
    metrics ? `   ${metrics}` : null,
    `   ⏱ ${Number.isFinite(age) ? `${age}m` : "?"} · 🆔 <code>${escapeHtml(String(position?.position || "?").slice(0, 12))}…</code>`,
  ].filter((line) => line != null).join("\n");
}

export function renderPositions({ positions = [], wallet = null, note = null, mode = null } = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const unit = currencyMode({ mode });
  const maxPositions = Number(config.risk?.maxPositions ?? 0);
  const header = [
    `📊 <b>My Positions</b> · ${list.length}${maxPositions ? `/${maxPositions}` : ""} open`,
    "═══════════════════════",
    wallet?.wallet ? `👛 <code>${escapeHtml(truncateAddress(wallet.wallet))}</code>` : null,
    "",
  ].filter((line) => line != null);

  const keyboard = [BACK_ROW("positions:refresh"), [btn("💧 New LP Position", "new_position")]];

  if (list.length === 0) {
    return {
      text: [
        ...header,
        "🫙 <b>No open Meteora DLMM positions</b>",
        "",
        "Deploy one from 💧 New LP Position, then tap 🔄 Refresh.",
        note ? `\n<i>${escapeHtml(note)}</i>` : null,
      ].filter((line) => line != null).join("\n"),
      keyboard,
    };
  }

  return {
    text: [
      ...header,
      ...list.map((position, index) => formatPositionLine(position, index, unit)),
      "",
      note ? `<i>${escapeHtml(note)}</i>` : null,
      "Tap 🔄 Refresh for up-to-date PnL.",
    ].filter((line) => line != null).join("\n"),
    keyboard,
  };
}

export function renderBalances({ wallet = null, note = null, limit = 10 } = {}) {
  const tokens = Array.isArray(wallet?.tokens) ? wallet.tokens : [];
  const reserved = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
  const extras = tokens
    .filter((token) => token?.mint && !reserved.has(token.mint))
    .filter((token) => Number(token?.balance ?? 0) > 0 || Number(token?.usd ?? 0) > 0)
    .sort((a, b) => Number(b?.usd ?? 0) - Number(a?.usd ?? 0));

  const lines = [
    "💰 <b>Balances</b>",
    "═══════════════════════",
    wallet?.wallet ? `<code>${escapeHtml(wallet.wallet)}</code>` : "<i>wallet not configured</i>",
    "",
    `• ◎ SOL <b>${formatSolAmount(wallet?.sol ?? 0)}</b>${Number(wallet?.sol_usd) > 0 ? ` (${formatUsd(wallet.sol_usd)})` : ""}`,
    `• USDC <b>${formatSolAmount(wallet?.usdc ?? findTokenBalance(tokens, USDC_MINT, "USDC")?.balance ?? 0, 2)}</b>`,
    `• USDT <b>${formatSolAmount(findTokenBalance(tokens, USDT_MINT, "USDT")?.balance ?? 0, 2)}</b>`,
    Number(wallet?.total_usd) > 0 ? `• Total ≈ <b>${formatUsd(wallet.total_usd)}</b>` : null,
    "",
    extras.length ? `🧾 <b>SPL tokens</b> · ${extras.length}` : "🧾 <b>SPL tokens</b> · none",
  ].filter((line) => line != null);

  for (const token of extras.slice(0, limit)) {
    const usd = Number(token?.usd);
    const symbol = escapeHtml(token?.symbol || String(token?.mint || "?").slice(0, 6));
    lines.push(`• ${symbol} <b>${formatSolAmount(token?.balance ?? 0)}</b>${Number.isFinite(usd) && usd > 0 ? ` (${formatUsd(usd)})` : ""}`);
  }
  if (extras.length > limit) lines.push(`<i>+${extras.length - limit} more token(s)</i>`);
  if (wallet?.error) lines.push("", `⚠️ ${escapeHtml(wallet.error)}`);
  if (note) lines.push("", `<i>${escapeHtml(note)}</i>`);

  return { text: lines.join("\n"), keyboard: [BACK_ROW("balance:refresh")] };
}

// ─── History / info views ─────────────────────────────────────────
export function formatProfitLine(record, index = 0) {
  const pnl = Number(record?.pnl_usd);
  const pct = Number(record?.pnl_pct);
  const fees = Number(record?.fees_earned_usd);
  const minutes = Number(record?.minutes_held);
  const icon = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
  const when = record?.closed_at ? String(record.closed_at).slice(5, 16).replace("T", " ") : null;
  return [
    `${index + 1}. ${icon} <b>${escapeHtml(record?.pool_name || record?.pool || "unknown")}</b> ` +
      `${pnl > 0 ? "+" : ""}${formatUsd(pnl)}${Number.isFinite(pct) ? ` (${pct > 0 ? "+" : ""}${pct.toFixed(2)}%)` : ""}`,
    `   ${Number.isFinite(fees) && fees > 0 ? `🎁 fees ${formatUsd(fees)} · ` : ""}` +
      `${Number.isFinite(minutes) ? `⏱ ${minutes}m · ` : ""}` +
      `${escapeHtml(record?.close_reason || "closed")}${when ? ` · ${escapeHtml(when)}` : ""}`,
  ].join("\n");
}

/** Profit Calendar = closed-position performance from lessons.json records. */
export function renderProfitCalendar({ summary = null, history = null, hours = 24, note = null } = {}) {
  const records = Array.isArray(history?.positions) ? history.positions : [];
  const lines = [`📅 <b>Profit Calendar</b> · last ${hours}h`, "═══════════════════════"];

  if (history?.count) {
    lines.push(
      `🏁 Closed <b>${history.count}</b> · ✅ Win rate <b>${history.win_rate_pct ?? "?"}%</b> · ` +
      `💵 Realised <b>${formatUsd(history.total_pnl_usd)}</b>`,
    );
  } else {
    lines.push("🫙 No closed positions in this window.");
  }
  if (summary) {
    lines.push(
      `📈 All time: ${summary.total_positions_closed} closed · ${formatUsd(summary.total_pnl_usd)} · ` +
      `win ${summary.win_rate_pct}% · avg ${summary.avg_pnl_pct}%`,
    );
  }
  if (records.length) {
    lines.push("─────────────────────────");
    lines.push(...records.slice(-8).reverse().map((record, index) => formatProfitLine(record, index)));
  }
  lines.push("", note ? `<i>${escapeHtml(note)}</i>` : "<i>History comes from lessons.json performance records.</i>");

  return {
    text: lines.join("\n"),
    keyboard: [BACK_ROW("calendar:refresh"), [btn("📊 My Positions", "positions")]],
  };
}

export function renderChainView({ note = null } = {}) {
  let rpcHost = "not configured";
  try {
    rpcHost = config.rpc?.url ? new URL(config.rpc.url).host : "not configured";
  } catch {
    rpcHost = "invalid RPC url";
  }

  return {
    text: [
      "🔗 <b>Chain: Solana</b> · mainnet-beta",
      "═══════════════════════",
      "🌊 DEX: Meteora DLMM (bin-based, dynamic fees)",
      "🧩 Program: <code>LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo</code>",
      `📡 RPC: <code>${escapeHtml(rpcHost)}</code>`,
      `🎛 Mode: ${config.management?.solMode ? "SOL" : "USD"} · 🧪 Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
      `⚙️ Strategy: ${escapeHtml(config.strategy?.strategy || "?")} · deploy ${formatSolAmount(config.management?.deployAmountSol ?? 0)} SOL · ` +
      `max ${config.risk?.maxPositions ?? "?"} positions`,
      note ? `\n<i>${escapeHtml(note)}</i>` : null,
    ].filter((line) => line != null).join("\n"),
    keyboard: [BACK_ROW(), [btn("💧 New LP Position", "new_position")]],
  };
}

export function renderWalletView({ wallet = null, note = null } = {}) {
  const address = wallet?.wallet || null;
  const tokens = Array.isArray(wallet?.tokens) ? wallet.tokens : [];
  const lines = [
    "👛 <b>Wallet</b>",
    "═══════════════════════",
    address ? `<code>${escapeHtml(address)}</code>` : "<i>not configured — set WALLET_PRIVATE_KEY in .env</i>",
    address
      ? `<a href="https://solscan.io/account/${escapeHtml(address)}">View on Solscan</a>`
      : null,
    "",
    `◎ SOL <b>${formatSolAmount(wallet?.sol ?? 0)}</b>${Number(wallet?.sol_usd) > 0 ? ` (${formatUsd(wallet.sol_usd)})` : ""}`,
    `USDC <b>${formatSolAmount(wallet?.usdc ?? findTokenBalance(tokens, USDC_MINT, "USDC")?.balance ?? 0, 2)}</b> · ` +
    `USDT <b>${formatSolAmount(findTokenBalance(tokens, USDT_MINT, "USDT")?.balance ?? 0, 2)}</b>`,
    Number(wallet?.total_usd) > 0 ? `Total ≈ <b>${formatUsd(wallet.total_usd)}</b>` : null,
    wallet?.error ? `\n⚠️ ${escapeHtml(wallet.error)}` : null,
    note ? `\n<i>${escapeHtml(note)}</i>` : null,
  ].filter((line) => line != null);

  return { text: lines.join("\n"), keyboard: [BACK_ROW("wallet:refresh")] };
}

// ─── Placeholder / utility views ──────────────────────────────────
export function renderDammView() {
  return {
    text: [
      "🌊 <b>DAMM v2 Positions</b>",
      "═══════════════════════",
      "This agent manages Meteora <b>DLMM</b> positions only.",
      "",
      "DAMM v2 (dynamic AMM) pools are not wired in yet — the installed",
      "@meteora-ag/dlmm SDK cannot read or manage them.",
      "",
      "Use 💧 New LP Position to open a DLMM position.",
    ].join("\n"),
    keyboard: [BACK_ROW(), [btn("💧 New LP Position", "new_position")]],
  };
}

/**
 * Referral card. The built-in referral is **disabled by default** (0 bps, no
 * account), so this renders a "Disabled (0 BPS)" card with no address at all —
 * the account block only appears when the operator opted in via `.env`.
 */
export function renderReferralsView() {
  const account = String(config.jupiter?.referralAccount || "").trim();
  const bpsRaw = Number(config.jupiter?.referralFeeBps ?? 0);
  const bps = Number.isFinite(bpsRaw) && bpsRaw > 0 ? Math.round(bpsRaw) : 0;
  const enabled = Boolean(account) && bps > 0;
  return {
    text: [
      "👥 <b>Referrals</b>",
      "═══════════════════════",
      enabled ? `💸 Referral Fee: ${bps} BPS (${(bps / 100).toFixed(2)}%)` : "💸 Referral Fee: Disabled (0 BPS)",
      enabled ? `🔗 Jupiter referral account:\n<code>${escapeHtml(account)}</code>` : null,
      "",
      enabled
        ? "Referral fees are attached to the SOL → token zap swaps this bot makes."
        : "No referral account is attached to any Jupiter quote or swap request — swaps run at zero platform fee.",
      "Enable with <code>JUPITER_REFERRAL_ACCOUNT</code> + <code>JUPITER_REFERRAL_FEE_BPS</code> (50–255) in .env.",
    ].filter((line) => line != null).join("\n"),
    keyboard: [BACK_ROW()],
  };
}

export function renderDonateView({ wallet = null } = {}) {
  const address = wallet?.wallet || null;
  return {
    text: [
      "💖 <b>Donate</b>",
      "═══════════════════════",
      "Prometheus is free and open source. If it made you money, a tip keeps the RPC bill paid.",
      "",
      address ? `◎ SOL · USDC · USDT on Solana:\n<code>${escapeHtml(address)}</code>` : "<i>Wallet not configured.</i>",
      "",
      "<i>Tips are voluntary and never affect position sizing.</i>",
    ].filter((line) => line != null).join("\n"),
    keyboard: [BACK_ROW()],
  };
}

export function renderHelpView() {
  return {
    text: [
      "🆘 <b>Help Center</b>",
      "═══════════════════════",
      "<b>Dashboard</b>",
      "• 💧 New LP Position — screening list, paste a pool address or a token CA",
      "• 📊 My Positions — open DLMM positions with live PnL / unclaimed fees",
      "• 🔥 Top Trending — pools ranked by 24h volume",
      "• 💰 Balance — SOL / USDC / USDT + SPL tokens",
      "• 📅 Profit Calendar — closed-position PnL history",
      "• ⚙️ Settings — the existing config menu",
      "",
      "<b>Commands</b>",
      "/lp — this dashboard",
      "/lp &lt;token mint | pool address&gt; — every DLMM pair for a token",
      "/positions — plain-text position list",
      "/close &lt;n&gt; · /closeall — close positions",
      "/settings — config menu · /help — command list",
      "",
      "Amounts accept SOL (<code>0.5</code>) or a balance % (<code>35%</code>).",
      "Ranges accept <code>-40</code>, <code>-30 +40</code> or <code>+150</code>.",
    ].join("\n"),
    keyboard: [BACK_ROW(), [btn("💧 New LP Position", "new_position"), btn("📊 My Positions", "positions")]],
  };
}

// ─── Sending / editing ────────────────────────────────────────────
const _lastView = new Map(); // messageId -> signature, to avoid "not modified" duplicate sends

function viewSignature(text, keyboard) {
  return `${text}::${JSON.stringify(keyboard)}`;
}

/**
 * Drop the cached view signature for a message.
 * Needed when another menu (e.g. the `cfg:*` settings router) edited that same
 * Telegram message, so the next LP render is not skipped as "not modified".
 */
export function forgetLpMessageView(messageId) {
  if (messageId) _lastView.delete(messageId);
  else _lastView.clear();
}

async function presentMessage({ text, keyboard }, messageId = null) {
  const signature = viewSignature(text, keyboard);
  if (messageId) {
    if (_lastView.get(messageId) === signature) return messageId; // nothing changed
    const edited = await editHTMLWithButtons(text, messageId, keyboard);
    if (edited) {
      _lastView.set(messageId, signature);
      return messageId;
    }
  }
  const sent = await sendHTMLWithButtons(text, keyboard);
  const id = sent?.result?.message_id ?? null;
  if (id) _lastView.set(id, signature);
  if (_lastView.size > 200) _lastView.clear();
  return id;
}

/**
 * Root dashboard — sent by `/start`, `/lp`, `/dashboard`, `lp:main` and every
 * 🏠 Main Menu button. Clears any in-progress position selection so nothing
 * stale leaks into the hub.
 */
export async function showLpMainMenu({ messageId = null, force = false, note = null, msg = null } = {}) {
  const session = msg ? getLpSession(msg) : null;
  if (session) {
    session.awaiting = null;
    session.pool = null;
    session.messageId = messageId ?? session.messageId;
  }

  const wallet = await getWalletSnapshot({ force });
  const view = renderDashboardHub({ wallet, note });
  const newMessageId = await presentMessage(view, messageId ?? session?.messageId ?? null);
  if (session) session.messageId = newMessageId;
  return newMessageId;
}

/**
 * 💧 New LP Position / 🔥 Top Trending — the screening list (tap a pool, paste a
 * pool address, or paste a token CA to search all of its pairs).
 * `sort: "volume"` re-orders the same candidates by 24h volume.
 */
export async function showPoolListView({ messageId = null, force = false, note = null, msg = null, sort = "fee" } = {}) {
  const session = msg ? getLpSession(msg) : null;
  if (session) {
    session.awaiting = null;
    session.pool = null;
    session.listKind = "list";
    session.messageId = messageId ?? session.messageId;
  }

  let pools = [];
  let scanError = null;
  try {
    pools = await loadMenuPools({ force });
  } catch (error) {
    scanError = (await reportTimeout("screening scan", error)) ? TIMEOUT_NOTE : error.message;
    if (scanError !== TIMEOUT_NOTE) log("lp_ui_warn", `Screening failed: ${error.message}`);
  }
  if (sort === "volume") {
    pools = [...pools].sort((a, b) => Number(b?.volume ?? 0) - Number(a?.volume ?? 0));
  }
  if (session) session.pools = pools;

  const wallet = await getWalletSnapshot();
  const emptyNote = !scanError && pools.length === 0 && (_poolList.rawCount || 0) > 0
    ? `${_poolList.rawCount} pool(s) passed screening but none are SOL-quoted. SOL must be the quote side — paste a TOKEN/SOL pool address.`
    : null;
  const view = renderMainMenu({
    pools,
    wallet,
    note: scanError ? `Scan error: ${scanError}` : emptyNote || note,
    title: sort === "volume"
      ? `🔥 <b>Top Trending</b> · ${pools.length} pool(s) by 24h volume`
      : null,
  });
  const newMessageId = await presentMessage(view, messageId ?? session?.messageId ?? null);
  if (session) session.messageId = newMessageId;
  return newMessageId;
}

/**
 * 💧 New LP Position — landing prompt shown before any pool scan.
 * Puts the session in "awaiting address" mode: the next plain-text message may
 * be a token CA (list its DLMM pools) or a pool address (open it directly).
 */
export async function showNewPositionView({ messageId = null, note = null, msg = null } = {}) {
  const session = msg ? touch(getLpSession(msg)) : null;
  if (session) {
    session.awaiting = "address";
    session.pool = null;
    session.messageId = messageId ?? session.messageId;
  }

  // No network here: quick picks come from cached screening data + defaults.
  const picks = buildQuickTokenPicks({
    pools: _poolList.pools,
    tokenQuery: session?.tokenQuery ?? null,
  });
  const view = renderNewPositionView({ picks, note });
  const newMessageId = await presentMessage(view, messageId ?? session?.messageId ?? null);
  if (session) session.messageId = newMessageId;
  return newMessageId;
}

/**
 * 🔥 Top Trending — live Meteora scan (volume/TVL/fee-TVL) enriched with
 * Jupiter organic scores. The resulting pools become `session.pools`, so each
 * numbered button (`lp:pool:<n>`) opens the normal Quick Zap dashboard.
 */
export async function showTrendingView({ messageId = null, force = false, note = null, msg = null } = {}) {
  const session = msg ? touch(getLpSession(msg)) : null;
  if (session) {
    session.awaiting = null;
    session.pool = null;
    session.listKind = "trending";
    session.messageId = messageId ?? session.messageId;
  }

  let pools = [];
  let scanError = null;
  try {
    const result = await networkDeadline(getTopTrendingPools({ force }), "trending scan");
    pools = tokenPoolEntries(result?.pools);
  } catch (error) {
    scanError = (await reportTimeout("trending scan", error)) ? TIMEOUT_NOTE : error.message;
    if (scanError !== TIMEOUT_NOTE) log("lp_ui_warn", `Trending scan failed: ${error.message}`);
  }
  if (session) session.pools = pools;

  const wallet = await getWalletSnapshot();
  const view = renderTrendingPools({
    pools,
    wallet,
    note: scanError ? `Scan error: ${scanError}` : note,
  });
  const newMessageId = await presentMessage(view, messageId ?? session?.messageId ?? null);
  if (session) session.messageId = newMessageId;
  return newMessageId;
}

// ─── Liquidity chart attachment ───────────────────────────────────
/**
 * Stable signature that decides whether the chart photo has to be replaced.
 * Only the pool, the active bin and the selected range affect the drawing —
 * amount/strategy changes reuse the current photo.
 */
export function chartSignature({ poolAddress = null, activeBinId = null, minBinId = null, maxBinId = null } = {}) {
  return [poolAddress || "", activeBinId ?? "", minBinId ?? "", maxBinId ?? ""].join("|");
}

/**
 * Attach (or refresh) the liquidity distribution chart as a photo message.
 *
 * The interactive Zenith card stays a separate text message so its keyboard is
 * not duplicated under the photo; the chart carries the same text as caption
 * (trimmed to Telegram's 1024-char photo-caption limit).
 *
 * Any failure (canvas not installed, RPC/bin fetch error, Telegram offline)
 * leaves the text dashboard untouched — this helper never throws.
 */
async function attachLiquidityChart(msg, session, view) {
  const pool = session?.pool;
  if (!pool?.address || !view?.text || !msg) return null;

  const range = session.rangePreview
    ? { minBinId: session.rangePreview.minBinId, maxBinId: session.rangePreview.maxBinId }
    : null;
  const signature = chartSignature({
    poolAddress: pool.address,
    activeBinId: pool.activeBinId ?? null,
    minBinId: range?.minBinId ?? null,
    maxBinId: range?.maxBinId ?? null,
  });
  if (session.chartSignature === signature && session.chartMessageId) return session.chartMessageId;

  let chart = null;
  try {
    chart = await import("./chartService.js");
  } catch (error) {
    log("lp_ui_warn", `Chart module unavailable: ${error.message}`);
    return null;
  }

  let buffer = null;
  try {
    // Canvas + bin fetch: bounded so a slow RPC can never freeze the dashboard.
    buffer = await networkDeadline(
      chart.generateLiquidityDistributionChart(
        {
          address: pool.address,
          baseSymbol: pool.baseSymbol ?? null,
          quoteSymbol: pool.quoteSymbol ?? null,
        },
        range,
      ),
      "liquidity chart",
    );
  } catch (error) {
    if (await reportTimeout("liquidity chart", error)) return null;
    log("lp_ui_warn", `Liquidity chart skipped: ${error.message}`);
    return null;
  }

  const caption = chart.buildPhotoCaption(view.text);
  if (session.chartMessageId) {
    const edited = await editPhotoWithCaption(caption, session.chartMessageId, buffer);
    if (edited) {
      session.chartSignature = signature;
      return session.chartMessageId;
    }
  }
  const sent = await sendPhotoWithCaption(caption, buffer);
  if (sent) {
    session.chartMessageId = sent;
    session.chartSignature = signature;
    return sent;
  }
  return null;
}

async function presentDashboard(msg, { note = null, messageId = null } = {}) {
  const session = touch(getLpSession(msg));

  // The card is rendered 100 % from memory: the market header is derived from the
  // Meteora pool object below, so no external market API can delay this view.
  // Resolve the bin range for display (state stores %, the preview stores IDs).
  if (session.pool?.activeBinId != null && session.pool?.binStep) {
    try {
      session.rangePreview = await computeBinRange({
        snapshot: {
          activeBinId: Number(session.pool.activeBinId),
          binStep: Number(session.pool.binStep),
          activePrice: Number(session.pool.activePrice ?? 0),
        },
        downsidePct: Number(session.downsidePct ?? 0),
        upsidePct: Number(session.upsidePct ?? 0),
        upperPct: session.rangeUpperPct ?? null,
      });
    } catch (error) {
      session.rangePreview = null;
      log("lp_ui_warn", `Range preview failed: ${error.message}`);
    }
  }

  const wallet = await getWalletSnapshot();
  const view = renderDashboard(session, { wallet, note });
  const id = messageId ?? session.messageId ?? msg?.messageId ?? null;
  const newId = await presentMessage(view, id);
  session.messageId = newId;

  // Best-effort photo chart; the text card above is always the source of truth.
  try {
    await attachLiquidityChart(msg, session, view);
  } catch (error) {
    log("lp_ui_warn", `Chart attach failed: ${error.message}`);
  }
  return newId;
}

// ─── Dashboard navigation ────────────────────────────────────────
/** Shared presenter: keeps the session pointed at the message being edited. */
async function presentHubView(msg, view, { messageId = null } = {}) {
  const session = msg ? touch(getLpSession(msg)) : null;
  const id = messageId ?? session?.messageId ?? msg?.messageId ?? null;
  const newId = await presentMessage(view, id);
  if (session) session.messageId = newId;
  return newId;
}

/** 📊 My Positions — open Meteora DLMM positions with live PnL / unclaimed fees. */
export async function showPositionsView(msg, { force = false, messageId = null } = {}) {
  let positions = [];
  let note = null;
  try {
    // Lazy import: keeps this module light and avoids pulling the SDK wrapper in tests.
    const { getMyPositions } = await import("../tools/dlmm.js");
    const snapshot = await networkDeadline(getMyPositions({ force, silent: true }), "positions read");
    if (snapshot?.error) note = snapshot.error;
    positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
    // Live market cap for the `🧢 MC` line — bounded, cached and non-fatal.
    positions = await enrichPositionsWithMarketCap(positions, { force });
  } catch (error) {
    if (await reportTimeout("positions read", error)) {
      note = TIMEOUT_NOTE;
    } else {
      note = `Could not read positions: ${error.message}`;
      log("lp_ui_warn", `Positions view failed: ${error.message}`);
    }
  }
  const wallet = await getWalletSnapshot();
  return presentHubView(msg, renderPositions({ positions, wallet, note }), { messageId });
}

/** 💰 Balance — full SOL / USDC / USDT + SPL token breakdown. */
export async function showBalancesView(msg, { force = true, messageId = null } = {}) {
  const wallet = await getWalletSnapshot({ force });
  return presentHubView(msg, renderBalances({ wallet }), { messageId });
}

/** 📅 Profit Calendar — closed-position performance from the lessons history. */
export async function showProfitCalendarView(msg, { hours = 24, messageId = null } = {}) {
  let summary = null;
  let history = null;
  let note = null;
  try {
    const lessons = await import("../lessons.js");
    summary = lessons.getPerformanceSummary();
    history = lessons.getPerformanceHistory({ hours, limit: 50 });
  } catch (error) {
    note = `History unavailable: ${error.message}`;
    log("lp_ui_warn", `Profit calendar failed: ${error.message}`);
  }
  return presentHubView(msg, renderProfitCalendar({ summary, history, hours, note }), { messageId });
}

export async function showChainView(msg, { messageId = null } = {}) {
  return presentHubView(msg, renderChainView(), { messageId });
}

export async function showWalletView(msg, { force = false, messageId = null } = {}) {
  const wallet = await getWalletSnapshot({ force });
  return presentHubView(msg, renderWalletView({ wallet }), { messageId });
}

export async function showDammView(msg, { messageId = null } = {}) {
  return presentHubView(msg, renderDammView(), { messageId });
}

export async function showReferralsView(msg, { messageId = null } = {}) {
  return presentHubView(msg, renderReferralsView(), { messageId });
}

export async function showDonateView(msg, { messageId = null } = {}) {
  const wallet = await getWalletSnapshot();
  return presentHubView(msg, renderDonateView({ wallet }), { messageId });
}

export async function showHelpView(msg, { messageId = null } = {}) {
  return presentHubView(msg, renderHelpView(), { messageId });
}

// ─── Pool selection ───────────────────────────────────────────────
async function selectPool(msg, index) {
  const session = touch(getLpSession(msg));
  if (!session.pools.length) {
    session.pools = await loadMenuPools();
  }
  const entry = session.pools[index];
  if (!entry) {
    await showPoolListView({ msg, messageId: msg.messageId, note: "That pool is no longer in the list — refreshed." });
    return;
  }

  let note = null;
  const pool = { ...entry };
  try {
    const snapshot = await getPoolSnapshot(entry.address);
    pool.activeBinId = snapshot.activeBinId;
    pool.activeBinSol = snapshot.activeBinSol;
    pool.activePrice = snapshot.activePrice;
    pool.binStep = pool.binStep ?? snapshot.binStep;
    pool.baseFee = pool.baseFee ?? snapshot.baseFeePct;
  } catch (error) {
    note = `Live pool read failed (${error.message}). Showing cached screening data.`;
    log("lp_ui_warn", `Pool snapshot failed: ${error.message}`);
  }

  session.pool = pool;
  session.awaiting = null;
  await presentDashboard(msg, { note, messageId: msg.messageId });
}

// ─── Preset application ───────────────────────────────────────────
/** Bin count → equivalent downside % for the pool's bin step. */
export function binsToDownsidePct(binsBelow, binStep) {
  const bins = Number(binsBelow);
  const step = Number(binStep);
  if (!Number.isFinite(bins) || bins <= 0 || !Number.isFinite(step) || step <= 0) return null;
  const pct = (1 - Math.pow(1 + step / 10_000, -bins)) * 100;
  return Number(pct.toFixed(2));
}

function applyAmountPreset(session, key) {
  if (key === "preset") {
    session.amountMode = "sol";
    session.amountSol = Number(config.management?.deployAmountSol ?? 0.5);
    session.amountPct = null;
    return true;
  }
  if (key === "50" || key === "100") {
    session.amountMode = "pct";
    session.amountPct = Number(key);
    return true;
  }
  if (key === "1") {
    session.amountMode = "sol";
    session.amountSol = 1;
    session.amountPct = null;
    return true;
  }
  return false;
}

/** Apply a range preset (exported so the preset table is unit-testable). */
export function applyRangePreset(session, key) {
  const binStep = Number(session.pool?.binStep ?? 0);
  const defaultBins = Number(config.strategy?.defaultBinsBelow ?? 69);
  const defaultPct = binsToDownsidePct(defaultBins, binStep);
  const standard = (down, up, label) => {
    session.downsidePct = down;
    session.upsidePct = up;
    session.rangeUpperPct = null;
    session.rangeLabel = label;
    return true;
  };

  switch (key) {
    case "-50":
      return standard(50, 0, "-50%");
    case "m30p40":
      return standard(30, 40, "-30 +40");
    case "p200":
      return standard(0, 200, "+200%");
    case "default":
    case "preset": {
      if (defaultPct == null) return false;
      return standard(defaultPct, 0, key === "default" ? "Default" : "Preset");
    }
    // Below-the-price single-sided SOL limit orders (both bounds under active).
    case "b80t20":
      session.downsidePct = 80;
      session.upsidePct = 0;
      session.rangeUpperPct = -20;
      session.rangeLabel = "-80 -20";
      return true;
    case "b50t10":
      session.downsidePct = 50;
      session.upsidePct = 0;
      session.rangeUpperPct = -10;
      session.rangeLabel = "-50 -10";
      return true;
    default:
      return false;
  }
}

async function resolveAmountSol(session, wallet) {
  if (session.amountMode === "pct") {
    const gasReserve = Number(config.management?.gasReserve ?? 0.2);
    const available = Math.max(0, Number(wallet?.sol ?? 0) - gasReserve);
    return Number(((available * Number(session.amountPct ?? 0)) / 100).toFixed(4));
  }
  return Number(session.amountSol);
}

// ─── Deploy ───────────────────────────────────────────────────────
export function formatDeployResult(result) {
  const range = result?.bin_range || {};
  const tx = result?.txs?.[0] ?? result?.tx ?? null;
  const swapTx = result?.swap_tx ?? null;
  const pr = range.minPrice != null && range.maxPrice != null
    ? `${formatSolAmount(range.minPrice, 8)} → ${formatSolAmount(range.maxPrice, 8)}`
    : "?";
  const line = result?.dry_run ? "🧪 <b>DRY RUN — no transaction sent</b>" : "✅ <b>Position opened</b>";
  const positions = (result?.positions || []).map((entry) =>
    `• ${escapeHtml(entry.strategy)} → <code>${escapeHtml(entry.position)}</code>`,
  );
  return [
    line,
    `Pool: <b>${escapeHtml(result?.pool_name || result?.pool || "?")}</b>`,
    result?.pool ? `<code>${escapeHtml(result.pool)}</code>` : null,
    "",
    `💰 Amount: ${formatSolAmount(result?.amount_sol)} SOL${result?.two_sided && result?.amount_token ? ` + ${formatSolAmount(result.amount_token)} base` : ""}`,
    `📐 Bins: ${range.minBinId ?? "?"} → ${range.maxBinId ?? "?"} (active ${range.activeBinId ?? result?.active_bin ?? "?"})`,
    `📈 Price: ${pr}`,
    range.downsideCoveragePct != null
      ? (() => {
        const downCov = -Math.abs(Number(range.downsideCoveragePct));
        const upCov = Number(range.upsideCoveragePct ?? 0);
        return `🛡 Coverage: ${downCov.toFixed(2)}% / ${upCov >= 0 ? "+" : ""}${upCov.toFixed(2)}%`;
      })()
      : null,
    `📊 Strategy: ${escapeHtml(result?.strategy_label || strategyLabel(result?.strategy || "bid_ask"))}`,
    result?.bin_step != null ? `Binstep: ${result.bin_step}${result?.base_fee != null ? ` | BaseFee: ${formatSolAmount(result.base_fee, 2)}%` : ""}` : null,
    swapTx ? `🔁 Zap swap: <a href="https://solscan.io/tx/${escapeHtml(swapTx)}">${escapeHtml(swapTx.slice(0, 16))}…</a>` : null,
    positions.length ? `\n📦 Positions:\n${positions.join("\n")}` : null,
    tx ? `\n🔗 Tx: <code>${escapeHtml(tx)}</code>` : null,
    tx ? `🔍 <a href="https://solscan.io/tx/${escapeHtml(tx)}">View on Solscan</a>` : null,
    result?.txs?.length > 1 ? `<i>+${result.txs.length - 1} more transaction(s)</i>` : null,
    result?.dry_run ? "\nSet <code>DRY_RUN=false</code> + <code>ENABLE_LIVE_TRADING=true</code> to go live." : null,
  ].filter((value) => value !== null && value !== undefined).join("\n");
}

async function deploySession(msg, session) {
  const pool = session.pool;
  if (!pool?.address) throw new Error("Pick a pool first — tap 🏠 Main Menu → 💧 New LP Position.");
  if (session.deploying) throw new Error("A deploy is already running in this chat — wait for it to finish.");

  const wallet = await getWalletSnapshot({ force: true });
  const amountSol = await resolveAmountSol(session, wallet);
  const gasReserve = Number(config.management?.gasReserve ?? 0.2);
  const maxDeploy = Number(config.risk?.maxDeployAmount ?? 0);
  const minSolToOpen = Number(config.management?.minSolToOpen ?? 0);

  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error("Amount must be greater than 0 SOL.");
  }
  if (maxDeploy > 0 && amountSol > maxDeploy) {
    throw new Error(`Amount ${amountSol} SOL exceeds maxDeployAmount ${maxDeploy} SOL.`);
  }
  if (Number(wallet?.sol ?? 0) < minSolToOpen) {
    throw new Error(
      `Wallet has ${formatSolAmount(wallet?.sol ?? 0)} SOL, below minSolToOpen ${minSolToOpen} SOL. Fund the wallet first.`,
    );
  }
  if (amountSol + gasReserve > Number(wallet?.sol ?? 0)) {
    throw new Error(
      `Not enough SOL: ${amountSol} SOL + ${gasReserve} SOL gas reserve > ${formatSolAmount(wallet?.sol ?? 0)} SOL balance.`,
    );
  }

  session.deploying = true;
  try {
    return await openDlmmPosition({
      poolAddress: pool.address,
      poolName: pool.name,
      strategy: session.strategy,
      amountSol,
      downsidePct: Number(session.downsidePct ?? 0),
      upsidePct: Number(session.upsidePct ?? 0),
      upperPct: session.rangeUpperPct ?? null,
      meta: {
        fee_tvl_ratio: pool.feeTvl ?? null,
        organic_score: pool.organic ?? null,
        initial_value_usd: pool.tvl ?? null,
        volatility: pool.volatility ?? null,
      },
    });
  } finally {
    session.deploying = false;
  }
}


// ─── Pool address entry ───────────────────────────────────────────
/**
 * Open the dashboard for a known pool address.
 * Returns false (without touching the session's selected pool) when the address
 * is not a readable DLMM pool, so callers can fall back to token-mint search.
 */
export async function openPoolByAddress(msg, address, { quiet = false } = {}) {
  const session = touch(getLpSession(msg));
  let note = null;
  const entry = session.pools.find((pool) => pool.address === address) || { address };

  if (!entry.name) {
    const [meta, snapshot] = await Promise.all([
      networkDeadline(getPoolMetadata(address), "pool metadata").catch((error) => {
        if (isTimeoutError(error)) log("lp_ui_warn", `Pool metadata timed out after ${NETWORK_TIMEOUT_MS}ms`);
        return null;
      }),
      networkDeadline(getPoolSnapshot(address), "pool snapshot").catch(async (error) => {
        if (await reportTimeout("pool snapshot", error)) {
          note = TIMEOUT_NOTE;
          return null;
        }
        note = `Could not read the pool on-chain: ${error.message}`;
        return null;
      }),
    ]);
    if (!snapshot && !meta) {
      // A timeout was already reported to the user — don't chain another scan.
      if (note === TIMEOUT_NOTE) return false;
      if (!quiet) {
        await showPoolListView({ msg, messageId: msg.messageId, note: `Pool ${address.slice(0, 8)}… is not readable.` });
      }
      return false;
    }
    if (meta?.name) entry.name = meta.name;
    if (snapshot) {
      entry.binStep = entry.binStep ?? snapshot.binStep;
      entry.baseFee = entry.baseFee ?? snapshot.baseFeePct;
      entry.activeBinId = snapshot.activeBinId;
      entry.activeBinSol = snapshot.activeBinSol;
      entry.activePrice = snapshot.activePrice;
    }
  }

  session.pool = { ...entry, address };
  session.awaiting = null;
  await presentDashboard(msg, { note, messageId: msg.messageId });
  return true;
}

// ─── Token mint search ────────────────────────────────────────────
async function presentTokenPools(msg, result, { note = null, messageId = null } = {}) {
  const session = touch(getLpSession(msg));
  session.pools = tokenPoolEntries(result?.pools);
  session.pool = null;
  session.awaiting = null;
  session.tokenQuery = { mint: result?.tokenMint ?? null, symbol: result?.symbol ?? null };
  session.listKind = "token";

  const wallet = await getWalletSnapshot();
  const view = renderTokenPools({
    tokenMint: result?.tokenMint ?? null,
    symbol: result?.symbol ?? null,
    pools: session.pools,
    wallet,
    note,
  });
  const id = messageId ?? session.messageId ?? msg?.messageId ?? null;
  const newId = await presentMessage(view, id);
  session.messageId = newId;
  return newId;
}

/**
 * Show every Meteora DLMM pool for a token mint (SOL pairs first).
 * Used by `/lp <mint>`, a pasted token CA, and the `lp:tok:<mint>` refresh button.
 */
export async function openTokenByMint(msg, tokenMint, { force = false, messageId = null } = {}) {
  const mint = String(tokenMint ?? "").trim();
  const session = touch(getLpSession(msg));
  if (!isSolanaAddress(mint)) {
    await sendHTML("❌ That is not a valid Solana token mint address.");
    return null;
  }

  let result = null;
  let note = null;
  try {
    result = await networkDeadline(getPoolsByTokenMint(mint, { force }), "token pool search");
  } catch (error) {
    note = (await reportTimeout("token pool search", error))
      ? TIMEOUT_NOTE
      : `Pool search failed: ${error.message}`;
    if (note !== TIMEOUT_NOTE) {
      log("lp_ui_warn", `Token pool search failed for ${mint.slice(0, 8)}: ${error.message}`);
    }
    result = { tokenMint: mint, symbol: null, pools: [], totalPools: 0, solPools: 0, usablePools: 0 };
  }

  await presentTokenPools(msg, result, {
    note,
    messageId: messageId ?? session.messageId ?? msg?.messageId ?? null,
  });
  return result;
}

/**
 * Resolve a pasted/typed address.
 *
 * A pool the menu already knows opens straight away. Anything else is looked up
 * as a token mint first (one HTTP call) — when Meteora returns pairs for it, the
 * user gets the token's pool list; otherwise the address is probed as a pool.
 *
 * @returns {Promise<{ kind: "pool" | "token" | "unknown", address: string, pools?: object[] }>}
 */
export async function openAddressQuery(msg, address) {
  const cleaned = String(address ?? "").trim();
  const session = touch(getLpSession(msg));

  if (session.pools.some((pool) => pool?.address === cleaned)) {
    await openPoolByAddress(msg, cleaned);
    return { kind: "pool", address: cleaned };
  }

  let result = null;
  try {
    result = await networkDeadline(getPoolsByTokenMint(cleaned), "address lookup");
  } catch (error) {
    if (await reportTimeout("address lookup", error)) {
      return { kind: "unknown", address: cleaned, timedOut: true };
    }
    log("lp_ui_warn", `Address lookup failed for ${cleaned.slice(0, 8)}: ${error.message}`);
  }
  if (result?.pools?.length) {
    log(
      "lp_ui",
      `Token ${result.symbol || cleaned.slice(0, 6)}: ${result.usablePools}/${result.totalPools} usable DLMM pool(s)`,
    );
    await presentTokenPools(msg, result);
    return { kind: "token", address: cleaned, pools: result.pools };
  }

  if (await openPoolByAddress(msg, cleaned, { quiet: true })) {
    return { kind: "pool", address: cleaned };
  }

  await presentTokenPools(
    msg,
    { tokenMint: cleaned, symbol: null, pools: [] },
    { note: "No Meteora DLMM pool matched this address." },
  );
  return { kind: "unknown", address: cleaned };
}

// ─── Custom text input ────────────────────────────────────────────
/**
 * Consume a plain-text message when it answers a Custom prompt
 * (`lp:amt:custom`, `lp:rng:custom`), runs `/lp <address>`, or is a pasted
 * token CA / pool address / Meteora link.
 * Returns true when the message was handled here.
 */
export async function handleLpText(msg) {
  const text = String(msg?.text ?? "").trim();
  if (!text || msg?.isCallback) return false;

  // `/lp <token mint | pool address>` — works even before the menu was opened.
  const commandAddress = parseLpAddressCommand(text);
  if (commandAddress) {
    await openAddressQuery(msg, commandAddress);
    return true;
  }
  if (isLpAddressCommandWithBadArg(text)) {
    await sendHTML(
      "❌ That is not a Solana address.\n" +
      "Send <code>/lp</code> for the pool menu, or <code>/lp &lt;token mint | pool address&gt;</code>.",
    );
    return true;
  }
  if (text.startsWith("/")) return false;

  const session = sessions.get(sessionKey(msg));
  const active = session && Date.now() - session.updatedAt < SESSION_TTL_MS ? session : null;
  const awaiting = active?.awaiting ?? null;

  if (awaiting === "amount") {
    const parsed = parseAmountInput(text);
    if (!parsed) {
      await sendHTML("❌ Could not read that amount. Send a number like <code>0.5</code> or a percentage like <code>50%</code>.");
      return true;
    }
    active.amountMode = parsed.mode;
    if (parsed.mode === "pct") {
      active.amountPct = parsed.value;
    } else {
      active.amountSol = parsed.value;
      active.amountPct = null;
    }
    active.awaiting = null;
    await presentDashboard(msg, { messageId: active.messageId });
    return true;
  }

  if (awaiting === "range") {
    const parsed = parseRangeInput(text);
    if (!parsed) {
      await sendHTML("❌ Could not read that range. Try <code>-40</code>, <code>-30 +40</code> or <code>+150</code>.");
      return true;
    }
    active.downsidePct = parsed.downsidePct;
    active.upsidePct = parsed.upsidePct;
    active.rangeUpperPct = parsed.upperPct ?? null;
    active.rangeLabel = parsed.upperPct != null
      ? `${-parsed.downsidePct} ${parsed.upperPct}`
      : "Custom";
    active.awaiting = null;
    await presentDashboard(msg, { messageId: active.messageId });
    return true;
  }

  if (awaiting === "address") {
    const address = extractPoolAddress(text);
    if (!address) {
      await sendHTML(
        "❌ That is not a Solana address.\n" +
        "Paste a <b>token contract address</b> (mint CA) or a <b>Meteora pool address</b> — " +
        "or tap 🔥 Top Trending.",
      );
      return true;
    }
    active.awaiting = null;
    await openAddressQuery(msg, address);
    return true;
  }

  // A bare address / token CA / Meteora link: pool dashboard or token pool list.
  if (isSolanaAddress(text) || /^https?:\/\/\S+$/i.test(text)) {
    const address = extractPoolAddress(text);
    if (address) {
      await openAddressQuery(msg, address);
      return true;
    }
  }
  return false;
}


// ─── Callback router ──────────────────────────────────────────────
export async function handleLpCallback(msg) {
  const raw = String(msg?.callbackData ?? msg?.text ?? "").trim();
  if (!raw.startsWith(CALLBACK_PREFIX)) return false;

  const [action, arg] = raw.slice(CALLBACK_PREFIX.length).split(":");
  const session = touch(getLpSession(msg));
  const ack = (text = "") => answerCallbackQuery(msg.callbackQueryId, text).catch(() => {});

  if (action === "noop") {
    await ack("Adjust any of the options below");
    return true;
  }

  if (action === "main") {
    await ack();
    await showLpMainMenu({ msg, messageId: msg.messageId });
    return true;
  }

  if (action === "refresh") {
    await ack("Refreshing…");
    if (session.pool?.address) {
      try {
        const snapshot = await networkDeadline(
          getPoolSnapshot(session.pool.address),
          "pool refresh",
        );
        session.pool.activeBinId = snapshot.activeBinId;
        session.pool.activeBinSol = snapshot.activeBinSol;
        session.pool.activePrice = snapshot.activePrice;
        session.pool.binStep = session.pool.binStep ?? snapshot.binStep;
        session.pool.baseFee = session.pool.baseFee ?? snapshot.baseFeePct;
      } catch (error) {
        log("lp_ui_warn", `Dashboard refresh failed: ${error.message}`);
      }
      await presentDashboard(msg, { messageId: msg.messageId });
    } else {
      await showPoolListView({ msg, messageId: msg.messageId, force: true });
    }
    return true;
  }

  if (action === "new_position") {
    await ack();
    await showNewPositionView({ msg, messageId: msg.messageId });
    return true;
  }

  // Legacy alias (older keyboards) — still opens the screening list directly.
  if (action === "pools") {
    await ack();
    await showPoolListView({ msg, messageId: msg.messageId, force: Boolean(arg) });
    return true;
  }

  if (action === "trending") {
    await ack(arg === "refresh" ? "Refreshing trending…" : "Scanning Meteora + Jupiter…");
    await showTrendingView({ msg, messageId: msg.messageId, force: arg === "refresh" });
    return true;
  }

  if (action === "positions") {
    await ack(arg === "refresh" ? "Refreshing positions…" : "");
    await showPositionsView(msg, { force: arg === "refresh", messageId: msg.messageId });
    return true;
  }

  if (action === "balance") {
    await ack(arg === "refresh" ? "Refreshing balances…" : "");
    await showBalancesView(msg, { force: true, messageId: msg.messageId });
    return true;
  }

  if (action === "calendar") {
    await ack(arg === "refresh" ? "Refreshing history…" : "");
    await showProfitCalendarView(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "chain") {
    await ack();
    await showChainView(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "wallet") {
    await ack(arg === "refresh" ? "Refreshing wallet…" : "");
    await showWalletView(msg, { force: arg === "refresh", messageId: msg.messageId });
    return true;
  }

  if (action === "damm") {
    await ack();
    await showDammView(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "referrals") {
    await ack();
    await showReferralsView(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "donate") {
    await ack();
    await showDonateView(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "help") {
    await ack();
    await showHelpView(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "pool") {
    await ack();
    await selectPool(msg, Number(arg));
    return true;
  }

  if (action === "tok") {
    await ack("Refreshing token pools…");
    await openTokenByMint(msg, arg, { force: true });
    return true;
  }

  if (action === "zap") {
    if (arg === "a") {
      applyAmountPreset(session, "1");
      applyRangePreset(session, "-50");
      session.strategy = "spot";
      await ack("Preset A: 1 SOL · -50% · Spot");
    } else if (arg === "b") {
      applyAmountPreset(session, "preset");
      session.downsidePct = 90;
      session.upsidePct = 0;
      session.rangeUpperPct = null;
      session.rangeLabel = "-90%";
      session.strategy = "bid_ask";
      await ack("Preset B: preset SOL · -90% · BidAsk");
    } else {
      await ack("Use the buttons below to fine-tune, then Continue");
    }
    session.awaiting = null;
    await presentDashboard(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "amt") {
    if (arg === "custom") {
      session.awaiting = "amount";
      session.messageId = msg.messageId;
      await ack("Send the amount");
      await presentMessage(
        {
          text: [
            "✏️ <b>Custom liquidity amount</b>",
            "",
            `Pool: <b>${escapeHtml(session.pool?.name || "?")}</b>`,
            "Send the amount in SOL (e.g. <code>0.5</code>) or as a % of your balance (e.g. <code>35%</code>).",
            "",
            "<i>Send /lp to cancel.</i>",
          ].join("\n"),
          keyboard: [[btn("⬅️ Back", "back")]],
        },
        msg.messageId,
      );
      return true;
    }
    if (!applyAmountPreset(session, arg)) {
      await ack("Unknown amount");
      return true;
    }
    await ack(`Amount: ${arg === "preset" ? "preset" : arg}`);
    await presentDashboard(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "rng") {
    if (arg === "custom") {
      session.awaiting = "range";
      session.messageId = msg.messageId;
      await ack("Send the range");
      await presentMessage(
        {
          text: [
            "✏️ <b>Custom range</b>",
            "",
            `Pool: <b>${escapeHtml(session.pool?.name || "?")}</b> · bin step ${session.pool?.binStep ?? "?"}`,
            "Send the price delta, e.g. <code>-40</code> (single-sided), <code>-30 +40</code> or <code>+150</code>.",
            "An upside range needs a two-sided zap: half the SOL is swapped into the base token first.",
            "",
            "<i>Send /lp to cancel.</i>",
          ].join("\n"),
          keyboard: [[btn("⬅️ Back", "back")]],
        },
        msg.messageId,
      );
      return true;
    }
    if (!applyRangePreset(session, arg)) {
      await ack("Range preset unavailable — use Custom");
      return true;
    }
    await ack(`Range: ${session.rangeLabel}`);
    await presentDashboard(msg, { messageId: msg.messageId });
    return true;
  }


  if (action === "str") {
    try {
      session.strategy = normalizeStrategyKind(arg);
    } catch (error) {
      await ack(error.message);
      return true;
    }
    await ack(`Strategy: ${strategyLabel(session.strategy)}`);
    await presentDashboard(msg, { messageId: msg.messageId });
    return true;
  }

  if (action === "back") {
    await ack();
    // Returning from a "Custom" prompt goes back to the dashboard card…
    if (session.awaiting) {
      session.awaiting = null;
      if (session.pool) await presentDashboard(msg, { messageId: msg.messageId });
      else await showPoolListView({ msg, messageId: msg.messageId });
      return true;
    }
    // …while Back on the dashboard itself returns to the list it came from
    // (Top Trending / token search / screening list).
    if (session.pool) {
      const origin = session.listKind;
      session.pool = null;
      if (origin === "trending") {
        await showTrendingView({ msg, messageId: msg.messageId });
      } else if (origin === "token" && session.tokenQuery?.mint) {
        await openTokenByMint(msg, session.tokenQuery.mint, { messageId: msg.messageId });
      } else {
        await showPoolListView({ msg, messageId: msg.messageId });
      }
      return true;
    }
    await showPoolListView({ msg, messageId: msg.messageId });
    return true;
  }

  if (action === "continue") {
    await ack();
    const wallet = await getWalletSnapshot();
    const amountSol = await resolveAmountSol(session, wallet);
    const pool = session.pool || {};
    const confirmText = [
      "🧾 <b>Confirm position</b>",
      "─────────────────────────",
      `Pool: <b>${escapeHtml(pool.name || "?")}</b>`,
      `Bin step: ${pool.binStep ?? "?"} · Base fee: ${pool.baseFee != null ? `${formatSolAmount(pool.baseFee, 2)}%` : "?"}`,
      `Amount: <b>${formatSolAmount(amountSol)} SOL</b>`,
      `Range: <b>${describeRange(session)}</b>`,
      `Strategy: <b>${escapeHtml(strategyLabel(session.strategy))}</b>`,
      "",
      Number(session.upsidePct ?? 0) > 0
        ? "⚠️ Two-sided range — half the SOL will be swapped into the base token first."
        : session.rangeUpperPct != null
          ? "📉 Below-price limit order — the whole position sits under the active price and fills as it drops."
          : "ℹ️ Single-sided SOL range (upper bin = active bin).",
      "",
      "Tap ⚡ Deploy Position to sign.",
    ].join("\n");
    await presentMessage(
      { text: confirmText, keyboard: [[btn("⚡ Deploy Position", "deploy")], [btn("⬅️ Back", "back")]] },
      msg.messageId,
    );
    return true;
  }

  if (action === "deploy") {
    await ack("Deploying…");
    try {
      const result = await deploySession(msg, session);
      await sendHTML(formatDeployResult(result));
      await presentDashboard(msg, { messageId: msg.messageId });
    } catch (error) {
      log("lp_ui_error", `Deploy failed: ${error.message}`);
      await presentDashboard(msg, { note: `Deploy failed: ${error.message}`, messageId: msg.messageId });
    }
    return true;
  }

  await ack("Unknown action");
  return true;
}

