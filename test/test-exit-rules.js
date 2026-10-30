/**
 * Deterministic exit-rule engine tests (no network, no state writes).
 * Run: node test/test-exit-rules.js
 */

import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  EXIT_RULES,
  detectExit,
  evaluateNumericRules,
  formatRuleLog,
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

const MGMT = {
  stopLossPct: -50,
  takeProfitPct: 5,
  outOfRangeBinsToClose: 10,
  outOfRangeWaitMinutes: 30,
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1.5,
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

console.log("=== exit-rules.js (deterministic exit engine) ===\n");

test("rule ids are stable and match the documented ladder", () => {
  assert.equal(EXIT_RULES.STOP_LOSS.rule, 1);
  assert.equal(EXIT_RULES.TAKE_PROFIT.rule, 2);
  assert.equal(EXIT_RULES.PUMPED_ABOVE_RANGE.rule, 3);
  assert.equal(EXIT_RULES.OUT_OF_RANGE.rule, 4);
  assert.equal(EXIT_RULES.LOW_YIELD.rule, 5);
  assert.equal(EXIT_RULES.LOW_YIELD.name, "Low Yield");
  assert.equal(EXIT_RULES.TRAILING_TP.rule, 6);
  assert.equal(EXIT_RULES.EVIL_PANDA.rule, 7);
  assert.equal(EXIT_RULES.INSTRUCTION_TIME.rule, 8);
});

test("rule 1 — stop-loss fires below the configured threshold", () => {
  const d = evaluateNumericRules(position({ pnl_pct: -55 }), MGMT);
  assert.equal(d.rule, 1);
  assert.equal(d.name, "Stop-Loss");
  assert.equal(d.action, "CLOSE");
});

test("rule 2 — take-profit fires at/above the configured threshold", () => {
  const d = evaluateNumericRules(position({ pnl_pct: 6 }), MGMT);
  assert.equal(d.rule, 2);
  assert.equal(d.name, "Take-Profit");
});

test("priority — take-profit beats low yield on the same tick", () => {
  const d = evaluateNumericRules(position({ pnl_pct: 6.2, fee_per_tvl_24h: 1 }), MGMT);
  assert.equal(d.rule, 2);
});

test("rule 3 — pumped far above range", () => {
  const d = evaluateNumericRules(position({ active_bin: 131, upper_bin: 120 }), MGMT);
  assert.equal(d.rule, 3);
  assert.equal(d.name, "Pumped Far Above Range");
});

test("rule 4 — out of range longer than the configured wait", () => {
  const d = evaluateNumericRules(
    position({ active_bin: 125, in_range: false, minutes_out_of_range: 31 }),
    MGMT,
  );
  assert.equal(d.rule, 4);
  assert.equal(d.name, "Out-of-Range");
});

test("rule 4 — out-of-range time derived from state when not reported", () => {
  const tracked = { out_of_range_since: new Date(Date.now() - 45 * 60_000).toISOString() };
  const d = evaluateNumericRules(
    position({ active_bin: 125, in_range: false, minutes_out_of_range: undefined }),
    MGMT,
    { tracked },
  );
  assert.equal(d.rule, 4);
});

test("rule 5 — low yield fires for an aged position", () => {
  const d = evaluateNumericRules(position({ fee_per_tvl_24h: 3, age_minutes: 90 }), MGMT);
  assert.equal(d.rule, 5);
  assert.equal(d.name, "Low Yield");
});

test("rule 5 — young positions are exempt from the low-yield rule", () => {
  const d = evaluateNumericRules(position({ fee_per_tvl_24h: 3, age_minutes: 30 }), MGMT);
  assert.equal(d, null);
});

test("rule 6 — trailing take-profit uses the confirmed peak from state", () => {
  const d = evaluateNumericRules(position({ pnl_pct: 4 }), MGMT, {
    tracked: { trailing_active: true, peak_pnl_pct: 6 },
  });
  assert.equal(d.rule, 6);
  assert.equal(d.name, "Trailing Take-Profit");
  assert.equal(d.drop_from_peak_pct, 2);
});

test("rule 6 — trailing TP is ignored when disabled", () => {
  const d = evaluateNumericRules(position({ pnl_pct: 4 }), { ...MGMT, trailingTakeProfit: false }, {
    tracked: { trailing_active: true, peak_pnl_pct: 6 },
  });
  assert.equal(d, null);
});

test("suspect PnL ticks never trigger PnL rules", () => {
  const p = position({ pnl_pct: -100, pnl_pct_suspicious: true });
  assert.equal(isPnlSuspect(p, { amount_sol: 1 }), true);
  assert.equal(evaluateNumericRules(p, MGMT, { tracked: { amount_sol: 1 } }), null);
});

test("instruction parsing — tp / sl / close-after / min-yield", () => {
  assert.deepEqual(parseInstructionOverrides("take profit 8%"), { takeProfitPct: 8 });
  assert.deepEqual(parseInstructionOverrides("tp 6.5%"), { takeProfitPct: 6.5 });
  assert.deepEqual(parseInstructionOverrides("hold until 5% profit"), { takeProfitPct: 5 });
  assert.deepEqual(parseInstructionOverrides("close at 8% gain"), { takeProfitPct: 8 });
  assert.deepEqual(parseInstructionOverrides("sl -20%"), { stopLossPct: -20 });
  assert.deepEqual(parseInstructionOverrides("close after 90m"), { closeAfterMinutes: 90 });
  assert.deepEqual(parseInstructionOverrides("exit in 2h"), { closeAfterMinutes: 120 });
  assert.deepEqual(parseInstructionOverrides("min yield 4%"), { minFeePerTvl24h: 4 });
  assert.deepEqual(parseInstructionOverrides("just a note"), {});
  assert.deepEqual(parseInstructionOverrides(null), {});
});

test("rule 8 — deterministic instruction time limit", () => {
  const d = evaluateNumericRules(position({ age_minutes: 120 }), { ...MGMT, closeAfterMinutes: 60 });
  assert.equal(d.rule, 8);
  assert.equal(d.name, "Instruction Time Limit");
});

test("log line matches the required [RULE ENGINE] format", () => {
  const decision = ruleDecision("LOW_YIELD", "fee/TVL 3.00% < min 7%");
  const line = formatRuleLog("HYPE/USDC", decision);
  assert.equal(
    line,
    "[RULE ENGINE] Auto-closing HYPE/USDC: Rule 5 (Low Yield) — fee/TVL 3.00% < min 7%",
  );
  assert.match(line, /^\[RULE ENGINE\] Auto-closing HYPE\/USDC: Rule 5 \(Low Yield\)/);
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
  assert.match(src, /\[RULE ENGINE\]/);
});

test("healthy positions produce no exit", () => {
  assert.equal(evaluateNumericRules(position(), MGMT), null);
});

test("management cycle body contains no LLM call", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const start = src.indexOf("export async function runManagementCycle");
  const end = src.indexOf("export async function runScreeningCycle");
  assert.ok(start > 0 && end > start, "management/screening functions must exist");
  const managementBody = src.slice(start, end);
  assert.equal(/agentLoop\(/.test(managementBody), false, "management cycle must never call the LLM");
  assert.match(managementBody, /detectExit\(/);
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

test("detectExit integrates state refresh and the numeric ladder", () => {
  const p = position({ position: "__test_exit_rules__", pnl_pct: -60 });
  const d = detectExit(p, MGMT);
  assert.equal(d.rule, 1);
  assert.equal(detectExit(null, MGMT), null);
  // Unknown tracked positions still evaluate (no state record needed).
  assert.equal(detectExit(position({ position: "__test_exit_rules_2__" }), MGMT), null);
});

console.log(`\n✓ ${passed} exit-rule tests passed\n`);
