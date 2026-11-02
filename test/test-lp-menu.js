/**
 * Interactive LP menu tests (no network, no Telegram, no transactions).
 * Run: node test/test-lp-menu.js
 */

import assert from "node:assert/strict";
import {
  binsToDownsidePct,
  buildDashboardKeyboard,
  estimateApr,
  extractPoolAddress,
  formatDeployResult,
  formatSolAmount,
  formatUsd,
  getLpSession,
  isSolanaAddress,
  parseAmountInput,
  parseRangeInput,
  renderDashboard,
  renderMainMenu,
  toPoolEntry,
} from "../services/lp-menu.js";
import {
  normalizeStrategyKind,
  strategyLabel,
  strategyLegs,
  toSdkStrategyType,
} from "../services/meteoraService.js";

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("=== LP menu helpers ===");

test("parseAmountInput accepts SOL numbers", () => {
  assert.deepEqual(parseAmountInput("0.5"), { mode: "sol", value: 0.5 });
  assert.deepEqual(parseAmountInput("1.5 SOL"), { mode: "sol", value: 1.5 });
  assert.deepEqual(parseAmountInput("0,25"), { mode: "sol", value: 0.25 });
});

test("parseAmountInput accepts percentages and rejects junk", () => {
  assert.deepEqual(parseAmountInput("50%"), { mode: "pct", value: 50 });
  assert.deepEqual(parseAmountInput("100 %"), { mode: "pct", value: 100 });
  assert.equal(parseAmountInput("0"), null);
  assert.equal(parseAmountInput("150%"), null);
  assert.equal(parseAmountInput("abc"), null);
});

test("parseRangeInput handles single-sided, two-sided and signed input", () => {
  assert.deepEqual(parseRangeInput("-50"), { downsidePct: 50, upsidePct: 0 });
  assert.deepEqual(parseRangeInput("-50%"), { downsidePct: 50, upsidePct: 0 });
  assert.deepEqual(parseRangeInput("-30 +40"), { downsidePct: 30, upsidePct: 40 });
  assert.deepEqual(parseRangeInput("+200"), { downsidePct: 0, upsidePct: 200 });
  assert.deepEqual(parseRangeInput("-30,40"), { downsidePct: 30, upsidePct: 40 });
  assert.equal(parseRangeInput("0"), null);
  assert.equal(parseRangeInput("-120"), null);
  assert.equal(parseRangeInput("-10 -20 -30"), null);
});

test("address helpers accept a valid pubkey and URLs", () => {
  const address = "So11111111111111111111111111111111111111112";
  assert.equal(isSolanaAddress(address), true);
  assert.equal(isSolanaAddress("not-an-address"), false);
  assert.equal(extractPoolAddress(address), address);
  assert.equal(
    extractPoolAddress(`https://app.meteora.ag/dlmm/${address}?cluster=mainnet`),
    address,
  );
  assert.equal(extractPoolAddress("no address here"), null);
});

test("formatters stay compact", () => {
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(52_900), "$52.9K");
  assert.equal(formatUsd(2_300_000), "$2.30M");
  assert.equal(formatSolAmount(0.08), "0.08");
  assert.equal(formatSolAmount(0.0005), "5.00e-4");
});

test("estimateApr annualises the daily fee/TVL ratio", () => {
  assert.equal(estimateApr(0.5), 182.5);
  assert.equal(estimateApr(0), null);
  assert.equal(estimateApr("n/a"), null);
});

test("binsToDownsidePct converts bin counts to price delta", () => {
  // 69 bins at 100 bps ≈ 1 - 1.01^-69 ≈ 49.6%
  const pct = binsToDownsidePct(69, 100);
  assert.ok(pct > 49 && pct < 51, `unexpected pct ${pct}`);
  assert.equal(binsToDownsidePct(0, 100), null);
  assert.equal(binsToDownsidePct(69, 0), null);
});

console.log("\n=== Strategy mapping ===");

test("normalizeStrategyKind maps UI aliases", () => {
  assert.equal(normalizeStrategyKind("Spot"), "spot");
  assert.equal(normalizeStrategyKind("BidAsk"), "bid_ask");
  assert.equal(normalizeStrategyKind("bid_ask_imbalanced"), "bid_ask");
  assert.equal(normalizeStrategyKind("Curve"), "curve");
  assert.equal(normalizeStrategyKind("Spot & BA"), "spot_ba");
  assert.equal(normalizeStrategyKind("spot & curve"), "spot_curve");
  assert.equal(normalizeStrategyKind("garbage"), "bid_ask"); // safe fallback
});

test("strategyLegs splits only composite strategies", () => {
  assert.deepEqual(strategyLegs("spot"), [{ kind: "spot", weight: 1 }]);
  assert.deepEqual(strategyLegs("spot_ba"), [
    { kind: "spot", weight: 0.5 },
    { kind: "bid_ask", weight: 0.5 },
  ]);
  const sum = strategyLegs("spot_curve").reduce((total, leg) => total + leg.weight, 0);
  assert.equal(sum, 1);
});

test("toSdkStrategyType maps to the @meteora-ag/dlmm enum", () => {
  const StrategyType = { Spot: 0, Curve: 1, BidAsk: 2 };
  assert.equal(toSdkStrategyType("spot", StrategyType), 0);
  assert.equal(toSdkStrategyType("curve", StrategyType), 1);
  assert.equal(toSdkStrategyType("bid_ask", StrategyType), 2);
  assert.throws(() => toSdkStrategyType("spot", {}), /StrategyType missing/);
  assert.equal(strategyLabel("spot_curve"), "Spot & Curve");
});

console.log("\n=== Rendering ===");

const POOLS = [
  toPoolEntry({
    pool: "ExxzYBTt3jwU5MUxuw2F4toYbTLdFwThSjycaCn6Xpump",
    name: "Anakin/SOL",
    bin_step: 50,
    fee_pct: 0.75,
    tvl: 52_900,
    fee_active_tvl_ratio: 1.62,
    volume_window: 940_500,
    mcap: 2_300_000,
    organic_score: 90,
  }, 0),
  toPoolEntry({
    pool: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    name: "Anakin/SOL",
    bin_step: 100,
    fee_pct: 0.8,
    tvl: 116_200,
    fee_active_tvl_ratio: 0.51,
    volume_window: 1_320_000,
  }, 1),
];

test("toPoolEntry condenses screening fields", () => {
  assert.equal(POOLS[0].name, "Anakin/SOL");
  assert.equal(POOLS[0].binStep, 50);
  assert.equal(POOLS[0].tvl, 52_900);
  assert.equal(POOLS[0].feeTvl, 1.62);
  assert.ok(POOLS[0].apr > 0);
});

test("main menu renders pool rows + buttons", () => {
  const view = renderMainMenu({
    pools: POOLS,
    wallet: { wallet: "2hT6qabuzFvD2WixkgQCoYqpG2NrwiGnVa5T5XZWs68s", sol: 0.3, sol_usd: 52 },
  });
  assert.match(view.text, /DLMM Pools/);
  assert.match(view.text, /Anakin\/SOL/);
  assert.match(view.text, /bin step 50/);
  assert.match(view.text, /0.3 SOL/);

  const flat = view.keyboard.flat();
  assert.equal(flat.some((button) => button.callback_data === "lp:pool:0"), true);
  assert.equal(flat.some((button) => button.callback_data === "lp:refresh"), true);
  for (const button of flat) {
    assert.ok(button.callback_data.length <= 64, `callback_data too long: ${button.callback_data}`);
  }
});

test("dashboard renders the Zenith-style sections", () => {
  const session = getLpSession({ chat: { id: 1 }, from: { id: 2 } });
  session.pool = { ...POOLS[0], activeBinId: 1234, activeBinSol: 0.582 };
  session.amountMode = "sol";
  session.amountSol = 0.08;
  session.downsidePct = 80;
  session.upsidePct = 0;
  session.rangeLabel = "-80%";
  session.strategy = "bid_ask";
  session.rangePreview = { minBinId: 1180, maxBinId: 1234, totalBins: 54 };

  const view = renderDashboard(session, { wallet: { sol: 0.3 } });
  assert.match(view.text, /New Position: Anakin\/SOL/);
  assert.match(view.text, /Binstep: 50/);
  assert.match(view.text, /Active bin: <b>1234<\/b>/);
  assert.match(view.text, /0.08 SOL/);
  assert.match(view.text, /BidAsk/);
  assert.match(view.text, /Bins: <b>1180<\/b> → <b>1234<\/b>/);

  const labels = view.keyboard.flat().map((button) => button.text);
  assert.ok(labels.some((label) => label.includes("QUICK ZAP")));
  assert.ok(labels.some((label) => label.includes("LIQUIDITY AMOUNT")));
  assert.ok(labels.some((label) => label.includes("RANGE")));
  assert.ok(labels.some((label) => label.includes("STRATEGY")));
  assert.ok(labels.some((label) => label.includes("Continue")));
  assert.ok(labels.some((label) => label.includes("Deploy Position")));

  const callbacks = view.keyboard.flat().map((button) => button.callback_data);
  for (const expected of ["lp:zap:a", "lp:zap:b", "lp:amt:1", "lp:rng:-50", "lp:str:spot", "lp:deploy"]) {
    assert.ok(callbacks.includes(expected), `missing ${expected}`);
  }
});

test("selection markers follow session state", () => {
  const session = getLpSession({ chat: { id: 3 }, from: { id: 4 } });
  session.amountMode = "pct";
  session.amountPct = 50;
  session.rangeLabel = "-30 +40";
  session.strategy = "curve";
  const labels = buildDashboardKeyboard(session).flat().map((button) => button.text);
  assert.ok(labels.includes("✅ 50%"));
  assert.ok(labels.includes("✅ -30 +40"));
  assert.ok(labels.some((label) => label.includes("Curve") && label.startsWith("✅")));
});

test("deploy result formatting shows ids, bins and txs", () => {
  const text = formatDeployResult({
    pool: "ExxzYBTt3jwU5MUxuw2F4toYbTLdFwThSjycaCn6Xpump",
    pool_name: "Anakin/SOL",
    amount_sol: 0.08,
    strategy_label: "BidAsk",
    bin_range: { minBinId: 1180, maxBinId: 1234, activeBinId: 1234, minPrice: 0.00012, maxPrice: 0.00026, downsideCoveragePct: 80, upsideCoveragePct: 0 },
    positions: [{ strategy: "bid_ask", position: "Pos1111111111111111111111111111111111111111" }],
    txs: ["Tx111111111111111111111111111111111111111111"],
  });
  assert.match(text, /Position opened/);
  assert.match(text, /1180 → 1234/);
  assert.match(text, /BidAsk/);
  assert.match(text, /Tx111/);

  const dry = formatDeployResult({ dry_run: true, pool_name: "X/SOL", amount_sol: 1, strategy_label: "Spot", bin_range: {} });
  assert.match(dry, /DRY RUN/);
});

console.log(`\n✓ ${passed} LP-menu tests passed`);

