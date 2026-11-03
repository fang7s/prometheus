/**
 * Deterministic exit-hierarchy tests (no network, no state writes, no LLM).
 * Run: node test/test-exit-rules.js
 *
 * Verifies the strict priority hierarchy:
 *   1. TP / SL (percentage PnL)
 *   2. Range boundaries (far above / far below the configured outer bounds)
 *   3. Supertrend 15m 1-candle close break
 * and that RSI(2) / MACD / Bollinger signals can never close a position.
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
  evaluateSupertrendExit,
  formatExitLog,
  isPnlSuspect,
  parseInstructionOverrides,
  ruleDecision,
} from "../exit-rules.js";

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

test("rule ids and priorities match the documented hierarchy", () => {
  assert.deepEqual(EXIT_PRIORITY, { TP_SL: 1, RANGE: 2, SUPERTREND: 3 });

  assert.equal(EXIT_RULES.STOP_LOSS.rule, 1);
  assert.equal(EXIT_RULES.TAKE_PROFIT.rule, 2);
  assert.equal(EXIT_RULES.FAR_ABOVE_RANGE.rule, 4);
  assert.equal(EXIT_RULES.FAR_BELOW_RANGE.rule, 5);
  assert.equal(EXIT_RULES.SUPERTREND_BREAK.rule, 6);

  assert.equal(EXIT_RULES.STOP_LOSS.priority, 1);
  assert.equal(EXIT_RULES.TAKE_PROFIT.priority, 1);
  assert.equal(EXIT_RULES.TRAILING_TP.priority, 1);
  assert.equal(EXIT_RULES.FAR_ABOVE_RANGE.priority, 2);
  assert.equal(EXIT_RULES.FAR_BELOW_RANGE.priority, 2);
  assert.equal(EXIT_RULES.SUPERTREND_BREAK.priority, 3);
  assert.equal(EXIT_RULES.SUPERTREND_BREAK.name, "Supertrend 15m Candle Break");

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

test("Priority 2 — range outranks the Supertrend fallback", () => {
  const d = evaluateExitHierarchy(position({ active_bin: 200, in_range: false }), MGMT);
  assert.equal(d.priority, 2);
  // The caller only asks for Priority 3 when this returns null.
  assert.equal(evaluateExitHierarchy(position({ active_bin: 100 }), MGMT), null);
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

console.log("\n--- Priority 3: Supertrend 15m candle break ---");

test("Priority 3 — one 15m candle closing below the Supertrend closes", () => {
  const d = evaluateSupertrendExit({ interval: "15_MINUTE", close: 0.00072, supertrendValue: 0.00081 });
  assert.equal(d.priority, 3);
  assert.equal(d.action, "CLOSE");
  assert.equal(d.rule_key, "SUPERTREND_BREAK");
  assert.equal(d.headline, "Priority 3: Supertrend 15m Candle Break");
  assert.equal(d.candle_close, 0.00072);
  assert.equal(d.supertrend_value, 0.00081);

  // API-flagged break-down on the latest closed candle is enough on its own.
  const flagged = evaluateSupertrendExit({ interval: "15_MINUTE", supertrendBreakDown: true });
  assert.equal(flagged.rule_key, "SUPERTREND_BREAK");
});

test("Priority 3 — no break above the line, and non-15m data is ignored", () => {
  assert.equal(evaluateSupertrendExit({ interval: "15_MINUTE", close: 0.0009, supertrendValue: 0.00081 }), null);
  assert.equal(evaluateSupertrendExit({ interval: "15_MINUTE", close: 0.00081, supertrendValue: 0.00081 }), null);
  assert.equal(evaluateSupertrendExit({ interval: "15_MINUTE", close: null, supertrendValue: null }), null);
  // A 5m break must never drive the 15m safety net.
  assert.equal(evaluateSupertrendExit({ interval: "5_MINUTE", close: 0.0001, supertrendValue: 0.0009 }), null);
  assert.equal(evaluateSupertrendExit(null), null);
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

test("a hot RSI/MACD payload without a Supertrend break closes nothing", () => {
  const signal = {
    interval: "15_MINUTE",
    close: 0.0009,
    supertrendValue: 0.0008,
    rsi: 99,
    macdHistogram: 0.5,
    macdFirstGreenCandle: true,
  };
  assert.equal(evaluateSupertrendExit(signal), null);
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

  const st = formatExitLog(
    "HYPE/USDC",
    evaluateSupertrendExit({ interval: "15_MINUTE", close: 1, supertrendValue: 2 }),
  );
  assert.equal(st, "[EXIT] Priority 3: Supertrend 15m Candle Break — HYPE/USDC");
  assert.match(st, /^\[EXIT\] Priority 3: Supertrend 15m Candle Break/);
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
  assert.match(
    evaluateSupertrendExit({ interval: "15_MINUTE", close: 1, supertrendValue: 2 }).reason.toLowerCase(),
    /supertrend break/,
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

test("both exit loops use the strict hierarchy (TP/SL → range → Supertrend)", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const managementBody = src.slice(
    src.indexOf("export async function runManagementCycle"),
    src.indexOf("export async function runScreeningCycle"),
  );
  assert.match(managementBody, /detectExitWithSupertrend\(/);
  assert.match(managementBody, /executeRuleClose|executeManagementActions/);

  assert.match(src, /export async function detectExitWithSupertrend/);
  assert.match(src, /evaluateSupertrendExit\(/);
  assert.match(src, /fetchSupertrend15m\(/);
  assert.match(src, /\[EXIT\]/, "exit logs must carry the [EXIT] prefix");

  // The helper walks 1 → 2 → 3 in order and only then asks for candles.
  const helper = src.slice(
    src.indexOf("export async function detectExitWithSupertrend"),
    src.indexOf("export async function runManagementCycle"),
  );
  assert.match(helper, /detectExit\(position, config\.management\)/);
  assert.match(helper, /getSupertrendExit\(position\)/);
  assert.ok(
    helper.indexOf("detectExit(position") < helper.indexOf("getSupertrendExit(position)"),
    "TP/SL + range must be evaluated before the Supertrend fallback",
  );
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
  assert.equal(evaluateSupertrendExit({ interval: "15_MINUTE", close: 1.1, supertrendValue: 1 }), null);
});

test("management cycle body contains no LLM call", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const start = src.indexOf("export async function runManagementCycle");
  const end = src.indexOf("export async function runScreeningCycle");
  assert.ok(start > 0 && end > start, "management/screening functions must exist");
  const managementBody = src.slice(start, end);
  assert.equal(/agentLoop\(/.test(managementBody), false, "management cycle must never call the LLM");
  assert.match(managementBody, /detectExitWithSupertrend\(/);
  assert.match(managementBody, /executeRuleClose|executeManagementActions/);
});

test("LLM screening is opt-in via /pool only; automatic cycles are deterministic", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.match(src, /runScreeningCycle\(\{ silent = false, useLLM = false \} = \{\}\)/);
  assert.match(src, /runScreeningCycle\(\{ useLLM: true \}\)/);
  assert.match(src, /selectCandidateDeterministically\(/);
  const healthStart = src.indexOf("export async function runDeterministicHealthCheck");
  const healthEnd = src.indexOf("export function startCronJobs");
  assert.ok(healthStart > 0 && healthEnd > healthStart, "deterministic health check must exist");
  const healthBody = src.slice(healthStart, healthEnd);
  assert.equal(/agentLoop\(/.test(healthBody), false, "health check must not invoke an LLM");
});

console.log(`\n✓ ${passed} exit-rule tests passed\n`);

