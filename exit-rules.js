/**
 * Deterministic exit engine — strict, simplified priority hierarchy. 100% numeric
 * JavaScript: NO LLM, no sentiment, no free-text interpretation.
 *
 * The ONLY automatic close triggers, evaluated in this exact order:
 *
 *   Priority 1 — Immediate TP / SL
 *     `pnl_pct` against `config.management.takeProfitPct` / `stopLossPct`.
 *     A trailing take-profit (armed peak → drop) belongs to the same family.
 *   Priority 2 — Range boundaries
 *     the active bin has moved FAR above or FAR below the position's outer bounds
 *     (`config.management.outOfRangeBinsToClose`), securing IL / freeing SOL.
 *   Priority 3 — Supertrend 15m candle break
 *     the latest *closed* 15m candle closes through the Supertrend line
 *     (1-candle break, fallback safety net). Needs a candle feed, so the caller
 *     evaluates it via `evaluateSupertrendExit()` only when 1 and 2 did not fire.
 *
 * Technical oscillators are deliberately NOT part of the exit path. RSI(2) at
 * 90-100 and the MACD first-green-candle confluence (the old "Evil Panda" exit)
 * closed positions on momentum spikes long before TP/SL or the range bounds were
 * reached, so they no longer trigger automatic closes. Indicators may still be
 * reported for context — never used to close a position.
 *
 * Every decision carries the priority, a stable rule id and a greppable headline
 * (`Priority 1: TP hit (+5.00%)`) so operators can see exactly why a position closed.
 */

import { log } from "./logger.js";
import { getTrackedPosition, refreshPositionState } from "./state.js";

/** The three automatic exit priorities, in strict evaluation order. */
export const EXIT_PRIORITY = Object.freeze({
  TP_SL: 1,
  RANGE: 2,
  SUPERTREND: 3,
});

/** The Supertrend safety net only ever reads the 15m timeframe. */
export const SUPERTREND_INTERVAL = "15_MINUTE";

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
  SUPERTREND_BREAK: {
    priority: EXIT_PRIORITY.SUPERTREND,
    rule: 6,
    name: "Supertrend 15m Candle Break",
    headline: "Priority 3: Supertrend 15m Candle Break",
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
 * Priorities 1 and 2 of the exit hierarchy — pure numeric evaluation. No I/O, no
 * state writes, no LLM, no technical indicators.
 *
 * Priority 3 (Supertrend 15m break) lives in `evaluateSupertrendExit()` and is
 * only consulted by the caller when this function returns null.
 *
 * @param {object} position - a getMyPositions() entry
 * @param {object} managementConfig - config.management (with instruction overrides merged)
 * @param {object} ctx - { tracked, overrides, now }
 * @returns {object|null} rule decision or null
 */
export function evaluateExitHierarchy(position, managementConfig = {}, ctx = {}) {
  if (!position) return null;
  const { tracked = null, overrides = {}, now = Date.now() } = ctx;
  const pnl = toFiniteNumber(position.pnl_pct);
  const suspect = isPnlSuspect(position, tracked);
  const noteSuffix = (key) => (overrides[key] != null ? " (position instruction)" : "");

  // ═══ Priority 1 — immediate TP / SL (percentage PnL) ════════════
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
 * Priority 3 — Supertrend 15m candle break (fallback safety net).
 *
 * Break condition = the latest **closed** 15m candle:
 *   - the API flagged `supertrendBreakDown` on that candle, or
 *   - the candle closed strictly below the Supertrend line.
 *
 * A single candle close is enough by design. Only genuine Supertrend data is
 * consulted — RSI/MACD/Bollinger values in the same payload are ignored.
 *
 * @param {object|null} signal - { interval, close|candleClose, supertrendValue, supertrendBreakDown }
 * @param {object} [options] - { interval } expected timeframe (defaults to 15m)
 * @returns {object|null} rule decision or null
 */
export function evaluateSupertrendExit(signal, { interval = SUPERTREND_INTERVAL } = {}) {
  if (!signal) return null;

  const expected = String(interval).trim().toUpperCase();
  const actual = String(signal.interval ?? expected).trim().toUpperCase();
  if (actual !== expected) return null; // never size the safety net off another timeframe

  const close = toFiniteNumber(signal.candleClose ?? signal.close);
  const line = toFiniteNumber(signal.supertrendValue ?? signal.supertrend);
  const breakDown = signal.supertrendBreakDown === true || signal.breakDown === true;
  const closedBelow = close != null && line != null && close < line;

  if (!breakDown && !closedBelow) return null;

  return ruleDecision(
    "SUPERTREND_BREAK",
    `supertrend break: 15m close ${close ?? "n/a"} ${closedBelow ? "<" : "broke"} Supertrend ${line ?? "n/a"}`,
    {
      interval: expected,
      candle_close: close,
      supertrend_value: line,
    },
  );
}

/**
 * Backwards-compatible alias — the pure numeric evaluator keeps its old name.
 * New code should call `evaluateExitHierarchy()`.
 */
export const evaluateNumericRules = evaluateExitHierarchy;

/**
 * Full deterministic exit evaluation for one position (priorities 1 and 2).
 *
 * 1. Reads the persisted instruction and derives numeric TP/SL overrides.
 * 2. Refreshes stateful flags (trailing arm, OOR timestamp) via state.js.
 * 3. Walks the strict hierarchy: Priority 1 (TP/SL) → Priority 2 (range bounds).
 *
 * Priority 3 (Supertrend 15m) needs a candle feed, so callers that own the market
 * data pipe run `evaluateSupertrendExit()` when this returns null.
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
 *   `[EXIT] Priority 3: Supertrend 15m Candle Break — HYPE/USDC`
 */
export function formatExitLog(pair, decision) {
  const label = pair || "position";
  const headline = decision?.headline
    || (decision?.priority ? `Priority ${decision.priority}: ${decision.name}` : decision?.name || "Exit");
  return `[EXIT] ${headline} — ${label}`;
}

