/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

// ─── Per-position configuration ─────────────────────────────────
/**
 * Independent management parameters for ONE position. Every tracked position
 * owns its own copy under `positions[address].config`, so changing TP/SL or
 * slippage for the DIAMOND-SOL position never touches any other open position
 * (nor the global `config.management` defaults).
 *
 * Defaults applied to every newly opened position:
 *   TP +5.0 % · SL -50.0 % · Slippage 10 % (1000 BPS) · auto-rebalance off
 */
export const DEFAULT_POSITION_CONFIG = Object.freeze({
  /** Take-profit threshold % — Priority 1 exit when total PnL >= +tpPercent. */
  tpPercent: 5,
  /** Stop-loss threshold % — Priority 1 exit when total PnL <= slPercent. */
  slPercent: -50,
  /** Deposit / withdraw slippage tolerance in BPS (1000 BPS = 10 %). */
  slippageBps: 1000,
  /** Close + redeploy around the active bin when the position drifts out of range. */
  autoRebalance: false,
});

/** Accepted range for every per-position knob — anything unusable falls back. */
export const POSITION_CONFIG_LIMITS = Object.freeze({
  tpPercent: Object.freeze({ min: 0.1, max: 10_000 }),
  slPercent: Object.freeze({ min: -100, max: -0.1 }),
  slippageBps: Object.freeze({ min: 1, max: 5_000 }),
});

function clampConfigNumber(value, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function roundConfigNumber(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function configBoolOrNull(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (/^(true|1|yes|on|enabled?)$/.test(raw)) return true;
  if (/^(false|0|no|off|disabled?)$/.test(raw)) return false;
  return null;
}

/** `base` with defaults applied, so a partial base still yields a full config. */
function normalizeConfigBase(base) {
  const source = base && typeof base === "object" ? base : {};
  return {
    tpPercent: Number.isFinite(Number(source.tpPercent)) ? Number(source.tpPercent) : DEFAULT_POSITION_CONFIG.tpPercent,
    slPercent: Number.isFinite(Number(source.slPercent)) ? Number(source.slPercent) : DEFAULT_POSITION_CONFIG.slPercent,
    slippageBps: Number.isFinite(Number(source.slippageBps)) ? Number(source.slippageBps) : DEFAULT_POSITION_CONFIG.slippageBps,
    autoRebalance: typeof source.autoRebalance === "boolean" ? source.autoRebalance : DEFAULT_POSITION_CONFIG.autoRebalance,
  };
}

/**
 * Pure normalizer for a position config patch. Accepts camelCase and the
 * snake_case variants found in older state.json records, fills every missing or
 * unusable value from `base` (default-backed) and clamps the numbers so a bad
 * input can never disable risk management.
 *
 * @param {object} patch - partial config from the UI / state.json
 * @param {object} base - current config the patch is applied on top of
 * @returns {{tpPercent:number, slPercent:number, slippageBps:number, autoRebalance:boolean}}
 */
export function normalizePositionConfig(patch = {}, base = DEFAULT_POSITION_CONFIG) {
  const source = patch && typeof patch === "object" ? patch : {};
  const fallback = normalizeConfigBase(base);

  const rawTp = source.tpPercent ?? source.tp_percent ?? source.takeProfitPct ?? source.take_profit_pct;
  const tpNumber = Number(rawTp);
  const tp = Number.isFinite(tpNumber) && tpNumber > 0
    ? clampConfigNumber(tpNumber, POSITION_CONFIG_LIMITS.tpPercent)
    : null;

  // Stop-loss is always stored as a negative %: a bare "30" means -30 %.
  const rawSl = source.slPercent ?? source.sl_percent ?? source.stopLossPct ?? source.stop_loss_pct;
  const slNumber = Number(rawSl);
  const slCandidate = Number.isFinite(slNumber) && slNumber !== 0
    ? clampConfigNumber(slNumber > 0 ? -slNumber : slNumber, POSITION_CONFIG_LIMITS.slPercent)
    : null;

  // Slippage may arrive as BPS (1000) or as a percentage (10 %).
  const rawSlip = source.slippageBps ?? source.slippage_bps ?? source.slippage;
  const slipNumber = Number(rawSlip);
  let slip = Number.isFinite(slipNumber) && slipNumber > 0
    ? clampConfigNumber(slipNumber, POSITION_CONFIG_LIMITS.slippageBps)
    : null;
  if (slip == null) {
    const pct = Number(source.slippagePct ?? source.slippage_pct);
    if (Number.isFinite(pct) && pct > 0) slip = clampConfigNumber(pct * 100, POSITION_CONFIG_LIMITS.slippageBps);
  }

  const autoRebalance = configBoolOrNull(source.autoRebalance ?? source.auto_rebalance)
    ?? fallback.autoRebalance;

  return {
    tpPercent: roundConfigNumber(tp ?? fallback.tpPercent),
    slPercent: roundConfigNumber(slCandidate ?? fallback.slPercent),
    slippageBps: Math.round(slip ?? fallback.slippageBps),
    autoRebalance,
  };
}

/**
 * Complete config for a persisted position record. Records written before
 * per-position configs existed simply resolve to the defaults.
 */
export function resolvePositionConfig(record = null) {
  return normalizePositionConfig(record?.config ?? record?.position_config ?? {});
}

/**
 * Config of one position, addressed by its position account (`positionAddress`).
 * Unknown positions resolve to the defaults so callers never see `undefined`.
 */
export function getPositionConfig(position_address) {
  const state = load();
  return resolvePositionConfig(state.positions?.[position_address] ?? null);
}

/**
 * Persist an independent config change for ONE position. Only the supplied keys
 * change — every other position keeps its own values and the global defaults are
 * never written. Returns the merged config, or null when the position is
 * unknown (e.g. it was already closed and pruned).
 *
 * @param {string} position_address - position account address
 * @param {object} patch - e.g. `{ tpPercent: 10 }`, `{ slippageBps: 300 }`
 * @returns {object|null}
 */
export function setPositionConfig(position_address, patch = {}) {
  const state = load();
  const pos = state.positions?.[position_address];
  if (!pos) {
    log("state", `Cannot update config — position ${position_address} is not tracked`);
    return null;
  }
  const base = resolvePositionConfig(pos);
  const next = normalizePositionConfig(patch, base);
  const changed = Object.keys(next).some((key) => next[key] !== base[key]);
  pos.config = next;
  if (changed) {
    pushEvent(state, {
      action: "position_config",
      position: position_address,
      pool_name: pos.pool_name || pos.pool,
      config: next,
    });
    log("state", `Position ${position_address} config → ${JSON.stringify(next)}`);
  }
  save(state);
  return next;
}

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
  config = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    // Independent per-position management settings. A brand-new position always
    // starts from the defaults (TP +5 % / SL -50 % / 1000 BPS slippage / no
    // auto-rebalance) unless the caller (e.g. a rebalance) inherits a config.
    config: normalizePositionConfig(config ?? {}),
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    // Range-entry guard for Priority 2 exits: a fresh position starts "not yet
    // entered" so a below-price limit order can never be range-closed before it
    // has traded inside the range at least once (see services/positionMonitor.js).
    has_entered_range: false,
    range_entered_at: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * One-way range-entry transition: the position traded inside its bounds at least
 * once, so Priority 2 range exits are allowed from now on.
 *
 * Returns true when the flag was written by this call (false when the position
 * is unknown/closed or had already entered its range).
 */
export function markRangeEntered(position_address, at = Date.now()) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;
  if (pos.has_entered_range === true) return false;
  pos.has_entered_range = true;
  const stamp = new Date(Number.isFinite(Number(at)) ? Number(at) : Date.now()).toISOString();
  pos.range_entered_at = stamp;
  pushEvent(state, { action: "enter_range", position: position_address, pool_name: pos.pool_name || pos.pool });
  save(state);
  log("state", `Position ${position_address} entered range at ${stamp}`);
  return true;
}

/**
 * Current persisted range-entry flag (`false` when unknown/not yet entered).
 */
export function hasEnteredRange(position_address) {
  const state = load();
  return state.positions[position_address]?.has_entered_range === true;
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Record a rebalance (close + redeploy around the active bin) for one position.
 * The tracked record belongs to the OLD position account, which is already
 * marked closed by `closePosition()` — the counter and the note still land on
 * it so the history stays auditable, and `rebalanced_into` points at the fresh
 * position account.
 *
 * @param {string} position_address - position account that was rebalanced
 * @param {{reason?: string|null, new_position?: string|null}} [details]
 * @returns {boolean} true when the position was tracked
 */
export function recordRebalance(position_address, { reason = null, new_position = null } = {}) {
  const state = load();
  const pos = state.positions?.[position_address];
  if (!pos) return false;
  pos.rebalance_count = (pos.rebalance_count || 0) + 1;
  pos.last_rebalance_at = new Date().toISOString();
  if (new_position) pos.rebalanced_into = new_position;
  pos.notes.push(`Rebalanced at ${pos.last_rebalance_at}${reason ? `: ${reason}` : ""}`);
  pushEvent(state, {
    action: "rebalance",
    position: position_address,
    pool_name: pos.pool_name || pos.pool,
    reason,
    new_position,
  });
  save(state);
  log("state", `Position ${position_address} rebalanced${new_position ? ` into ${new_position}` : ""}`);
  return true;
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Replaces the old 15s setTimeout recheck.
 * Returns true when the peak was raised this call.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. The fast poller calls this every
 * tick with the exit action string detected this poll (or null when no exit). An exit
 * only fires after `confirmTicks` consecutive polls report the SAME action — so a single
 * noisy tick can't close a position. Streak resets whenever the signal clears or changes.
 * Returns { fire, action, count }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      has_entered_range: p.has_entered_range === true,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
      // Independent per-position management settings (defaults if absent).
      config: resolvePositionConfig(p),
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Refresh stateful exit bookkeeping for a position:
 * - arm trailing TP once the confirmed peak clears `trailingTriggerPct`
 * - stamp / clear `out_of_range_since` from the live `in_range` flag
 *
 * Returns the tracked record (or null when unknown/closed). This function never
 * makes an exit decision — the deterministic engine in `exit-rules.js` owns
 * that. Safe to call from every poll tick.
 */
export function refreshPositionState(position_address, positionData = {}, mgmtConfig = {}) {
  const { in_range } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  let changed = false;

  // Activate trailing TP once the confirmed peak clears the trigger threshold
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active) {
    const trigger = Number(mgmtConfig.trailingTriggerPct);
    if (Number.isFinite(trigger) && (pos.peak_pnl_pct ?? 0) >= trigger) {
      pos.trailing_active = true;
      changed = true;
      log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
    }
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);
  return pos;
}

/**
 * @deprecated Legacy wrapper kept for API compatibility. New code should use
 * `detectExit()` from `exit-rules.js`, which is the single deterministic exit
 * engine (no LLM involved anywhere).
 *
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig = {}) {
  const pos = refreshPositionState(position_address, positionData, mgmtConfig);
  if (!pos) return null;

  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, fee_per_tvl_24h } = positionData;

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
