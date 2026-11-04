/**
 * Deterministic exit-hierarchy tests (no network, no state writes, no LLM).
 * Run: node test/test-exit-rules.js
 *
 * Verifies the simplified 2-priority hierarchy:
 *   1. Hard TP / SL on Total PnL % (unrealized value + claimable/claimed fees vs
 *      the initial deposit)
 *   2. Range out (far above / far below the configured outer bounds), guarded by
 *      `hasEnteredRange` so a below-price limit order is never closed before it
 *      has filled at least once
 * and that the removed Supertrend 15m check (plus RSI(2) / MACD / Bollinger) can
 * never close a position and never triggers a candle/historical price fetch.
 */

import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  EXIT_PRIORITY,
  EXIT_RULES,
  detectExit,
  evaluateExitHierarchy,
  evaluateNumericRules,
  formatExitLog,
  hasEnteredRangeOf,
  isPnlSuspect,
  parseInstructionOverrides,
  resolveTotalPnlPct,
  ruleDecision,
} from "../exit-rules.js";
import {
  evaluateRangeEntry,
  getHasEnteredRange,
  isActiveBinInRange,
  monitorPosition,
  resolveBinRange,
} from "../services/positionMonitor.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Comments talk about RSI/MACD; only executable code matters for the guards. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const MGMT = {
  stopLossPct: -50,
  takeProfitPct: 5,
  outOfRangeBinsToClose: 10,
  outOfRangeWaitMinutes: 30,
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1.5,
  // Legacy knobs deliberately present: none of them may close anything any more.
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
};

function position(overrides = {}) {
  return {
    position: "pos1",
    pair: "HYPE/USDC",
    pnl_pct: 0,
    in_range: true,
    active_bin: 100,
    lower_bin: 80,
    upper_bin: 120,
    fee_per_tvl_24h: 20,
    age_minutes: 120,
    minutes_out_of_range: 0,
    total_value_usd: 100,
    ...overrides,
  };
}

console.log("=== exit-rules.js (strict exit priority hierarchy) ===\n");

test("rule ids and priorities match the documented 2-priority hierarchy", () => {
  assert.deepEqual(EXIT_PRIORITY, { TP_SL: 1, RANGE: 2 });

  assert.equal(EXIT_RULES.STOP_LOSS.rule, 1);
  assert.equal(EXIT_RULES.TAKE_PROFIT.rule, 2);
  assert.equal(EXIT_RULES.FAR_ABOVE_RANGE.rule, 4);
  assert.equal(EXIT_RULES.FAR_BELOW_RANGE.rule, 5);

  assert.equal(EXIT_RULES.STOP_LOSS.priority, 1);
  assert.equal(EXIT_RULES.TAKE_PROFIT.priority, 1);
  assert.equal(EXIT_RULES.TRAILING_TP.priority, 1);
  assert.equal(EXIT_RULES.FAR_ABOVE_RANGE.priority, 2);
  assert.equal(EXIT_RULES.FAR_BELOW_RANGE.priority, 2);

  // Priority 3 (Supertrend 15m) is gone, and no priority above 2 may come back.
  assert.equal(EXIT_RULES.SUPERTREND_BREAK, undefined);
  assert.equal("SUPERTREND" in EXIT_PRIORITY, false);
  assert.equal(
    Object.values(EXIT_RULES).every((rule) => rule.priority <= 2),
    true,
    "no rule may sit outside the 2-priority hierarchy",
  );

  // The removed indicator / decay rules must be gone from the ladder.
  assert.equal(EXIT_RULES.EVIL_PANDA, undefined);
  assert.equal(EXIT_RULES.LOW_YIELD, undefined);
  assert.equal(EXIT_RULES.INSTRUCTION_TIME, undefined);
  assert.equal(EXIT_RULES.PUMPED_ABOVE_RANGE, undefined);
  assert.equal(EXIT_RULES.OUT_OF_RANGE, undefined);
});

console.log("\n--- Priority 1: TP / SL ---");

test("Priority 1 — stop-loss closes at/below the configured SL", () => {
  const d = evaluateExitHierarchy(position({ pnl_pct: -55 }), MGMT);
  assert.equal(d.action, "CLOSE");
  assert.equal(d.priority, 1);
  assert.equal(d.rule_key, "STOP_LOSS");
  assert.equal(d.headline, "Priority 1: SL hit (-55.00%)");
  // Exactly at the threshold also fires.
  assert.equal(evaluateExitHierarchy(position({ pnl_pct: -50 }), MGMT).rule_key, "STOP_LOSS");
  // Inside the band does not.
  assert.equal(evaluateExitHierarchy(position({ pnl_pct: -49.99 }), MGMT), null);
});

test("Priority 1 — take-profit closes at/above the configured TP", () => {
  const d = evaluateExitHierarchy(position({ pnl_pct: 6 }), MGMT);
  assert.equal(d.priority, 1);
  assert.equal(d.rule_key, "TAKE_PROFIT");
  assert.equal(d.headline, "Priority 1: TP hit (+6.00%)");
  assert.equal(evaluateExitHierarchy(position({ pnl_pct: 5 }), MGMT).rule_key, "TAKE_PROFIT");
  assert.equal(evaluateExitHierarchy(position({ pnl_pct: 4.99 }), MGMT), null);
});

test("Priority 1 — TP/SL beat every lower priority on the same tick", () => {
  const tp = evaluateExitHierarchy(position({ pnl_pct: 9, active_bin: 400, in_range: false }), MGMT);
  assert.equal(tp.rule_key, "TAKE_PROFIT");
  const sl = evaluateExitHierarchy(position({ pnl_pct: -60, active_bin: 10, in_range: false }), MGMT);
  assert.equal(sl.rule_key, "STOP_LOSS");
});

test("Priority 1 — trailing take-profit stays a profit-taking exit", () => {
  const d = evaluateExitHierarchy(position({ pnl_pct: 4 }), MGMT, {
    tracked: { trailing_active: true, peak_pnl_pct: 6 },
  });
  assert.equal(d.priority, 1);
  assert.equal(d.rule_key, "TRAILING_TP");
  assert.equal(d.headline, "Priority 1: Trailing TP hit (+4.00%)");
  assert.equal(d.drop_from_peak_pct, 2);

  const disabled = evaluateExitHierarchy(position({ pnl_pct: 4 }), { ...MGMT, trailingTakeProfit: false }, {
    tracked: { trailing_active: true, peak_pnl_pct: 6 },
  });
  assert.equal(disabled, null);
});

test("Priority 1 — Total PnL counts claimable + claimed fees against the deposit", () => {
  // The on-chain percentage is authoritative (pnl.js already folds fees in).
  assert.equal(resolveTotalPnlPct({ pnl_pct: 7.5 }), 7.5);
  assert.equal(resolveTotalPnlPct(position({ pnl_pct: -12 }), null), -12);

  // Hand-built / legacy payloads without pnl_pct derive it from USD fields:
  // (value 100 + claimable 2 + claimed 1 − deposit 100) / 100 = +3 %.
  const payload = {
    total_value_true_usd: 100,
    unclaimed_fees_true_usd: 2,
    collected_fees_true_usd: 1,
    initial_value_usd: 100,
  };
  assert.equal(resolveTotalPnlPct(payload), 3);

  // `pnl_usd` wins over the component fields when present.
  assert.equal(resolveTotalPnlPct({ pnl_true_usd: 4, initial_value_usd: 100 }), 4);
  // Deposit may come from persisted state.
  assert.equal(resolveTotalPnlPct({ pnl_true_usd: 5 }, { initial_value_usd: 100 }), 5);
  // No deposit → no percentage (PnL rules are skipped, never guessed).
  assert.equal(resolveTotalPnlPct({ total_value_true_usd: 100 }), null);
  assert.equal(resolveTotalPnlPct({}), null);

  // Fees alone can push a flat position over the TP line.
  const feeDriven = position({
    pnl_pct: undefined,
    total_value_true_usd: 99,
    unclaimed_fees_true_usd: 6,
    initial_value_usd: 100,
  });
  const d = evaluateExitHierarchy(feeDriven, MGMT);
  assert.equal(d.rule_key, "TAKE_PROFIT", "claimable fees must count toward TP");
  assert.equal(d.pnl_pct, 5);
});

test("suspect PnL ticks never trigger PnL rules", () => {
  const p = position({ pnl_pct: -100, pnl_pct_suspicious: true });
  assert.equal(isPnlSuspect(p, { amount_sol: 1 }), true);
  assert.equal(evaluateExitHierarchy(p, MGMT, { tracked: { amount_sol: 1 } }), null);
});

console.log("\n--- Priority 2: range boundaries ---");

test("Priority 2 — far above range closes beyond the configured outer bound", () => {
  const d = evaluateExitHierarchy(position({ active_bin: 131, in_range: false }), MGMT);
  assert.equal(d.priority, 2);
  assert.equal(d.rule_key, "FAR_ABOVE_RANGE");
  assert.equal(d.headline, "Priority 2: Far Above Range");
  assert.equal(d.distance_bins, 11);
  // upper + outOfRangeBinsToClose is still inside the bound.
  assert.equal(evaluateExitHierarchy(position({ active_bin: 130, in_range: false }), MGMT), null);
});

test("Priority 2 — far below range closes beyond the configured outer bound", () => {
  const d = evaluateExitHierarchy(position({ active_bin: 69, in_range: false }), MGMT);
  assert.equal(d.priority, 2);
  assert.equal(d.rule_key, "FAR_BELOW_RANGE");
  assert.equal(d.headline, "Priority 2: Far Below Range");
  assert.equal(d.distance_bins, 11);
  // lower - outOfRangeBinsToClose is still inside the bound.
  assert.equal(evaluateExitHierarchy(position({ active_bin: 70, in_range: false }), MGMT), null);
});

test("Priority 2 — range out ranks below TP/SL and fires only past the bound", () => {
  const d = evaluateExitHierarchy(position({ active_bin: 200, in_range: false }), MGMT);
  assert.equal(d.priority, 2);
  // Inside the bounds nothing closes; there is no lower priority left to ask.
  assert.equal(evaluateExitHierarchy(position({ active_bin: 100 }), MGMT), null);
  // TP/SL on the same tick always win.
  assert.equal(
    evaluateExitHierarchy(position({ pnl_pct: 9, active_bin: 400, in_range: false }), MGMT).rule_key,
    "TAKE_PROFIT",
  );
});

test("Priority 2 — data-gap fallback keeps the out-of-range wait", () => {
  const above = evaluateExitHierarchy(
    position({ active_bin: 125, in_range: false, minutes_out_of_range: 31 }),
    MGMT,
  );
  assert.equal(above.priority, 2);
  assert.equal(above.rule_key, "FAR_ABOVE_RANGE");

  const below = evaluateExitHierarchy(
    position({ active_bin: 75, in_range: false, minutes_out_of_range: 31 }),
    MGMT,
  );
  assert.equal(below.rule_key, "FAR_BELOW_RANGE");

  // Derived from state when the snapshot does not report the minutes.
  const tracked = { out_of_range_since: new Date(Date.now() - 45 * 60_000).toISOString() };
  const derived = evaluateExitHierarchy(
    position({ active_bin: 125, in_range: false, minutes_out_of_range: undefined }),
    MGMT,
    { tracked },
  );
  assert.equal(derived.rule_key, "FAR_ABOVE_RANGE");

  // Still waiting → no exit.
  assert.equal(
    evaluateExitHierarchy(position({ active_bin: 125, in_range: false, minutes_out_of_range: 5 }), MGMT),
    null,
  );
});

test("Priority 2 — hasEnteredRange=false bypasses the range exit (limit order pending)", () => {
  // Far above the range, but the position never traded inside it → no close.
  assert.equal(
    evaluateExitHierarchy(position({ active_bin: 131, in_range: false, hasEnteredRange: false }), MGMT),
    null,
  );
  // Same tick once the monitor armed the position → FAR_ABOVE_RANGE closes.
  assert.equal(
    evaluateExitHierarchy(position({ active_bin: 131, in_range: false, hasEnteredRange: true }), MGMT).rule_key,
    "FAR_ABOVE_RANGE",
  );

  // Far below behaves identically, from the payload flag and from state.json.
  assert.equal(
    evaluateExitHierarchy(position({ active_bin: 69, in_range: false, hasEnteredRange: false }), MGMT),
    null,
  );
  assert.equal(
    evaluateExitHierarchy(position({ active_bin: 69, in_range: false, hasEnteredRange: true }), MGMT).rule_key,
    "FAR_BELOW_RANGE",
  );
  assert.equal(
    evaluateExitHierarchy(position({ active_bin: 69, in_range: false }), MGMT, {
      tracked: { has_entered_range: false },
    }),
    null,
  );
  assert.equal(
    evaluateExitHierarchy(position({ active_bin: 69, in_range: false }), MGMT, {
      tracked: { has_entered_range: true },
    }).rule_key,
    "FAR_BELOW_RANGE",
  );
  // camelCase state records work too.
  assert.equal(
    evaluateExitHierarchy(position({ active_bin: 69, in_range: false }), MGMT, {
      tracked: { hasEnteredRange: false },
    }),
    null,
  );

  // The data-gap backstop belongs to Priority 2 and is guarded as well.
  assert.equal(
    evaluateExitHierarchy(
      position({ active_bin: 125, in_range: false, minutes_out_of_range: 999, hasEnteredRange: false }),
      MGMT,
    ),
    null,
  );

  // Priority 1 is never gated by the range flag.
  assert.equal(
    evaluateExitHierarchy(
      position({ pnl_pct: -60, active_bin: 5, in_range: false, hasEnteredRange: false }),
      MGMT,
    ).rule_key,
    "STOP_LOSS",
  );
  assert.equal(
    evaluateExitHierarchy(
      position({ pnl_pct: 9, active_bin: 400, in_range: false, hasEnteredRange: false }),
      MGMT,
    ).rule_key,
    "TAKE_PROFIT",
  );

  // Flag resolution: the payload wins over state, only an explicit false blocks,
  // legacy records without the field keep the previous behaviour.
  assert.equal(hasEnteredRangeOf({ hasEnteredRange: true }, { has_entered_range: false }), true);
  assert.equal(hasEnteredRangeOf({}, { has_entered_range: false }), false);
  assert.equal(hasEnteredRangeOf({}, {}), true);
  assert.equal(hasEnteredRangeOf(null, null), true);
});

test("a below-price limit order is never range-closed before it fills", () => {
  // -80 % → -20 % limit order under the active price: active bin 0, range -805…-112.
  const limit = position({
    lower_bin: -805,
    upper_bin: -112,
    active_bin: 0,
    in_range: false,
    minutes_out_of_range: 1_000,
    hasEnteredRange: false,
  });
  // Price is FAR ABOVE the range while the order waits → Priority 2 stays silent,
  // even after the out-of-range wait has long expired.
  assert.equal(evaluateExitHierarchy(limit, MGMT), null);

  // Price drops into the range → monitor arms the flag; nothing closes while inside.
  const filled = {
    ...limit,
    active_bin: -400,
    in_range: true,
    minutes_out_of_range: 0,
    hasEnteredRange: true,
  };
  assert.equal(evaluateExitHierarchy(filled, MGMT), null);

  // Price later dumps through the bottom → the range exit finally fires.
  const dumped = { ...limit, active_bin: -900, hasEnteredRange: true };
  const d = evaluateExitHierarchy(dumped, MGMT);
  assert.equal(d.priority, 2);
  assert.equal(d.rule_key, "FAR_BELOW_RANGE");
  assert.equal(d.distance_bins, 95);
});

test("position monitor flips hasEnteredRange only inside the bin range", () => {
  const pending = { position: "pos-limit", lower_bin: -805, upper_bin: -112, active_bin: 0, in_range: false };
  assert.equal(isActiveBinInRange(pending), false);
  assert.equal(getHasEnteredRange(pending), false);
  assert.deepEqual(evaluateRangeEntry(pending), { inRange: false, hasEnteredRange: false, flipped: false });

  const inside = { ...pending, active_bin: -400 };
  assert.equal(isActiveBinInRange(inside), true);
  assert.deepEqual(evaluateRangeEntry(inside), { inRange: true, hasEnteredRange: true, flipped: true });

  // One-way transition: leaving the range keeps the flag.
  assert.deepEqual(evaluateRangeEntry({ ...pending, hasEnteredRange: true }), {
    inRange: false,
    hasEnteredRange: true,
    flipped: false,
  });

  // Bounds are inclusive; reversed bounds are normalised.
  assert.equal(isActiveBinInRange({ lower_bin: 100, upper_bin: 140, active_bin: 100 }), true);
  assert.equal(isActiveBinInRange({ lower_bin: 100, upper_bin: 140, active_bin: 140 }), true);
  assert.equal(isActiveBinInRange({ lower_bin: 100, upper_bin: 140, active_bin: 141 }), false);
  assert.equal(isActiveBinInRange({ lower_bin: 140, upper_bin: 100, active_bin: 120 }), true);

  // Data-gap snapshots fall back to `in_range`.
  assert.equal(isActiveBinInRange({ in_range: true }), true);
  assert.equal(isActiveBinInRange({ in_range: false }), false);
  assert.equal(isActiveBinInRange({}), null);

  // Tracked state supplies the geometry when the snapshot has none.
  assert.deepEqual(resolveBinRange({}, { bin_range: { min: 80, max: 120, active: 100 } }), {
    lowerBinId: 80,
    upperBinId: 120,
    activeBinId: 100,
  });
  assert.equal(isActiveBinInRange({}, { bin_range: { min: 80, max: 120, active: 100 } }), true);

  // Unknown positions evaluate but never write state (this suite has no state writes).
  const tick = monitorPosition({
    position: "__test_position_monitor_unknown__",
    lower_bin: 80,
    upper_bin: 120,
    active_bin: 100,
  });
  assert.equal(tick.flipped, true);
  assert.equal(tick.persisted, false);
});

test("deploy starts hasEnteredRange=false and both exit loops run the monitor tick", () => {
  const stateSrc = fs.readFileSync(path.join(ROOT, "state.js"), "utf8");
  assert.match(stateSrc, /has_entered_range:\s*false/, "deploy must default hasEnteredRange to false");
  assert.match(stateSrc, /export function markRangeEntered\(/);

  const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const management = indexSrc.slice(
    indexSrc.indexOf("export async function runManagementCycle"),
    indexSrc.indexOf("export async function runScreeningCycle"),
  );
  assert.match(management, /monitorPosition\(/, "management tick must update hasEnteredRange");
  const pollStart = indexSrc.indexOf("const pnlPollInterval = setInterval");
  assert.ok(pollStart > 0, "fast PnL poller must exist");
  assert.match(indexSrc.slice(pollStart, pollStart + 8_000), /monitorPosition\(/, "poll tick must update hasEnteredRange");

  const exitSrc = fs.readFileSync(path.join(ROOT, "exit-rules.js"), "utf8");
  assert.match(exitSrc, /hasEnteredRangeOf\(position, tracked\)/);
  assert.match(exitSrc, /monitorPosition\(position, \{ tracked: trackedBefore \}\)/);
});

console.log("\n--- Supertrend guard removed (no candle fetching) ---");

test("the Supertrend priority and its evaluator no longer exist", () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, "exit-rules.js"), "utf8");
  assert.equal(/export\s+function\s+evaluateSupertrendExit/.test(engineSrc), false);
  assert.equal(/SUPERTREND_INTERVAL/.test(engineSrc), false);
  assert.equal(EXIT_RULES.SUPERTREND_BREAK, undefined);
  assert.equal(EXIT_PRIORITY.SUPERTREND, undefined);
  // `ruleDecision` cannot build a Supertrend decision any more.
  assert.throws(() => ruleDecision("SUPERTREND_BREAK", "15m close"), /Unknown exit rule/);
});

test("the exit path never fetches candle or historical price data", () => {
  const engine = stripComments(fs.readFileSync(path.join(ROOT, "exit-rules.js"), "utf8"));
  for (const banned of [/\bsupertrend\b/i, /\bcandle/i, /\bohlcv\b/i, /\bhistorical\b/i]) {
    assert.equal(banned.test(engine), false, `exit-rules.js must not reference ${banned}`);
  }
  // No network surface at all in the engine: no fetch/HTTP client, no API tools.
  assert.equal(/\bfetch\s*\(/.test(engine), false, "exit-rules.js must not fetch");
  assert.equal(/agentMeridian|chart-indicators|abortSignal/i.test(engine), false);

  // index.js drives both loops from the local snapshot only.
  const indexSrc = stripComments(fs.readFileSync(path.join(ROOT, "index.js"), "utf8"));
  assert.match(indexSrc, /function evaluatePositionExit\(position\)\s*\{\s*return detectExit\(position, config\.management\);/);
  assert.equal(/fetchSupertrend15m/.test(indexSrc), false, "index.js must not fetch Supertrend data");
  assert.equal(/evaluateSupertrendExit/.test(indexSrc), false, "index.js must not evaluate Supertrend");
  assert.equal(/detectExitWithSupertrend/.test(indexSrc), false, "the Priority 3 helper must be gone");
  assert.equal(/chart-indicators/.test(indexSrc), false, "the exit path must not import the indicator API");
  assert.equal(/exitSafety/.test(indexSrc), false, "no exit-safety knobs are read any more");

  // The 15m fetch helper is gone from the indicator tool as well.
  const indicators = stripComments(fs.readFileSync(path.join(ROOT, "tools/chart-indicators.js"), "utf8"));
  assert.equal(/fetchSupertrend15m/.test(indicators), false, "fetchSupertrend15m must be deleted");
  assert.equal(/SUPERTREND_EXIT_INTERVAL|_supertrendCache/.test(indicators), false);
});

test("the Supertrend guard is disabled in the documented config", () => {
  for (const file of ["user-config.json", "user-config.example.json"]) {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
    assert.equal(parsed.enable_supertrend_guard, false, `${file} must disable the Supertrend guard`);
  }

  // config.js keeps the flag as an explicit, default-off kill-switch.
  const configSrc = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  assert.match(configSrc, /enable_supertrend_guard/);
  assert.match(configSrc, /\?\?\s*u\.exitSupertrendEnabled\s*\?\?\s*false/);
});

console.log("\n--- Technical indicators never close a position ---");

test("RSI(2) > 90 and MACD first-green-candle fields cannot trigger a close", () => {
  const hot = position({
    pnl_pct: 0.5,        // far inside TP/SL
    active_bin: 100,     // inside the range
    fee_per_tvl_24h: 40,
    rsi2: 99,
    rsi: 97.5,
    macd_histogram: 0.42,
    macd_first_green_candle: true,
    bb_upper: 0.0007,
  });
  assert.equal(evaluateExitHierarchy(hot, MGMT), null, "RSI/MACD must not close a position");
  assert.equal(detectExit({ ...hot, position: "__test_exit_rules_indicators__" }, MGMT), null);
});

test("legacy low-yield / instruction-time exits are no longer automatic closes", () => {
  assert.equal(evaluateExitHierarchy(position({ fee_per_tvl_24h: 0.1, age_minutes: 10_000 }), MGMT), null);
  assert.equal(
    evaluateExitHierarchy(position({ age_minutes: 10_000 }), { ...MGMT, closeAfterMinutes: 60 }),
    null,
  );
});

test("a hot RSI/MACD/Bollinger position closes nothing", () => {
  // Same rule the "hot payload" test above applies to snapshots — kept as a
  // reminder that no indicator value can reach the 2-priority ladder.
  const hot = position({
    pnl_pct: 1.2,
    active_bin: 118, // inside the bounds
    rsi: 99,
    macdHistogram: 0.5,
    macdFirstGreenCandle: true,
    bb_upper: 0.0007,
  });
  assert.equal(evaluateExitHierarchy(hot, MGMT), null);
});

test("indicator confluence is decoupled from the exit path", () => {
  const engine = stripComments(fs.readFileSync(path.join(ROOT, "exit-rules.js"), "utf8"));
  assert.equal(/\brsi\b/i.test(engine), false, "exit-rules.js must not read RSI");
  assert.equal(/\bmacd\b/i.test(engine), false, "exit-rules.js must not read MACD");
  assert.equal(/bollinger/i.test(engine), false, "exit-rules.js must not read Bollinger bands");

  const management = stripComments(fs.readFileSync(path.join(ROOT, "index.js"), "utf8"));
  assert.equal(/checkEvilPandaExitConfluence/.test(management), false, "index.js must not run the Panda confluence");
  assert.equal(/getPandaExitSignal/.test(management), false, "index.js must not fetch a Panda exit signal");
  assert.equal(/EVIL_PANDA/.test(management), false, "EVIL_PANDA must be gone from the exit path");
  assert.equal(/fetchPriceSeries/.test(management), false, "index.js must not build a price series for exits");
});

console.log("\n--- Logging ---");

test("exit log lines carry the exact priority reason", () => {
  const tp = formatExitLog("HYPE/USDC", evaluateExitHierarchy(position({ pnl_pct: 5 }), MGMT));
  assert.equal(tp, "[EXIT] Priority 1: TP hit (+5.00%) — HYPE/USDC");
  assert.match(tp, /^\[EXIT\] Priority 1: TP hit \(\+5\.00%\)/);

  const sl = formatExitLog("HYPE/USDC", evaluateExitHierarchy(position({ pnl_pct: -52 }), MGMT));
  assert.equal(sl, "[EXIT] Priority 1: SL hit (-52.00%) — HYPE/USDC");
  assert.match(sl, /^\[EXIT\] Priority 1: SL hit \(-52\.00%\)/);

  const above = formatExitLog("HYPE/USDC", evaluateExitHierarchy(position({ active_bin: 200, in_range: false }), MGMT));
  assert.equal(above, "[EXIT] Priority 2: Far Above Range — HYPE/USDC");
  assert.match(above, /^\[EXIT\] Priority 2: Far Above Range/);

  const below = formatExitLog("HYPE/USDC", evaluateExitHierarchy(position({ active_bin: 10, in_range: false }), MGMT));
  assert.equal(below, "[EXIT] Priority 2: Far Below Range — HYPE/USDC");
  assert.match(below, /^\[EXIT\] Priority 2: Far Below Range/);

  // There is no lower priority left: a healthy position logs nothing at all.
  assert.equal(formatExitLog("HYPE/USDC", evaluateExitHierarchy(position(), MGMT)), "[EXIT] Exit — HYPE/USDC");
});

test("ruleDecision defaults carry the priority headline", () => {
  const d = ruleDecision("FAR_ABOVE_RANGE", "active bin 200 > upper 120 + 10");
  assert.equal(d.headline, "Priority 2: Far Above Range");
  assert.equal(d.priority, 2);

  const flip = ruleDecision("FLIPPER_REBALANCE", "flip");
  assert.equal(flip.priority, 0);
  assert.match(formatExitLog("PAIR", flip), /^\[EXIT\] Flipper Rebalance/);

  assert.throws(() => ruleDecision("EVIL_PANDA", "x"), /Unknown exit rule/);
});

test("close-reason text keeps downstream classification working", () => {
  // lessons.js accepts an extreme loss as a real stop only when the reason says
  // "stop loss"; pool-memory / hive-mind classify range exits by "out of range".
  assert.match(evaluateExitHierarchy(position({ pnl_pct: -95 }), MGMT).reason.toLowerCase(), /stop loss/);
  assert.match(evaluateExitHierarchy(position({ pnl_pct: 6 }), MGMT).reason.toLowerCase(), /take profit/);
  assert.match(
    evaluateExitHierarchy(position({ active_bin: 131, in_range: false }), MGMT).reason.toLowerCase(),
    /out of range/,
  );
  assert.match(
    evaluateExitHierarchy(position({ active_bin: 69, in_range: false }), MGMT).reason.toLowerCase(),
    /out of range/,
  );

  const lessons = fs.readFileSync(path.join(ROOT, "lessons.js"), "utf8");
  assert.match(lessons, /includes\("stop loss"\)/, "lessons.js keys off the stop-loss wording");
  const poolMemory = fs.readFileSync(path.join(ROOT, "pool-memory.js"), "utf8");
  assert.match(poolMemory, /includes\("out of range"\)/, "pool-memory keys off the out-of-range wording");
});

console.log("\n--- Instructions, wiring and LLM isolation ---");

test("instruction parsing — tp / sl override the hierarchy, the rest are notes", () => {
  assert.deepEqual(parseInstructionOverrides("take profit 8%"), { takeProfitPct: 8 });
  assert.deepEqual(parseInstructionOverrides("tp 6.5%"), { takeProfitPct: 6.5 });
  assert.deepEqual(parseInstructionOverrides("hold until 5% profit"), { takeProfitPct: 5 });
  assert.deepEqual(parseInstructionOverrides("close at 8% gain"), { takeProfitPct: 8 });
  assert.deepEqual(parseInstructionOverrides("sl -20%"), { stopLossPct: -20 });
  assert.deepEqual(parseInstructionOverrides("just a note"), {});
  assert.deepEqual(parseInstructionOverrides(null), {});
  // Parsed for the report, but they no longer trigger automatic closes.
  assert.deepEqual(parseInstructionOverrides("close after 90m"), { closeAfterMinutes: 90 });
  assert.deepEqual(parseInstructionOverrides("min yield 4%"), { minFeePerTvl24h: 4 });
});


test("detectExit integrates state refresh and the numeric hierarchy", () => {
  const p = position({ position: "__test_exit_rules__", pnl_pct: -60 });
  const d = detectExit(p, MGMT);
  assert.equal(d.rule_key, "STOP_LOSS");
  assert.equal(d.priority, 1);
  assert.equal(detectExit(null, MGMT), null);
  // Unknown tracked positions still evaluate (no state record needed).
  assert.equal(detectExit(position({ position: "__test_exit_rules_2__" }), MGMT), null);
  // evaluateNumericRules remains an alias of the pure hierarchy evaluator.
  assert.equal(evaluateNumericRules, evaluateExitHierarchy);
});

test("both exit loops use the simplified 2-priority hierarchy", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const managementBody = src.slice(
    src.indexOf("export async function runManagementCycle"),
    src.indexOf("export async function runScreeningCycle"),
  );
  assert.match(managementBody, /evaluatePositionExit\(/, "management must use the 2-priority evaluator");
  assert.match(managementBody, /executeRuleClose|executeManagementActions/);

  // One synchronous helper owns the whole exit decision — no network, no candles.
  const helper = src.slice(
    src.indexOf("function evaluatePositionExit(position)"),
    src.indexOf("export async function runManagementCycle"),
  );
  assert.match(helper, /detectExit\(position, config\.management\)/);
  assert.equal(/await/.test(helper), false, "the exit helper must not await anything");

  // The fast poller uses the same helper and the plain tick confirmation.
  const pollStart = src.indexOf("const pnlPollInterval = setInterval");
  assert.ok(pollStart > 0, "fast PnL poller must exist");
  const pollBody = src.slice(pollStart, pollStart + 6_000);
  assert.match(pollBody, /evaluatePositionExit\(p\)/);
  assert.match(pollBody, /registerExitSignal\(p\.position, signal, confirmTicks\)/);
  assert.match(src, /\[EXIT\]/, "exit logs must carry the [EXIT] prefix");
  assert.match(src, /formatExitLog\(/);
});

test("exit engine has no LLM dependency", () => {
  const src = fs.readFileSync(path.join(ROOT, "exit-rules.js"), "utf8");
  assert.equal(/\bopenai\b/i.test(src), false, "exit-rules.js must not import an LLM client");
  assert.equal(/\bagentLoop\b/.test(src), false, "exit-rules.js must not call agentLoop");
  assert.equal(/\bchat\.completions\b/.test(src), false, "exit-rules.js must not call the chat API");
});

test("LLM cannot execute exits or entries (agent tool scope)", () => {
  const src = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
  assert.match(src, /const DETERMINISTIC_ONLY_TOOLS = new Set\(\[/);
  assert.match(src, /"close_position"/);
  assert.match(src, /"deploy_position"/);
  const screenerLine = src.split("\n").find((line) => line.startsWith("const SCREENER_TOOLS"));
  assert.ok(screenerLine, "SCREENER_TOOLS must be defined");
  assert.equal(/deploy_position/.test(screenerLine), false, "SCREENER must not be offered deploy_position");
  assert.equal(/close_position/.test(screenerLine), false, "SCREENER must not be offered close_position");
});

test("management cycle never sends position data to an LLM", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.equal(/INSTRUCTION EVALUATION/.test(src), false, "instruction LLM evaluation must be removed");
  assert.equal(/updatePnlAndCheckExits/.test(src), false, "management must use the rule engine, not the legacy helper");
  assert.match(src, /\[EXIT\]/);
});

test("healthy positions produce no exit", () => {
  assert.equal(evaluateExitHierarchy(position(), MGMT), null);
  // No reported PnL and no cost basis → no PnL rule fires, and the range is intact.
  assert.equal(resolveTotalPnlPct({ active_bin: 100 }), null);
  assert.equal(evaluateExitHierarchy({ position: "x", active_bin: 100, lower_bin: 80, upper_bin: 120 }, MGMT), null);
});

test("management cycle body contains no LLM call", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const start = src.indexOf("export async function runManagementCycle");
  const end = src.indexOf("export async function runScreeningCycle");
  assert.ok(start > 0 && end > start, "management/screening functions must exist");
  const managementBody = src.slice(start, end);
  assert.equal(/agentLoop\(/.test(managementBody), false, "management cycle must never call the LLM");
  assert.match(managementBody, /evaluatePositionExit\(/);
  assert.match(managementBody, /executeRuleClose|executeManagementActions/);
});

test("LLM screening is opt-in via /pool only; automatic cycles are deterministic", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.match(src, /export async function runScreeningCycle\(\{[\s\S]{0,160}?silent = false,[\s\S]{0,160}?useLLM = false,[\s\S]{0,160}?ioTimeoutMs = 0,/);
  // The interactive run is deadline-bounded and cancellable.
  assert.match(src, /useLLM: true,\s*silent: true,\s*ioTimeoutMs: NETWORK_TIMEOUT_MS,\s*abortToken,/);
  assert.match(src, /selectCandidateDeterministically\(/);
  const healthStart = src.indexOf("export async function runDeterministicHealthCheck");
  const healthEnd = src.indexOf("export function startCronJobs");
  assert.ok(healthStart > 0 && healthEnd > healthStart, "deterministic health check must exist");
  const healthBody = src.slice(healthStart, healthEnd);
  assert.equal(/agentLoop\(/.test(healthBody), false, "health check must not invoke an LLM");
});

console.log(`\n✓ ${passed} exit-rule tests passed\n`);

