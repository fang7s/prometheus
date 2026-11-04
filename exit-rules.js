/**
 * Deterministic exit engine — simplified 2-priority hierarchy. 100% numeric
 * JavaScript: NO LLM, no sentiment, no free-text interpretation, and **no candle
 * or historical price fetching** (the old Priority 3 Supertrend 15m check has
 * been removed, so the exit path never touches the network).
 *
 * Every rule is evaluated from the local position snapshot only
 * (`getMyPositions()` / `computePositions()` output + persisted state.json fields).
 *
 * The ONLY automatic close triggers, evaluated in this exact order:
 *
 *   Priority 1 — Hard TP / SL
 *     Total PnL % (unrealized value + claimable/claimed fees vs the initial
 *     deposit — see `resolveTotalPnlPct()`) against
 *     `config.management.takeProfitPct` / `stopLossPct`.
 *     A trailing take-profit (armed peak → drop) belongs to the same family.
 *   Priority 2 — Range out
 *     the active bin has moved FAR above or FAR below the position's outer bounds
 *     (`config.management.outOfRangeBinsToClose`), securing IL / freeing SOL.
 *     Guarded by `hasEnteredRange`: a position that has never traded inside its
 *     bounds (e.g. a below-price limit order still waiting to fill) is skipped so
 *     it can never be range-closed before it fills. The flag is maintained by
 *     `services/positionMonitor.js` (`false` on deploy → `true` on first in-range
 *     tick) and persisted in state.json as `has_entered_range`.
 *
 * Technical oscillators are deliberately NOT part of the exit path. RSI(2) at
 * 90-100, the MACD first-green-candle confluence (the old "Evil Panda" exit) and
 * the Supertrend 15m break closed positions on momentum spikes long before TP/SL
 * or the range bounds were reached, so they no longer trigger automatic closes —
 * and their candle feeds are no longer fetched at all. Indicators may still be
 * reported for context — never used to close a position.
 *
 * Every decision carries the priority, a stable rule id and a greppable headline
 * (`Priority 1: TP hit (+5.00%)`) so operators can see exactly why a position closed.
 */

import { log } from "./logger.js";
import { getTrackedPosition, refreshPositionState } from "./state.js";
import { monitorPosition } from "./services/positionMonitor.js";

/** The two automatic exit priorities, in strict evaluation order. */
export const EXIT_PRIORITY = Object.freeze({
  TP_SL: 1,
  RANGE: 2,
});

export const EXIT_RULES = Object.freeze({
  STOP_LOSS: {
    priority: EXIT_PRIORITY.TP_SL,
    rule: 1,
    name: "Stop-Loss",
    headline: "Priority 1: SL hit",
  },
  TAKE_PROFIT: {
    priority: EXIT_PRIORITY.TP_SL,
    rule: 2,
    name: "Take-Profit",
    headline: "Priority 1: TP hit",
  },
  TRAILING_TP: {
    priority: EXIT_PRIORITY.TP_SL,
    rule: 3,
    name: "Trailing Take-Profit",
    headline: "Priority 1: Trailing TP hit",
  },
  FAR_ABOVE_RANGE: {
    priority: EXIT_PRIORITY.RANGE,
    rule: 4,
    name: "Far Above Range",
    headline: "Priority 2: Far Above Range",
  },
  FAR_BELOW_RANGE: {
    priority: EXIT_PRIORITY.RANGE,
    rule: 5,
    name: "Far Below Range",
    headline: "Priority 2: Far Below Range",
  },
  // Outside the automatic hierarchy — the bid-ask flipper's close-and-redeploy.
  FLIPPER_REBALANCE: {
    priority: 0,
    rule: 9,
    name: "Flipper Rebalance",
    headline: "Flipper Rebalance",
  },
});

function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a normalized rule decision.
 * @param {string} key - key into EXIT_RULES
 * @param {string} reason - human readable reason (numbers included)
 * @param {object} extra - optional extra fields; `headline` overrides the default
 *   priority label (e.g. `Priority 1: TP hit (+5.00%)`)
 */
export function ruleDecision(key, reason, extra = {}) {
  const def = EXIT_RULES[key];
  if (!def) throw new Error(`Unknown exit rule: ${key}`);
  const fields = { ...extra };
  delete fields.headline;
  return {
    action: "CLOSE",
    priority: def.priority,
    rule: def.rule,
    name: def.name,
    rule_key: key,
    reason,
    headline: extra.headline ?? def.headline ?? def.name,
    ...fields,
  };
}

/**
 * A PnL tick is unusable when pricing failed or when the reported loss is
 * implausible for a position that still holds value. Never act on PnL rules
 * with a suspect tick.
 */
export function isPnlSuspect(position, tracked = null) {
  if (!position) return true;
  if (position.pnl_pct_suspicious) return true;
  const pnl = toFiniteNumber(position.pnl_pct);
  if (pnl == null) return false;
  if (pnl > -90) return false;
  if (tracked?.amount_sol && toFiniteNumber(position.total_value_usd) > 0.01) {
    log("rule_engine_warn", `Suspect PnL for ${position.pair}: ${pnl}% but position still has value — skipping PnL rules`);
    return true;
  }
  return false;
}

/**
 * Total PnL % used by Priority 1 — **unrealized value + claimable/claimed fees vs
 * the initial deposit**, exactly the number the on-chain PnL engine reports:
 *
 *   total_pnl_usd = current balance value + unclaimed (claimable) fees
 *                   + already-claimed fees − initial deposit
 *   total_pnl_pct = total_pnl_usd / initial deposit × 100
 *
 * `tools/pnl.js` already folds claimable + collected fees into its `pnl_pct`, so
 * that value is authoritative and returned as-is. When a caller supplies a
 * hand-built payload without `pnl_pct` (history records, tests, legacy state) the
 * percentage is derived from the USD fields instead — never from candle data.
 *
 * Returns `null` when neither a reported percentage nor a usable
 * deposit/value pair is available, so the caller skips the PnL rules.
 *
 * @param {object} position - getMyPositions() entry
 * @param {object|null} tracked - persisted state.json record (deposit fallback)
 * @returns {number|null} total PnL percentage
 */
export function resolveTotalPnlPct(position = {}, tracked = null) {
  const reported = toFiniteNumber(position?.pnl_pct);
  if (reported != null) return reported;

  const pick = (source, ...keys) => {
    for (const key of keys) {
      const value = toFiniteNumber(source?.[key]);
      if (value != null) return value;
    }
    return null;
  };

  const deposit = pick(position, "initial_value_usd", "deposited_usd", "deposit_usd")
    ?? pick(tracked, "initial_value_usd", "deposited_usd", "amount_usd");
  if (deposit == null || !(deposit > 0)) return null;

  // Prefer the always-USD `*_true_usd` fields so SOL-mode snapshots never mix units.
  const pnlUsd = pick(position, "pnl_true_usd", "pnl_usd");
  if (pnlUsd != null) return Math.round((pnlUsd / deposit) * 100 * 100) / 100;

  const currentValue = pick(position, "total_value_true_usd", "total_value_usd", "current_value_usd");
  if (currentValue == null) return null;

  const claimableFees = pick(position, "unclaimed_fees_true_usd", "unclaimed_fees_usd") ?? 0;
  const claimedFees = pick(position, "collected_fees_true_usd", "collected_fees_usd") ?? 0;
  const total = currentValue + claimableFees + claimedFees - deposit;
  return Math.round((total / deposit) * 100 * 100) / 100;
}

/**
 * Deterministically parse the free-text `/set <n> <note>` instruction into
 * numeric overrides. Anything the parser does not understand is treated as a
 * note only — the LLM is never asked to interpret it.
 *
 * Supported forms (case-insensitive):
 *   "take profit 8%"      | "tp 8%"
 *   "stop loss -20%"      | "sl -20%"
 *   "close after 90m"     | "exit in 2h"
 *   "min yield 4%"        | "yield floor 4%"
 */
export function parseInstructionOverrides(instruction) {
  const text = String(instruction || "").toLowerCase();
  const out = {};
  if (!text.trim()) return out;

  let match = text.match(/\b(?:tp|take[\s-]?profit)\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*%/);
  if (match) out.takeProfitPct = Number(match[1]);

  // Natural phrasing: "hold until 5% profit", "close at 8% gain"
  if (out.takeProfitPct == null) {
    match = text.match(/\b(?:until|at)\s+(-?\d+(?:\.\d+)?)\s*%\s*(?:profit|gain|pnl)/);
    if (match) out.takeProfitPct = Number(match[1]);
  }

  match = text.match(/\b(?:sl|stop[\s-]?loss)\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*%/);
  if (match) out.stopLossPct = Number(match[1]);

  match = text.match(/\b(?:close|exit)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const factor = unit.startsWith("h") ? 60 : 1;
    out.closeAfterMinutes = amount * factor;
  }

  match = text.match(/\b(?:min(?:imum)?\s+yield|yield\s+floor)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/);
  if (match) out.minFeePerTvl24h = Number(match[1]);

  return out;
}

function minutesOutOfRangeOf(position, tracked, now = Date.now()) {
  const reported = toFiniteNumber(position?.minutes_out_of_range);
  if (reported != null) return reported;
  const since = tracked?.out_of_range_since;
  if (!since) return 0;
  const ms = now - new Date(since).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60000)) : 0;
}

/**
 * `hasEnteredRange` guard for Priority 2 (pure — reads the payload + tracked
 * state, never writes anything).
 *
 * A limit order deployed below the price starts fully out of range. Range exits
 * must stay disabled until the position has traded inside its bounds at least
 * once, otherwise the very first tick would cancel the order before it filled.
 *
 * Only an explicit `false` blocks the range exit: legacy state records written
 * before this flag existed carry `undefined` and keep the previous behaviour.
 *
 * @param {object} position - getMyPositions() entry (may carry the flag itself)
 * @param {object|null} tracked - persisted state.json record
 * @returns {boolean} true when Priority 2 may evaluate range exits
 */
export function hasEnteredRangeOf(position = {}, tracked = null) {
  const direct = position?.hasEnteredRange ?? position?.has_entered_range;
  const persisted = tracked?.hasEnteredRange ?? tracked?.has_entered_range;
  const flag = direct ?? persisted;
  return flag !== false;
}

/**
 * Priorities 1 and 2 of the simplified exit hierarchy — pure numeric evaluation
 * from the local position snapshot. No I/O, no state writes, no LLM, no technical
 * indicators, **no candle/historical price fetching**.
 *
 * @param {object} position - a getMyPositions() entry
 * @param {object} managementConfig - config.management (with instruction overrides merged)
 * @param {object} ctx - { tracked, overrides, now }
 * @returns {object|null} rule decision or null
 */
export function evaluateExitHierarchy(position, managementConfig = {}, ctx = {}) {
  if (!position) return null;
  const { tracked = null, overrides = {}, now = Date.now() } = ctx;
  // Total PnL % = unrealized value + claimable/claimed fees vs the initial deposit.
  const pnl = resolveTotalPnlPct(position, tracked);
  const suspect = isPnlSuspect(position, tracked);
  const noteSuffix = (key) => (overrides[key] != null ? " (position instruction)" : "");

  // ═══ Priority 1 — hard TP / SL (total percentage PnL) ═══════════
  const stopLossPct = toFiniteNumber(managementConfig.stopLossPct);
  if (!suspect && pnl != null && stopLossPct != null && pnl <= stopLossPct) {
    return ruleDecision(
      "STOP_LOSS",
      // "stop loss" is kept verbatim: lessons.js uses it to accept an extreme
      // loss as a real stop rather than a bad PnL tick.
      `stop loss: PnL ${pnl.toFixed(2)}% <= ${stopLossPct}%${noteSuffix("stopLossPct")}`,
      { headline: `Priority 1: SL hit (${pnl.toFixed(2)}%)`, pnl_pct: pnl },
    );
  }

  const takeProfitPct = toFiniteNumber(managementConfig.takeProfitPct);
  if (!suspect && pnl != null && takeProfitPct != null && pnl >= takeProfitPct) {
    return ruleDecision(
      "TAKE_PROFIT",
      `take profit: PnL ${pnl.toFixed(2)}% >= ${takeProfitPct}%${noteSuffix("takeProfitPct")}`,
      { headline: `Priority 1: TP hit (+${pnl.toFixed(2)}%)`, pnl_pct: pnl },
    );
  }

  // Trailing take-profit is still profit taking, so it stays in priority 1: a
  // confirmed peak armed in state.json and the current tick gave back
  // `trailingDropPct` of it. Armed state is maintained by state.js.
  if (managementConfig.trailingTakeProfit !== false && !suspect && pnl != null && tracked?.trailing_active) {
    const peak = toFiniteNumber(tracked.peak_pnl_pct);
    const drop = toFiniteNumber(managementConfig.trailingDropPct);
    if (peak != null && drop != null) {
      const dropFromPeak = peak - pnl;
      if (dropFromPeak >= drop) {
        return ruleDecision(
          "TRAILING_TP",
          `trailing take profit: peak ${peak.toFixed(2)}% -> current ${pnl.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${drop}%)`,
          {
            headline: `Priority 1: Trailing TP hit (+${pnl.toFixed(2)}%)`,
            peak_pnl_pct: peak,
            current_pnl_pct: pnl,
            drop_from_peak_pct: dropFromPeak,
          },
        );
      }
    }
  }

  // ═══ Priority 2 — range boundaries ══════════════════════════════
  // Range-entry guard: a position deployed as a below-price limit order starts
  // fully out of range and must not be closed by Priority 2 before it has traded
  // inside its bounds at least once. The flag is maintained (one-way false → true)
  // by services/positionMonitor.js on every monitoring tick.
  if (!hasEnteredRangeOf(position, tracked)) {
    log(
      "rule_engine",
      `Priority 2 skipped for ${position.pair || position.position || "position"}: hasEnteredRange=false — limit order has not entered its range yet`,
    );
    return null;
  }

  // "Far" is measured in bins beyond the position's own outer bounds so the
  // threshold scales with the deployed range (`outOfRangeBinsToClose`).
  const activeBin = toFiniteNumber(position.active_bin);
  const upperBin = toFiniteNumber(position.upper_bin);
  const lowerBin = toFiniteNumber(position.lower_bin);
  const binsAway = toFiniteNumber(managementConfig.outOfRangeBinsToClose);

  if (binsAway != null && activeBin != null && upperBin != null && activeBin > upperBin + binsAway) {
    return ruleDecision(
      "FAR_ABOVE_RANGE",
      // "out of range" is kept verbatim: pool-memory / lessons / hivemind use it
      // to classify range exits in win-rate and cooldown bookkeeping.
      `out of range above: active bin ${activeBin} > upper ${upperBin} + ${binsAway}`,
      { distance_bins: activeBin - upperBin },
    );
  }

  if (binsAway != null && activeBin != null && lowerBin != null && activeBin < lowerBin - binsAway) {
    return ruleDecision(
      "FAR_BELOW_RANGE",
      `out of range below: active bin ${activeBin} < lower ${lowerBin} - ${binsAway}`,
      { distance_bins: lowerBin - activeBin },
    );
  }

  // Data-gap backstop: some position snapshots only report `in_range` without bin
  // geometry. Those still respect the range exit after `outOfRangeWaitMinutes`,
  // mapped to the direction that is known (above → Far Above, otherwise Below).
  const aboveRange = activeBin != null && upperBin != null && activeBin > upperBin;
  const flaggedOutOfRange = position.in_range === false;
  if (aboveRange || flaggedOutOfRange) {
    const oorMinutes = minutesOutOfRangeOf(position, tracked, now);
    const waitMinutes = toFiniteNumber(managementConfig.outOfRangeWaitMinutes) ?? Infinity;
    if (oorMinutes >= waitMinutes) {
      return aboveRange
        ? ruleDecision("FAR_ABOVE_RANGE", `out of range above for ${oorMinutes}m (limit ${waitMinutes}m)`)
        : ruleDecision("FAR_BELOW_RANGE", `out of range below for ${oorMinutes}m (limit ${waitMinutes}m)`);
    }
  }

  return null;
}

/**
 * Backwards-compatible alias — the pure numeric evaluator keeps its old name.
 * New code should call `evaluateExitHierarchy()`.
 */
export const evaluateNumericRules = evaluateExitHierarchy;

/**
 * Full deterministic exit evaluation for one position.
 *
 * 1. Reads the persisted instruction and derives numeric TP/SL overrides.
 * 2. Refreshes stateful flags (trailing arm, OOR timestamp) via state.js.
 * 3. Walks the 2-priority hierarchy: Priority 1 (hard TP/SL on total PnL) →
 *    Priority 2 (range out, only once `hasEnteredRange === true`).
 *
 * Synchronous and network-free by design: everything it needs is already in the
 * position snapshot / state.json, so it never blocks the poll loop on I/O.
 *
 * @param {object} position - getMyPositions() entry
 * @param {object} managementConfig - config.management
 * @returns {object|null} rule decision or null
 */
export function detectExit(position, managementConfig = {}) {
  if (!position?.position) return null;

  const trackedBefore = getTrackedPosition(position.position);
  const overrides = parseInstructionOverrides(trackedBefore?.instruction);

  const cfg = { ...managementConfig };
  const applied = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null || !Number.isFinite(value)) continue;
    cfg[key] = value;
    applied[key] = value;
  }

  // Range-entry tick: flips + persists `hasEnteredRange` the first time the
  // price trades inside the position's bounds (one-way, idempotent per tick).
  monitorPosition(position, { tracked: trackedBefore });

  // State mutations only (trailing arm + OOR bookkeeping) — never an exit here.
  const tracked = refreshPositionState(position.position, position, cfg) ?? trackedBefore;

  return evaluateExitHierarchy(position, cfg, { tracked, overrides: applied });
}

/**
 * Exact, greppable pre-execution log line for every exit event.
 *
 * Examples:
 *   `[EXIT] Priority 1: TP hit (+5.00%) — HYPE/USDC`
 *   `[EXIT] Priority 1: SL hit (-52.00%) — HYPE/USDC`
 *   `[EXIT] Priority 2: Far Above Range — HYPE/USDC`
 *   `[EXIT] Priority 2: Far Below Range — HYPE/USDC`
 */
export function formatExitLog(pair, decision) {
  const label = pair || "position";
  const headline = decision?.headline
    || (decision?.priority ? `Priority ${decision.priority}: ${decision.name}` : decision?.name || "Exit");
  return `[EXIT] ${headline} — ${label}`;
}

