// tools/wallet-tracker.js
// Optional smart-wallet convergence radar.
//
// Adapted from the reference implementation in yunus-0x/meridian:
//   standalone/store.js   -> qualifyingEvents() / acceptEvents()
//   standalone/monitor.js -> distinct-wallet window + signal emission
//
// Counts distinct tracked wallets that add liquidity to the same mint inside a
// rolling window (default: 2 wallets / 120s). Emits one Telegram alert per mint
// per cooldown. Auto-deploy is OFF unless walletTrackerAutoDeploy is true.
//
// The module is opt-in: nothing runs until recordWalletLpEntry() or
// startWalletTracker() is called by an external entrypoint.

import { config } from "../config.js";
import { log } from "../logger.js";
import { sendMessage } from "../telegram.js";

const DEFAULT_WINDOW_SEC = 120;
const DEFAULT_MIN_WALLETS = 2;
const DEFAULT_POLL_SEC = 30;
const DEFAULT_COOLDOWN_SEC = 300;
const MAX_EVENTS_PER_MINT = 200;
const MAX_TRACKED_MINTS = 500;
const MAX_SEEN_ENTRIES = 5000;
const MAX_SIGNALS_KEPT = 50;

/** mint -> entry[] (oldest → newest) */
const entriesByMint = new Map();
/** dedupe keys for already-processed LP entries */
const seenEntries = new Set();
/** mint -> epoch ms until the next convergence alert is allowed */
const cooldownUntil = new Map();
/** recent convergence signals (bounded) */
const signals = [];
/** wallet -> Set<positionAddress> for the optional poller baseline */
const walletBaselines = new Map();

let pollTimer = null;
let pollInFlight = false;

function normalizeAddress(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Read config on every call so runtime config edits take effect immediately. */
function options() {
  const cfg = config.walletTracker || {};
  return {
    enabled: Boolean(cfg.walletTrackerEnabled ?? cfg.enabled ?? false),
    autoDeploy: Boolean(cfg.walletTrackerAutoDeploy ?? cfg.autoDeploy ?? false),
    trackedWallets: (Array.isArray(cfg.trackedWallets) ? cfg.trackedWallets : [])
      .map(normalizeAddress)
      .filter(Boolean),
    windowSec: Math.max(1, Number(cfg.windowSec ?? DEFAULT_WINDOW_SEC)),
    minWallets: Math.max(2, Math.round(Number(cfg.minWallets ?? DEFAULT_MIN_WALLETS))),
    pollIntervalSec: Math.max(5, Number(cfg.pollIntervalSec ?? DEFAULT_POLL_SEC)),
    cooldownSec: Math.max(0, Number(cfg.cooldownSec ?? DEFAULT_COOLDOWN_SEC)),
    minDepositSol: Math.max(0, Number(cfg.minDepositSol ?? 0)),
  };
}

function pruneMint(mint, list, now, windowMs) {
  const cutoff = now - windowMs;
  const fresh = list.filter((entry) => entry.at >= cutoff);
  entriesByMint.set(mint, fresh);
  return fresh;
}

/** Keep at most one (latest) entry per wallet — mirrors qualifyingEvents(). */
function distinctWalletEntries(list) {
  const latest = new Map();
  for (const entry of list) {
    const current = latest.get(entry.wallet);
    if (!current || current.at < entry.at) latest.set(entry.wallet, entry);
  }
  return [...latest.values()];
}

function evictStaleMints() {
  if (entriesByMint.size <= MAX_TRACKED_MINTS) return;
  const ranked = [...entriesByMint.entries()]
    .map(([mint, list]) => ({ mint, last: list.length ? list[list.length - 1].at : 0 }))
    .sort((a, b) => a.last - b.last);
  const removeCount = entriesByMint.size - MAX_TRACKED_MINTS;
  for (let i = 0; i < removeCount; i++) {
    entriesByMint.delete(ranked[i].mint);
  }
}

/**
 * Record one LP entry by a tracked wallet.
 * @param {object} input
 * @param {string} input.wallet  signer wallet address (must be in trackedWallets)
 * @param {string} input.mint    base mint the wallet added liquidity to
 * @param {string} [input.pool]  DLMM pool address
 * @param {string} [input.position] position address
 * @param {string} [input.signature] transaction signature (dedupe)
 * @param {number} [input.depositSol] quote-side deposit size
 * @param {number} [input.at] epoch ms of the entry (defaults to now)
 * @returns {Promise<object>} { recorded, converged, alertSent, walletCount, ... }
 */
export async function recordWalletLpEntry(input = {}) {
  const opts = options();
  if (!opts.enabled) {
    return { recorded: false, converged: false, reason: "walletTrackerEnabled is false" };
  }

  const wallet = normalizeAddress(input.wallet);
  const mint = normalizeAddress(input.mint);
  if (!wallet || !mint) {
    return { recorded: false, converged: false, reason: "wallet and mint are required" };
  }
  if (!opts.trackedWallets.includes(wallet)) {
    return { recorded: false, converged: false, reason: "wallet is not in trackedWallets" };
  }

  const now = Date.now();
  const at = Math.min(Number(input.at) || now, now);
  if (now - at > opts.windowSec * 1000) {
    return { recorded: false, converged: false, reason: "entry outside the rolling window" };
  }

  const depositSol = Number(input.depositSol ?? 0);
  if (!Number.isFinite(depositSol) || depositSol < opts.minDepositSol) {
    return {
      recorded: false,
      converged: false,
      reason: `deposit ${input.depositSol ?? 0} is below minDepositSol ${opts.minDepositSol}`,
    };
  }

  const pool = normalizeAddress(input.pool);
  const position = normalizeAddress(input.position);
  const signature = normalizeAddress(input.signature);
  const dedupeKey = `${mint}|${wallet}|${signature || position || pool || "entry"}|${at}`;
  if (seenEntries.has(dedupeKey)) {
    return { recorded: false, converged: false, reason: "duplicate entry" };
  }
  seenEntries.add(dedupeKey);
  if (seenEntries.size > MAX_SEEN_ENTRIES) {
    let dropped = 0;
    for (const key of seenEntries) {
      seenEntries.delete(key);
      if (++dropped >= Math.floor(MAX_SEEN_ENTRIES * 0.1)) break;
    }
  }

  const list = pruneMint(mint, entriesByMint.get(mint) || [], now, opts.windowSec * 1000);
  list.push({
    wallet,
    mint,
    pool: pool || null,
    position: position || null,
    signature: signature || null,
    depositSol,
    at,
  });
  if (list.length > MAX_EVENTS_PER_MINT) list.splice(0, list.length - MAX_EVENTS_PER_MINT);
  entriesByMint.set(mint, list);
  evictStaleMints();

  const uniqueEntries = distinctWalletEntries(list);
  const wallets = uniqueEntries.map((entry) => entry.wallet);
  const converged = wallets.length >= opts.minWallets;

  let signal = null;
  let alertSent = false;
  let deploy = null;

  if (converged && now >= (cooldownUntil.get(mint) || 0)) {
    cooldownUntil.set(mint, now + opts.cooldownSec * 1000);
    signal = {
      mint,
      wallets,
      pools: [...new Set(uniqueEntries.map((entry) => entry.pool).filter(Boolean))],
      entries: uniqueEntries,
      at: new Date(now).toISOString(),
      autoDeploy: opts.autoDeploy,
    };
    signals.push(signal);
    if (signals.length > MAX_SIGNALS_KEPT) signals.shift();

    await notifyConvergence(signal, opts);
    alertSent = true;

    if (opts.autoDeploy) {
      deploy = await autoDeployConvergence(signal, opts);
      signal.deploy = deploy;
    }
  }

  return {
    recorded: true,
    converged,
    alertSent,
    walletCount: wallets.length,
    wallets,
    mint,
    signal,
    cooldownUntil: cooldownUntil.get(mint) || null,
    deploy,
  };
}

async function notifyConvergence(signal, opts) {
  const lines = [
    "🚨 POTENTIAL TOKEN DETECTED via Smart Wallet Radar",
    `Mint: ${signal.mint}`,
    `Wallets (${signal.wallets.length}/${opts.minWallets}): ${signal.wallets.join(", ")}`,
  ];
  if (signal.pools.length) lines.push(`Pools: ${signal.pools.join(", ")}`);
  lines.push(`Window: ${opts.windowSec}s`);
  lines.push(`Auto-deploy: ${opts.autoDeploy ? "enabled" : "disabled"}`);

  try {
    await sendMessage(lines.join("\n"));
    log("wallet_tracker_info", `Convergence alert: ${signal.mint.slice(0, 8)} (${signal.wallets.length} wallets)`);
  } catch (error) {
    log("wallet_tracker_warn", `Convergence alert failed: ${error.message}`);
  }
}

/**
 * Explicit opt-in only. Still flows through executeTool("deploy_position") so
 * executor safety checks, notifications and decision logging apply. Note that
 * deployPosition itself refuses LIVE mode until the read-only guard is removed.
 */
async function autoDeployConvergence(signal, opts) {
  if (!opts.autoDeploy) return null;
  const poolAddress = signal.pools[0];
  if (!poolAddress) return { skipped: true, reason: "no pool address in convergence signal" };

  const amountSol = Number(config.management.deployAmountSol);
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    return { skipped: true, reason: "invalid management.deployAmountSol" };
  }

  try {
    const { executeTool } = await import("./executor.js");
    const result = await executeTool("deploy_position", {
      pool_address: poolAddress,
      amount_sol: amountSol,
      amount_y: amountSol,
      amount_x: 0,
      strategy: config.strategy.strategy,
    });
    const failed = Boolean(result?.error || result?.blocked);
    log(
      failed ? "wallet_tracker_warn" : "wallet_tracker_info",
      `Auto-deploy ${failed ? "failed" : "submitted"} for ${poolAddress.slice(0, 8)}: ${result?.error || result?.reason || (result?.dry_run ? "dry run" : "ok")}`,
    );
    return result;
  } catch (error) {
    log("wallet_tracker_error", `Auto-deploy failed for ${poolAddress.slice(0, 8)}: ${error.message}`);
    return { error: error.message };
  }
}

/** Record a batch of entries sequentially (feed-friendly). */
export async function ingestWalletLpEntries(entries = []) {
  const results = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    results.push(await recordWalletLpEntry(entry));
  }
  return results;
}

async function pollWallets(opts, { establishBaseline = false } = {}) {
  if (pollInFlight) return [];
  pollInFlight = true;
  const discovered = [];
  try {
    const { getMyPositions } = await import("./dlmm.js");
    for (const wallet of opts.trackedWallets) {
      try {
        const result = await getMyPositions({ wallet_address: wallet, force: true, silent: true });
        const positions = Array.isArray(result?.positions) ? result.positions : [];
        const current = new Set(positions.map((position) => position.position).filter(Boolean));
        const previous = walletBaselines.get(wallet) || new Set();

        // The first observation is only a baseline — existing positions are
        // never treated as fresh LP entries (same rule as the reference monitor).
        if (establishBaseline || !walletBaselines.has(wallet)) {
          walletBaselines.set(wallet, current);
          continue;
        }

        for (const position of positions) {
          if (!position?.position || previous.has(position.position)) continue;
          const mint = normalizeAddress(position.base_mint);
          if (!mint) {
            log("wallet_tracker_warn", `New position ${position.position.slice(0, 8)} has no base_mint — skipped`);
            continue;
          }
          // The portfolio poller has no deposit-size data; keep minDepositSol=0
          // to use it, or feed entries via recordWalletLpEntry() with depositSol.
          const outcome = await recordWalletLpEntry({
            wallet,
            mint,
            pool: position.pool,
            position: position.position,
            depositSol: 0,
          });
          discovered.push({ position: position.position, ...outcome });
        }
        walletBaselines.set(wallet, current);
      } catch (error) {
        log("wallet_tracker_warn", `Wallet ${wallet.slice(0, 8)} poll failed: ${error.message}`);
      }
    }
  } finally {
    pollInFlight = false;
  }
  return discovered;
}

/**
 * Optional portfolio poller. Not started automatically — call it from an
 * entrypoint only when walletTrackerEnabled is true.
 */
export async function startWalletTracker() {
  const opts = options();
  if (!opts.enabled) {
    log("wallet_tracker_info", "Wallet tracker disabled (walletTrackerEnabled=false) — not starting");
    return false;
  }
  if (opts.trackedWallets.length === 0) {
    log("wallet_tracker_warn", "Wallet tracker enabled but trackedWallets is empty — nothing to monitor");
    return false;
  }
  if (pollTimer) return true;

  await pollWallets(opts, { establishBaseline: true });
  pollTimer = setInterval(() => {
    pollWallets(options()).catch((error) => log("wallet_tracker_warn", `Tracker poll failed: ${error.message}`));
  }, opts.pollIntervalSec * 1000);
  pollTimer.unref?.();

  log(
    "wallet_tracker_info",
    `Wallet tracker started — ${opts.trackedWallets.length} wallet(s), every ${opts.pollIntervalSec}s, window ${opts.windowSec}s, min ${opts.minWallets} wallets`,
  );
  return true;
}

export function stopWalletTracker() {
  const wasRunning = Boolean(pollTimer);
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  walletBaselines.clear();
  if (wasRunning) log("wallet_tracker_info", "Wallet tracker stopped");
}

/** Inspect current convergence state (mint optional). */
export function getWalletTrackerSnapshot({ mint = null } = {}) {
  const opts = options();
  const now = Date.now();

  if (mint) {
    const target = normalizeAddress(mint);
    const list = pruneMint(target, entriesByMint.get(target) || [], now, opts.windowSec * 1000);
    const unique = distinctWalletEntries(list);
    return {
      enabled: opts.enabled,
      mint: target,
      entries: list.map((entry) => ({ ...entry })),
      wallets: unique.map((entry) => entry.wallet),
      walletCount: unique.length,
      converged: unique.length >= opts.minWallets,
      cooldownUntil: cooldownUntil.get(target) || null,
    };
  }

  return {
    enabled: opts.enabled,
    autoDeploy: opts.autoDeploy,
    trackedWallets: [...opts.trackedWallets],
    windowSec: opts.windowSec,
    minWallets: opts.minWallets,
    pollerRunning: Boolean(pollTimer),
    mints: [...entriesByMint.keys()],
    signals: signals.map((signal) => ({ ...signal })),
  };
}

/** Clear all in-memory state (used by tests and manual resets). */
export function resetWalletTrackerState() {
  stopWalletTracker();
  entriesByMint.clear();
  seenEntries.clear();
  cooldownUntil.clear();
  signals.length = 0;
  walletBaselines.clear();
}
