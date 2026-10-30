/**
 * Deterministic exit-rule engine — 100% numeric JavaScript, NO LLM.
 *
 * Every exit decision is derived from live position numbers (PnL %, bin range,
 * fee/TVL, age, peak) plus the persisted position state (trailing arm, OOR
 * timestamp). The engine returns a rule decision object; callers execute the
 * close through the normal close path (which never consults the LLM).
 *
 * Rule ladder (stable numbering — logs and docs refer to these ids):
 *   1 Stop-Loss
 *   2 Take-Profit
 *   3 Pumped Far Above Range
 *   4 Out-of-Range
 *   5 Low Yield
 *   6 Trailing Take-Profit
 *   7 Evil Panda Confluence (indicator confluence, still numeric/rule based)
 *   8 Instruction Time Limit (deterministically parsed `/set` instruction)
 *   9 Flipper Rebalance (bid-ask flipper close-and-redeploy)
 *
 * Priority is evaluated independently of the ids: capital protection first
 * (stop-loss), then profit taking, then range/yield decay, then instruction
 * time limits.
 */

import { log } from "./logger.js";
import { getTrackedPosition, refreshPositionState } from "./state.js";

export const EXIT_RULES = Object.freeze({
  STOP_LOSS:          { rule: 1, name: "Stop-Loss" },
  TAKE_PROFIT:        { rule: 2, name: "Take-Profit" },
  PUMPED_ABOVE_RANGE: { rule: 3, name: "Pumped Far Above Range" },
  OUT_OF_RANGE:       { rule: 4, name: "Out-of-Range" },
  LOW_YIELD:          { rule: 5, name: "Low Yield" },
  TRAILING_TP:        { rule: 6, name: "Trailing Take-Profit" },
  EVIL_PANDA:         { rule: 7, name: "Evil Panda Confluence" },
  INSTRUCTION_TIME:   { rule: 8, name: "Instruction Time Limit" },
  FLIPPER_REBALANCE:  { rule: 9, name: "Flipper Rebalance" },
});

const DEFAULT_MIN_AGE_BEFORE_YIELD_CHECK = 60;

function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build a normalized rule decision.
 * @param {string} key - key into EXIT_RULES
 * @param {string} reason - human readable reason (numbers included)
 * @param {object} extra - optional extra fields (signal, needs_confirmation, ...)
 */
export function ruleDecision(key, reason, extra = {}) {
  const def = EXIT_RULES[key];
  if (!def) throw new Error(`Unknown exit rule: ${key}`);
  return { action: "CLOSE", rule: def.rule, name: def.name, rule_key: key, reason, ...extra };
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
 * Pure numeric rule evaluation. No I/O, no state writes, no LLM.
 *
 * @param {object} position - a getMyPositions() entry
 * @param {object} managementConfig - config.management (with instruction overrides merged)
 * @param {object} ctx - { tracked, overrides, now }
 * @returns {object|null} rule decision or null
 */
export function evaluateNumericRules(position, managementConfig = {}, ctx = {}) {
  if (!position) return null;
  const { tracked = null, overrides = {}, now = Date.now() } = ctx;
  const pnl = toFiniteNumber(position.pnl_pct);
  const suspect = isPnlSuspect(position, tracked);
  const noteSuffix = (key) => (overrides[key] != null ? " (position instruction)" : "");

  // ── 1. Stop-loss ────────────────────────────────────────────────
  const stopLossPct = toFiniteNumber(managementConfig.stopLossPct);
  if (!suspect && pnl != null && stopLossPct != null && pnl <= stopLossPct) {
    return ruleDecision(
      "STOP_LOSS",
      `PnL ${pnl.toFixed(2)}% <= ${stopLossPct}%${noteSuffix("stopLossPct")}`,
    );
  }

  // ── 2. Take-profit ──────────────────────────────────────────────
  const takeProfitPct = toFiniteNumber(managementConfig.takeProfitPct);
  if (!suspect && pnl != null && takeProfitPct != null && pnl >= takeProfitPct) {
    return ruleDecision(
      "TAKE_PROFIT",
      `PnL ${pnl.toFixed(2)}% >= ${takeProfitPct}%${noteSuffix("takeProfitPct")}`,
    );
  }

  // ── 6. Trailing take-profit (armed state lives in state.json) ───
  if (managementConfig.trailingTakeProfit !== false && !suspect && pnl != null && tracked?.trailing_active) {
    const peak = toFiniteNumber(tracked.peak_pnl_pct);
    const drop = toFiniteNumber(managementConfig.trailingDropPct);
    if (peak != null && drop != null) {
      const dropFromPeak = peak - pnl;
      if (dropFromPeak >= drop) {
        return ruleDecision(
          "TRAILING_TP",
          `peak ${peak.toFixed(2)}% -> current ${pnl.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${drop}%)`,
          { needs_confirmation: true, peak_pnl_pct: peak, current_pnl_pct: pnl, drop_from_peak_pct: dropFromPeak },
        );
      }
    }
  }

  // ── 3. Pumped far above range ───────────────────────────────────
  const activeBin = toFiniteNumber(position.active_bin);
  const upperBin = toFiniteNumber(position.upper_bin);
  const binsAbove = toFiniteNumber(managementConfig.outOfRangeBinsToClose);
  if (activeBin != null && upperBin != null && binsAbove != null && activeBin > upperBin + binsAbove) {
    return ruleDecision(
      "PUMPED_ABOVE_RANGE",
      `active bin ${activeBin} > upper ${upperBin} + ${binsAbove}`,
    );
  }

  // ── 4. Out of range too long ────────────────────────────────────
  const oorMinutes = minutesOutOfRangeOf(position, tracked, now);
  const waitMinutes = toFiniteNumber(managementConfig.outOfRangeWaitMinutes) ?? Infinity;
  const aboveRange = activeBin != null && upperBin != null && activeBin > upperBin;
  const flagsOutOfRange = position.in_range === false;
  if ((aboveRange || flagsOutOfRange) && oorMinutes >= waitMinutes) {
    return ruleDecision(
      "OUT_OF_RANGE",
      `out of range for ${oorMinutes}m (limit ${waitMinutes}m)`,
    );
  }

  // ── 5. Low yield ────────────────────────────────────────────────
  const feePerTvl = toFiniteNumber(position.fee_per_tvl_24h);
  const minFeePerTvl = toFiniteNumber(managementConfig.minFeePerTvl24h);
  const ageMinutes = toFiniteNumber(position.age_minutes);
  const minAge = toFiniteNumber(managementConfig.minAgeBeforeYieldCheck) ?? DEFAULT_MIN_AGE_BEFORE_YIELD_CHECK;
  if (
    feePerTvl != null &&
    minFeePerTvl != null &&
    feePerTvl < minFeePerTvl &&
    ageMinutes != null &&
    ageMinutes >= minAge
  ) {
    return ruleDecision(
      "LOW_YIELD",
      `fee/TVL ${feePerTvl.toFixed(2)}% < min ${minFeePerTvl}% (age ${ageMinutes}m >= ${minAge}m)${noteSuffix("minFeePerTvl24h")}`,
    );
  }

  // ── 8. Instruction time limit (deterministically parsed) ────────
  const closeAfterMinutes = toFiniteNumber(managementConfig.closeAfterMinutes);
  if (closeAfterMinutes != null && ageMinutes != null && ageMinutes >= closeAfterMinutes) {
    return ruleDecision(
      "INSTRUCTION_TIME",
      `age ${ageMinutes}m >= instruction limit ${closeAfterMinutes}m`,
    );
  }

  return null;
}

/**
 * Full deterministic exit evaluation for one position.
 *
 * 1. Reads the persisted instruction and derives numeric overrides.
 * 2. Refreshes stateful flags (trailing arm, OOR timestamp) via state.js.
 * 3. Evaluates the numeric rule ladder.
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

  return evaluateNumericRules(position, cfg, { tracked, overrides: applied });
}

/**
 * Exact, greppable pre-execution log line.
 * Example: `[RULE ENGINE] Auto-closing HYPE/USDC: Rule 5 (Low Yield) — fee/TVL ...`
 */
export function formatRuleLog(pair, decision) {
  const label = pair || "position";
  return `[RULE ENGINE] Auto-closing ${label}: Rule ${decision.rule} (${decision.name}) — ${decision.reason}`;
}

