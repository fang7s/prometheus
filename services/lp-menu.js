/**
 * Interactive Telegram LP menu (inline keyboards) for Meteora DLMM.
 *
 * Flow:
 *   /lp  →  screening view (pool buttons)
 *        →  pool dashboard (Quick Zap / Amount / Range / Strategy)
 *        →  Continue → Deploy → `services/meteoraService.js#openDlmmPosition`
 *
 * All callback data is prefixed `lp:` so `index.js#telegramHandler` can route it
 * without touching the existing `cfg:` settings-menu router. Session state is
 * kept in memory (per chat + user) — restarting the bot clears it, which is the
 * safest behaviour for a wallet-signing flow.
 */

import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getTopCandidates } from "../tools/screening.js";
import {
  sendHTMLWithButtons,
  editHTMLWithButtons,
  sendHTML,
  answerCallbackQuery,
} from "../telegram.js";
import {
  openDlmmPosition,
  getPoolSnapshot,
  getPoolMetadata,
  computeBinRange,
  strategyLabel,
  normalizeStrategyKind,
} from "./meteoraService.js";

const CALLBACK_PREFIX = "lp:";
const POOL_LIST_LIMIT = 6;
const POOL_LIST_TTL_MS = 60_000;
const WALLET_TTL_MS = 30_000;
const SESSION_TTL_MS = 30 * 60_000;

// ─── Formatting helpers ───────────────────────────────────────────
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function formatSolAmount(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  if (n === 0) return "0";
  if (n < 0.001) return n.toExponential(2);
  return n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

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
 * Accepts "-50", "-50%", "-30 +40", "+200%", "30/40", "-30,40".
 * The first number is the downside %, the optional second is the upside %.
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
  if (parts.length === 1) {
    const single = numbers[0];
    if (single < 0) downsidePct = Math.abs(single);
    else upsidePct = single;
  } else {
    downsidePct = Math.abs(numbers[0]);
    upsidePct = Math.abs(numbers[1]);
  }
  if (downsidePct >= 100) return null;
  if (downsidePct === 0 && upsidePct === 0) return null;
  return { downsidePct, upsidePct };
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
    const data = await getWalletBalances();
    _walletCache = { at: Date.now(), data };
    return data;
  } catch (error) {
    log("lp_ui_warn", `Wallet snapshot failed: ${error.message}`);
    return _walletCache.data || { wallet: null, sol: 0, sol_usd: 0, tokens: [] };
  }
}

let _poolList = { at: 0, pools: [] };
const _activeBinCache = new Map(); // address -> { at, sol, binId, binStep, baseFee }
const ACTIVE_BIN_TTL_MS = 60_000;
const ACTIVE_BIN_BUDGET_MS = 3_500;

async function withTimeout(promise, ms) {
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
    const snapshot = await withTimeout(getPoolSnapshot(pool.address).catch(() => null), ACTIVE_BIN_BUDGET_MS);
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
  const top = await getTopCandidates({ limit: POOL_LIST_LIMIT });
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
    rangeLabel: "-50%",
    awaiting: null,
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

export function renderMainMenu({ pools = [], wallet = null, note = null } = {}) {
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
    `✅ <b>DLMM Pools</b> · ${pools.length} found (by Fee/TVL ${escapeHtml(tf)}) · page 1/1`,
    "─────────────────────────",
    ...pools.map((pool, index) => formatPoolLine(pool, index)),
    "",
    note ? `<i>${escapeHtml(note)}</i>` : null,
    "👆 Tap a pool below to open a position, or paste a pool address / link.",
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
  rows.push([btn("🔄 Refresh", "refresh"), btn("⬅️ Main Menu", "main")]);
  return rows;
}

// ─── Pool dashboard rendering ─────────────────────────────────────
function mark(isSelected, label) {
  return isSelected ? `✅ ${label}` : label;
}

function describeAmount(session, wallet) {
  if (session.amountMode === "pct") {
    const available = Math.max(0, Number(wallet?.sol ?? 0) - Number(config.management?.gasReserve ?? 0));
    const sol = (available * Number(session.amountPct ?? 0)) / 100;
    return `${session.amountPct}% (≈${formatSolAmount(sol)} SOL)`;
  }
  return `${formatSolAmount(session.amountSol)} SOL`;
}

function describeRange(session) {
  const down = Number(session.downsidePct ?? 0);
  const up = Number(session.upsidePct ?? 0);
  if (up > 0) return `-${down}% → +${up}%`;
  return `-${down}% → 0% (single-sided)`;
}

export function renderDashboard(session, { wallet = null, note = null } = {}) {
  const pool = session.pool || {};
  const amountLabel = describeAmount(session, wallet);
  const twoSided = Number(session.upsidePct ?? 0) > 0;
  const mcap = Number(pool.mcap ?? 0);
  const down = Number(session.downsidePct ?? 0);
  const up = Number(session.upsidePct ?? 0);
  const binStep = pool.binStep ?? "?";
  const baseFee = pool.baseFee != null ? `${formatSolAmount(pool.baseFee, 2)}%` : "?";

  const lines = [
    `📊 <b>New Position: ${escapeHtml(pool.name || "pool")}</b>`,
    `Binstep: ${binStep} · BaseFee: ${baseFee}`,
    "─────────────────────────",
    pool.activeBinId != null
      ? `🎯 Active bin: <b>${pool.activeBinId}</b>${pool.activeBinSol != null ? ` · ${formatSolAmount(pool.activeBinSol)} SOL in bin` : ""}`
      : null,
    pool.activeBinSol != null && pool.activeBinId != null
      ? `💧 1 bin ≈ ${formatSolAmount(pool.activeBinSol)} SOL`
      : null,
    pool.tvl != null
      ? `🩺 TVL ${formatUsd(pool.tvl)} · Fee/TVL ${pool.feeTvl != null ? `${Number(pool.feeTvl).toFixed(2)}%` : "?"} · APR≈${pool.apr != null && Number.isFinite(pool.apr) ? `${Number(pool.apr).toFixed(1)}%` : "?"}`
      : null,
    "",
    `💵 Amount: <b>${amountLabel}</b>`,
    `🧭 Range: <b>${describeRange(session)}</b>`,
    session.rangePreview
      ? `🗂 Bins: <b>${session.rangePreview.minBinId}</b> → <b>${session.rangePreview.maxBinId}</b> (${session.rangePreview.totalBins} bins)`
      : null,
    mcap > 0
      ? `🏦 Range MC: ${formatUsd(mcap * Math.max(0, 1 - down / 100))} → ${formatUsd(mcap * (1 + up / 100))}`
      : null,
    `🎨 Strategy: <b>${escapeHtml(strategyLabel(session.strategy))}</b>`,
    `🛡 Slippage: 10% · Max deploy: ${formatSolAmount(config.risk?.maxDeployAmount ?? 0, 2)} SOL`,
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

  return [
    [btn("───────── ⚡ QUICK ZAP ─────────", "noop")],
    [btn("⚡ Preset A", "zap:a"), btn("⚡ Preset B", "zap:b"), btn("🛠 Custom", "zap:custom")],

    [btn("─────── 💧 LIQUIDITY AMOUNT ───────", "noop")],
    [btn(mark(isSol(1), "1 SOL"), "amt:1"), btn(mark(isPct(50), "50%"), "amt:50"), btn(mark(isPct(100), "100%"), "amt:100")],
    [btn(mark(isCustomAmount, "✏️ Custom"), "amt:custom"), btn("📋 Preset", "amt:preset")],

    [btn("────────── 📐 RANGE ──────────", "noop")],
    [
      btn(mark(rangeSel("-50%"), "-50%"), "rng:-50"),
      btn(mark(rangeSel("-30 +40"), "-30 +40"), "rng:m30p40"),
      btn(mark(rangeSel("+200%"), "+200%"), "rng:p200"),
    ],
    [btn(mark(rangeSel("Default"), "⭐ Default"), "rng:default"), btn(mark(rangeSel("Custom"), "Range"), "rng:custom"), btn("📋 Preset", "rng:preset")],

    [btn("────────── 🎨 STRATEGY ──────────", "noop")],
    [
      btn(mark(session.strategy === "spot", "➖ Spot"), "str:spot"),
      btn(mark(session.strategy === "bid_ask", "⚓ BidAsk"), "str:bid_ask"),
      btn(mark(session.strategy === "curve", "🔔 Curve"), "str:curve"),
    ],
    [
      btn(mark(session.strategy === "spot_ba", "⚡ Spot & BA"), "str:spot_ba"),
      btn(mark(session.strategy === "spot_curve", "⚡ Spot & Curve"), "str:spot_curve"),
    ],

    [btn("────────── OTHER ──────────", "noop")],
    [btn("✅ Continue", "continue")],
    [btn("⚡ Deploy Position", "deploy")],
    [btn("🔄 Refresh", "refresh"), btn("⬅️ Main Menu", "main")],
  ];
}

// ─── Sending / editing ────────────────────────────────────────────
const _lastView = new Map(); // messageId -> signature, to avoid "not modified" duplicate sends

function viewSignature(text, keyboard) {
  return `${text}::${JSON.stringify(keyboard)}`;
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

export async function showLpMainMenu({ messageId = null, force = false, note = null, msg = null } = {}) {
  const session = msg ? getLpSession(msg) : null;
  if (session) {
    session.awaiting = null;
    session.pool = null;
    session.messageId = messageId ?? session.messageId;
  }

  let pools = [];
  let scanError = null;
  try {
    pools = await loadMenuPools({ force });
  } catch (error) {
    scanError = error.message;
    log("lp_ui_warn", `Screening failed: ${error.message}`);
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
  });
  const newMessageId = await presentMessage(view, messageId ?? session?.messageId ?? null);
  if (session) session.messageId = newMessageId;
  return newMessageId;
}

async function presentDashboard(msg, { note = null, messageId = null } = {}) {
  const session = touch(getLpSession(msg));

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
  return newId;
}

// ─── Pool selection ───────────────────────────────────────────────
async function selectPool(msg, index) {
  const session = touch(getLpSession(msg));
  if (!session.pools.length) {
    session.pools = await loadMenuPools();
  }
  const entry = session.pools[index];
  if (!entry) {
    await showLpMainMenu({ msg, messageId: msg.messageId, note: "That pool is no longer in the list — refreshed." });
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

function applyRangePreset(session, key) {
  const binStep = Number(session.pool?.binStep ?? 0);
  const defaultBins = Number(config.strategy?.defaultBinsBelow ?? 69);
  const defaultPct = binsToDownsidePct(defaultBins, binStep);
  switch (key) {
    case "-50":
      session.downsidePct = 50;
      session.upsidePct = 0;
      session.rangeLabel = "-50%";
      return true;
    case "m30p40":
      session.downsidePct = 30;
      session.upsidePct = 40;
      session.rangeLabel = "-30 +40";
      return true;
    case "p200":
      session.downsidePct = 0;
      session.upsidePct = 200;
      session.rangeLabel = "+200%";
      return true;
    case "default":
    case "preset": {
      if (defaultPct == null) return false;
      session.downsidePct = defaultPct;
      session.upsidePct = 0;
      session.rangeLabel = key === "default" ? "Default" : "Preset";
      return true;
    }
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
    `💵 Amount: ${formatSolAmount(result?.amount_sol)} SOL${result?.two_sided && result?.amount_token ? ` + ${formatSolAmount(result.amount_token)} base` : ""}`,
    `🧭 Bins: ${range.minBinId ?? "?"} → ${range.maxBinId ?? "?"} (active ${range.activeBinId ?? result?.active_bin ?? "?"})`,
    `📈 Price: ${pr}`,
    range.downsideCoveragePct != null
      ? `🛡 Coverage: -${Math.abs(Number(range.downsideCoveragePct)).toFixed(2)}% / +${Number(range.upsideCoveragePct ?? 0).toFixed(2)}%`
      : null,
    `🎨 Strategy: ${escapeHtml(result?.strategy_label || strategyLabel(result?.strategy || "bid_ask"))}`,
    result?.swap_tx ? `🔁 Zap swap: <code>${escapeHtml(result.swap_tx)}</code>` : null,
    positions.length ? `\n📦 Positions:\n${positions.join("\n")}` : null,
    result?.txs?.length ? `\n🔗 Tx: <code>${escapeHtml(result.txs[0])}</code>` : null,
    result?.txs?.length > 1 ? `<i>+${result.txs.length - 1} more transaction(s)</i>` : null,
    result?.dry_run ? "\nSet <code>DRY_RUN=false</code> + <code>ENABLE_LIVE_TRADING=true</code> to go live." : null,
  ].filter((value) => value !== null && value !== undefined).join("\n");
}

async function deploySession(msg, session) {
  const pool = session.pool;
  if (!pool?.address) throw new Error("Pick a pool first — tap ⬅️ Main Menu and choose one.");
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
export async function openPoolByAddress(msg, address) {
  const session = touch(getLpSession(msg));
  let note = null;
  const entry = session.pools.find((pool) => pool.address === address) || { address };

  if (!entry.name) {
    const [meta, snapshot] = await Promise.all([
      getPoolMetadata(address).catch(() => null),
      getPoolSnapshot(address).catch((error) => {
        note = `Could not read the pool on-chain: ${error.message}`;
        return null;
      }),
    ]);
    if (!snapshot && !meta) {
      await showLpMainMenu({ msg, messageId: msg.messageId, note: `Pool ${address.slice(0, 8)}… is not readable.` });
      return;
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
}

// ─── Custom text input ────────────────────────────────────────────
/**
 * Consume a plain-text message when it answers a Custom prompt
 * (`lp:amt:custom`, `lp:rng:custom`) or is a pasted pool address/link.
 * Returns true when the message was handled here.
 */
export async function handleLpText(msg) {
  const text = String(msg?.text ?? "").trim();
  if (!text || msg?.isCallback || text.startsWith("/")) return false;

  const session = sessions.get(sessionKey(msg));
  if (!session || Date.now() - session.updatedAt >= SESSION_TTL_MS) return false;
  const awaiting = session.awaiting;

  if (awaiting === "amount") {
    const parsed = parseAmountInput(text);
    if (!parsed) {
      await sendHTML("❌ Could not read that amount. Send a number like <code>0.5</code> or a percentage like <code>50%</code>.");
      return true;
    }
    session.amountMode = parsed.mode;
    if (parsed.mode === "pct") {
      session.amountPct = parsed.value;
    } else {
      session.amountSol = parsed.value;
      session.amountPct = null;
    }
    session.awaiting = null;
    await presentDashboard(msg, { messageId: session.messageId });
    return true;
  }

  if (awaiting === "range") {
    const parsed = parseRangeInput(text);
    if (!parsed) {
      await sendHTML("❌ Could not read that range. Try <code>-40</code>, <code>-30 +40</code> or <code>+150</code>.");
      return true;
    }
    session.downsidePct = parsed.downsidePct;
    session.upsidePct = parsed.upsidePct;
    session.rangeLabel = "Custom";
    session.awaiting = null;
    await presentDashboard(msg, { messageId: session.messageId });
    return true;
  }

  const address = (isSolanaAddress(text) || /^https?:\/\/\S+$/i.test(text))
    ? extractPoolAddress(text)
    : null;
  if (address) {
    await openPoolByAddress(msg, address);
    return true;
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
        const snapshot = await getPoolSnapshot(session.pool.address);
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
      await showLpMainMenu({ msg, messageId: msg.messageId, force: true });
    }
    return true;
  }

  if (action === "pool") {
    await ack();
    await selectPool(msg, Number(arg));
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
    if (session.pool) await presentDashboard(msg, { messageId: msg.messageId });
    else await showLpMainMenu({ msg, messageId: msg.messageId });
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

