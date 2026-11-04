/**
 * Interactive LP menu tests (no network, no Telegram, no transactions).
 * Run: node test/test-lp-menu.js
 */

import assert from "node:assert/strict";
import {
  BIN_ARRAY_FEE_SOL,
  DEFAULT_QUICK_TOKENS,
  NEW_POSITION_PROMPT,
  applyRangePreset,
  binsToDownsidePct,
  buildDashboardKeyboard,
  buildHubKeyboard,
  buildNewPositionKeyboard,
  buildQuickTokenPicks,
  buildTokenPoolsKeyboard,
  buildTrendingKeyboard,
  chartSignature,
  describeAmount,
  describeRange,
  estimateApr,
  estimateBinArrayRentSol,
  extractPoolAddress,
  findTokenBalance,
  computeRangePositionPct,
  formatCompactUsd,
  formatDeployResult,
  formatMarketCapLine,
  formatMoney,
  formatPositionLine,
  formatRangePositionLine,
  formatRangeStatus,
  formatSolAmount,
  formatUsd,
  getLpSession,
  isLpAddressCommandWithBadArg,
  isSolanaAddress,
  maxSpendableSol,
  parseAmountInput,
  parseLpAddressCommand,
  parseRangeInput,
  poolHealthLabel,
  renderBalances,
  renderChainView,
  renderDashboard,
  renderDashboardHub,
  renderDammView,
  renderDonateView,
  renderHelpView,
  renderMainMenu,
  renderNewPositionView,
  renderPositions,
  renderProfitCalendar,
  renderRangeBar,
  renderReferralsView,
  renderTokenPools,
  renderTrendingPools,
  renderWalletView,
  tokenPoolEntries,
  toPoolEntry,
  truncateAddress,
} from "../services/lp-menu.js";
import {
  MESSAGE_LIMIT,
  SECTION_DIVIDER,
  escapeHtml,
  formatOpenPositionsMessage,
  formatOutOfRangeAlert,
  formatProgressBar,
  formatTreeRows,
  renderProgressBar,
} from "../services/telegramFormat.js";
import {
  PNL_CARD_CAPTION_LIMIT,
  PNL_CARD_DEFAULT_HEIGHT,
  PNL_CARD_DEFAULT_WIDTH,
  PNL_CARD_TIMEOUT_MS,
  buildClosedPositionCaption,
  buildPricePath,
  clearPriceSamples,
  drawPnlCard,
  formatHoldDuration,
  generatePnlCard,
  getPriceSamples,
  normalizePnlCardData,
  priceAtBin,
  queueClosedPositionPnlCard,
  recordPriceSample,
} from "../services/pnlCardGenerator.js";
import {
  filterTrendingPools,
  getConfiguredMaxTvl,
  normalizeStrategyKind,
  rankPoolsForToken,
  rankTrendingPools,
  scoreTrendingPool,
  strategyLabel,
  strategyLegs,
  toSdkStrategyType,
  toTokenPoolEntry,
} from "../services/meteoraService.js";
import {
  CHART_DEFAULT_HEIGHT,
  CHART_DEFAULT_WIDTH,
  MAX_BINS_EACH_SIDE,
  PHOTO_CAPTION_LIMIT,
  buildLiquiditySeries,
  buildPhotoCaption,
  deriveBinsEachSide,
  generateLiquidityDistributionChart,
  normalizeUserRange,
  selectAxisTicks,
} from "../services/chartService.js";
import { config } from "../config.js";
import {
  applyJupiterReferralParams,
  buildJupiterReferralParams,
  getJupiterReferralParams,
  landJupiterSwap,
} from "../tools/wallet.js";
import {
  MAX_SEND_RETRIES,
  buildPriorityFeeInstructions,
  isBlockhashExpiredError,
  prepareLegacyTransaction,
  resolveTxSettings,
  sendAndConfirmWithRetry,
  withPriorityFeeInstructions,
} from "../utils/tx.js";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isTimeoutError, TimeoutError, withTimeout } from "../utils/timeout.js";
import { pollBackoffMs } from "../telegram.js";
import {
  POOL_TIMEOUT_MESSAGE,
  POOL_TIMEOUT_MS,
  createAbortToken,
  formatBasicPoolMetrics,
  runIsolatedTask,
} from "../services/poolScreening.js";
import {
  clampIntervalMin,
  cronExprForInterval,
  shouldAcceptScreeningTrigger,
} from "../utils/schedule.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Async variant for chart rendering (canvas work returns promises). */
async function testAsync(name, fn) {
  await fn();
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
  assert.deepEqual(parseRangeInput("-50"), { downsidePct: 50, upsidePct: 0, upperPct: null });
  assert.deepEqual(parseRangeInput("-50%"), { downsidePct: 50, upsidePct: 0, upperPct: null });
  assert.deepEqual(parseRangeInput("-30 +40"), { downsidePct: 30, upsidePct: 40, upperPct: null });
  assert.deepEqual(parseRangeInput("+200"), { downsidePct: 0, upsidePct: 200, upperPct: null });
  assert.deepEqual(parseRangeInput("-30,40"), { downsidePct: 30, upsidePct: 40, upperPct: null });
  assert.equal(parseRangeInput("0"), null);
  assert.equal(parseRangeInput("-120"), null);
  assert.equal(parseRangeInput("-10 -20 -30"), null);
});

test("parseRangeInput understands below-price ranges like -80 -20", () => {
  assert.deepEqual(parseRangeInput("-80 -20"), { downsidePct: 80, upsidePct: 0, upperPct: -20 });
  assert.deepEqual(parseRangeInput("-50% -10%"), { downsidePct: 50, upsidePct: 0, upperPct: -10 });
  assert.deepEqual(parseRangeInput("-80,-20"), { downsidePct: 80, upsidePct: 0, upperPct: -20 });
  // upper bound must sit above (closer to active than) the lower bound
  assert.equal(parseRangeInput("-20 -80"), null);
  assert.equal(parseRangeInput("-80 -80"), null);
  assert.equal(parseRangeInput("-120 -20"), null);
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

console.log("\n=== Token mint search ===");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const HOT_POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";
const COLD_POOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function rawPool({ address, name, tokenX, tokenY, binStep, baseFee, tvl, volume24h, feeTvl24h }) {
  return {
    address,
    name,
    token_x: { address: tokenX, symbol: name.split("/")[0] },
    token_y: { address: tokenY, symbol: name.split("/")[1] },
    pool_config: { bin_step: binStep, base_fee_pct: baseFee },
    tvl,
    volume: { "24h": volume24h },
    fee_tvl_ratio: { "24h": feeTvl24h },
  };
}

const HOT_SOL_POOL = toTokenPoolEntry(rawPool({
  address: HOT_POOL,
  name: "Bonk/SOL",
  tokenX: BONK_MINT,
  tokenY: SOL_MINT,
  binStep: 100,
  baseFee: 1,
  tvl: 197_725,
  volume24h: 41_470,
  feeTvl24h: 0.0483,
}), BONK_MINT);

const COLD_SOL_POOL = toTokenPoolEntry(rawPool({
  address: COLD_POOL,
  name: "Bonk/SOL",
  tokenX: BONK_MINT,
  tokenY: SOL_MINT,
  binStep: 25,
  baseFee: 0.25,
  tvl: 11_655,
  volume24h: 1_986,
  feeTvl24h: 0.0039,
}), BONK_MINT);

const SOL_BASE_POOL = toTokenPoolEntry(rawPool({
  address: "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC",
  name: "SOL/USDC",
  tokenX: SOL_MINT,
  tokenY: USDC_MINT,
  binStep: 4,
  baseFee: 0.04,
  tvl: 4_338_248,
  volume24h: 36_186_336,
  feeTvl24h: 0.3247,
}), USDC_MINT);

const OTHER_QUOTE_POOL = toTokenPoolEntry(rawPool({
  address: "3nMFwZXwY1s1M27zX9yKw1GYbLsW3oNP6j2okMyzCfdv",
  name: "Bonk/USDC",
  tokenX: BONK_MINT,
  tokenY: USDC_MINT,
  binStep: 80,
  baseFee: 0.8,
  tvl: 238_737,
  volume24h: 316_174,
  feeTvl24h: 0.0002447,
}), BONK_MINT);

test("parseLpAddressCommand handles /lp <mint>, aliases and bad args", () => {
  assert.equal(parseLpAddressCommand(`/lp ${BONK_MINT}`), BONK_MINT);
  assert.equal(parseLpAddressCommand(`  /LP   ${BONK_MINT}  `), BONK_MINT);
  assert.equal(parseLpAddressCommand(`/lp@PrometheusBot ${BONK_MINT}`), BONK_MINT);
  assert.equal(parseLpAddressCommand(`/zap ${BONK_MINT}`), BONK_MINT);
  assert.equal(parseLpAddressCommand("/lp"), null);
  assert.equal(parseLpAddressCommand(`/lp ${BONK_MINT} extra`), null);
  assert.equal(parseLpAddressCommand("/lp not-a-mint"), null);
  assert.equal(parseLpAddressCommand("0.5"), null);

  assert.equal(isLpAddressCommandWithBadArg("/lp not-a-mint"), true);
  assert.equal(isLpAddressCommandWithBadArg(`/lp ${BONK_MINT}`), false);
  assert.equal(isLpAddressCommandWithBadArg("/lp"), false);
  assert.equal(isLpAddressCommandWithBadArg("just text"), false);
});

test("toTokenPoolEntry maps discovery pairs and flags SOL quote vs base", () => {
  assert.equal(HOT_SOL_POOL.address, HOT_POOL);
  assert.equal(HOT_SOL_POOL.name, "Bonk/SOL");
  assert.equal(HOT_SOL_POOL.binStep, 100);
  assert.equal(HOT_SOL_POOL.baseFee, 1);
  assert.equal(HOT_SOL_POOL.tvl, 197_725);
  assert.equal(HOT_SOL_POOL.volume, 41_470);
  assert.equal(HOT_SOL_POOL.feeTvl, 4.83);
  assert.equal(HOT_SOL_POOL.apr, Number((4.83 * 365).toFixed(2)));
  assert.equal(HOT_SOL_POOL.isSolPair, true);
  assert.equal(HOT_SOL_POOL.solIsQuote, true);
  assert.equal(HOT_SOL_POOL.usable, true);

  // SOL is token X → listed, but `openDlmmPosition` cannot deposit SOL as Y.
  assert.equal(SOL_BASE_POOL.isSolPair, true);
  assert.equal(SOL_BASE_POOL.solIsQuote, false);
  assert.equal(SOL_BASE_POOL.usable, false);

  assert.equal(OTHER_QUOTE_POOL.isSolPair, false);
  assert.equal(OTHER_QUOTE_POOL.usable, false);
});

test("rankPoolsForToken puts SOL-quoted pools first, then fee/volume/TVL", () => {
  const ranked = rankPoolsForToken([OTHER_QUOTE_POOL, SOL_BASE_POOL, COLD_SOL_POOL, HOT_SOL_POOL]);
  assert.deepEqual(
    ranked.map((pool) => pool.address),
    [HOT_POOL, COLD_POOL, SOL_BASE_POOL.address, OTHER_QUOTE_POOL.address],
  );
  assert.equal(ranked[0].usable, true);
});

test("token search renders the Zenith pool list and dashboard buttons", () => {
  const entries = tokenPoolEntries([HOT_SOL_POOL, SOL_BASE_POOL, OTHER_QUOTE_POOL]);
  const view = renderTokenPools({
    tokenMint: BONK_MINT,
    symbol: "Bonk",
    pools: entries,
    wallet: { wallet: "2hT6qabuzFvD2WixkgQCoYqpG2NrwiGnVa5T5XZWs68s", sol: 0.3 },
  });

  assert.match(view.text, /Bonk/);
  assert.match(view.text, /bin step 100/);
  assert.match(view.text, /Fee\/TVL 4\.83%/);
  assert.match(view.text, /APR≈1763\.0%/);
  assert.match(view.text, /1 usable · 1 skipped \(SOL is token X\) · 1 on other quotes/);
  assert.match(view.text, /Quick Zap/);

  const flat = view.keyboard.flat();
  assert.ok(flat.some((button) => button.callback_data === "lp:pool:0"), "missing pool button");
  assert.ok(flat.some((button) => button.callback_data === `lp:tok:${BONK_MINT}`), "missing refresh button");
  assert.ok(flat.some((button) => button.callback_data === "lp:main"), "missing main menu button");
  // Only the usable (SOL-quoted) pool gets a button.
  assert.equal(flat.some((button) => button.callback_data === "lp:pool:1"), false);
  for (const button of flat) {
    assert.ok(button.callback_data.length <= 64, `callback_data too long: ${button.callback_data}`);
  }
});

test("token search with no pool shows a clear error", () => {
  const view = renderTokenPools({ tokenMint: BONK_MINT, pools: [] });
  assert.match(view.text, /No DLMM pool found/);
  const callbacks = view.keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(callbacks, [`lp:tok:${BONK_MINT}`, "lp:main"]);
});

test("token search reports when only SOL-as-token-X pairs exist", () => {
  const view = renderTokenPools({ tokenMint: USDC_MINT, symbol: "USDC", pools: tokenPoolEntries([SOL_BASE_POOL]) });
  assert.match(view.text, /No SOL-quoted DLMM pool/);
  assert.equal(view.keyboard.flat().some((button) => button.callback_data === "lp:pool:0"), false);

  assert.deepEqual(buildTokenPoolsKeyboard({}), [[{ text: "🏠 Main Menu", callback_data: "lp:main" }]]);
});

console.log("\n=== Main dashboard hub ===");

const WALLET = {
  wallet: "2hT6qabuzFvD2WixkgQCoYqpG2NrwiGnVa5T5XZWs68s",
  sol: 0.42,
  sol_usd: 38.62,
  usdc: 12.5,
  total_usd: 412.33,
  tokens: [
    { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", balance: 0.42, usd: 38.62 },
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", balance: 12.5, usd: 12.5 },
    { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", balance: 3.25, usd: 3.25 },
    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", balance: 1_500_000, usd: 21.4 },
    { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", balance: 10, usd: 0 },
  ],
};

test("truncateAddress shortens to head...tail", () => {
  assert.equal(truncateAddress(WALLET.wallet), "2hT6qa...s68s");
  assert.equal(truncateAddress(""), "not linked");
  assert.equal(truncateAddress("short"), "short");
});

test("findTokenBalance matches by mint, then symbol", () => {
  assert.equal(findTokenBalance(WALLET.tokens, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT").balance, 3.25);
  assert.equal(findTokenBalance(WALLET.tokens, "unknown-mint", "BONK").balance, 1_500_000);
  assert.equal(findTokenBalance(WALLET.tokens, "unknown-mint", "NOPE"), null);
});

test("hub renders banner, copyable wallet and SOL/USDC/USDT balances", () => {
  const view = renderDashboardHub({ wallet: WALLET });
  assert.match(view.text, /Prometheus LP/);
  assert.match(view.text, /Meteora DLMM Hub/);
  assert.match(view.text, /<code>2hT6qa\.\.\.s68s<\/code>/);
  assert.match(view.text, /◎ SOL <b>0\.42<\/b>/);
  assert.match(view.text, /USDC <b>12\.5<\/b>/);
  assert.match(view.text, /USDT <b>3\.25<\/b>/);
  assert.match(view.text, /Total ≈ <b>\$412\.33<\/b>/);
});

test("hub keyboard matches the Zenith 7-row grid", () => {
  const rows = buildHubKeyboard(WALLET);
  assert.equal(rows.length, 7);
  const labels = rows.map((row) => row.map((button) => button.text));
  assert.deepEqual(labels[0], ["💧 New LP Position", "📊 My Positions"]);
  assert.deepEqual(labels[1], ["🔥 Top Trending", "💰 Balance"]);
  assert.deepEqual(labels[2], ["📅 Profit Calendar", "🔗 Chain: Solana"]);
  assert.equal(labels[3].length, 1);
  assert.match(labels[3][0], /^👛 Wallet: 2hT6qa\.\.\.s68s$/);
  assert.deepEqual(labels[4], ["🌊 DAMM v2 Positions"]);
  assert.deepEqual(labels[5], ["👥 Referrals", "⚙️ Settings"]);
  assert.deepEqual(labels[6], ["💖 Donate", "🆘 Help Center"]);

  const flat = rows.flat();
  // Settings must reuse the existing cfg:* settings router.
  assert.equal(flat.find((button) => button.text === "⚙️ Settings").callback_data, "cfg:page:main");
  const expected = [
    "lp:new_position", "lp:positions", "lp:trending", "lp:balance", "lp:calendar",
    "lp:chain", "lp:wallet", "lp:damm", "lp:referrals", "lp:donate", "lp:help",
  ];
  for (const callback of expected) {
    assert.ok(flat.some((button) => button.callback_data === callback), `missing ${callback}`);
  }
  for (const button of flat) {
    assert.ok(button.callback_data.length <= 64, `callback_data too long: ${button.callback_data}`);
  }
});

console.log("\n=== Hub sub-views ===");

test("positions view shows PnL, unclaimed fees and navigation", () => {
  const positions = [{
    position: "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd",
    pair: "Anakin/SOL",
    in_range: true,
    total_value_usd: 52.4,
    pnl_usd: 4.2,
    pnl_pct: 8.1,
    unclaimed_fees_usd: 1.15,
    lower_bin: 1180,
    upper_bin: 1234,
    active_bin: 1230,
    age_minutes: 42,
  }];
  const view = renderPositions({ positions, wallet: WALLET, mode: "USD" });
  assert.match(view.text, /My Positions<\/b> · 1/);
  assert.match(view.text, /Anakin\/SOL/);
  assert.match(view.text, /PnL \+\$4\.20 \(\+8\.10%\)/);
  assert.match(view.text, /Unclaimed \$1\.15/);
  assert.match(view.text, /1180→1234 \(active 1230\)/);
  const callbacks = view.keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("lp:positions:refresh"));
  assert.ok(callbacks.includes("lp:main"));
});

test("positions view falls back to the empty state", () => {
  const view = renderPositions({ positions: [] });
  assert.match(view.text, /No open Meteora DLMM positions/);
  const callbacks = view.keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("lp:positions:refresh"));
  assert.ok(callbacks.includes("lp:main"));
});

console.log("\n=== Active position text metrics ===");

test("range position percentage tracks the active bin inside min/max bins", () => {
  assert.equal(computeRangePositionPct({ lowerBinId: 100, upperBinId: 140, activeBinId: 126 }), 65);
  assert.equal(computeRangePositionPct({ lowerBinId: 100, upperBinId: 140, activeBinId: 100 }), 0);
  assert.equal(computeRangePositionPct({ lowerBinId: 100, upperBinId: 140, activeBinId: 140 }), 100);
  // Out of range clamps instead of overflowing the bar.
  assert.equal(computeRangePositionPct({ lowerBinId: 100, upperBinId: 140, activeBinId: 162 }), 100);
  assert.equal(computeRangePositionPct({ lowerBinId: 100, upperBinId: 140, activeBinId: 81 }), 0);
  // Reversed bounds are normalised.
  assert.equal(computeRangePositionPct({ lowerBinId: 140, upperBinId: 100, activeBinId: 120 }), 50);
  // Unknown bins render nothing instead of a fake bar.
  assert.equal(computeRangePositionPct({ lowerBinId: null, upperBinId: 140, activeBinId: 120 }), null);
  assert.equal(computeRangePositionPct({ lowerBinId: 100, upperBinId: 140 }), null);
  assert.equal(computeRangePositionPct(), null);
});

test("range position percentage handles single-sided SOL limit ranges", () => {
  // -80 % → -20 % preset below the active price (active bin 0): the price is
  // above the whole range, so the position is filled to the top.
  assert.equal(computeRangePositionPct({ lowerBinId: -805, upperBinId: -112, activeBinId: 0 }), 100);
  // Price still above the range.
  assert.equal(computeRangePositionPct({ lowerBinId: -805, upperBinId: -112, activeBinId: -20 }), 100);
  // Price dropped into the range: the percentage is measured inside the range.
  const middle = computeRangePositionPct({ lowerBinId: -805, upperBinId: -112, activeBinId: -458 });
  assert.ok(middle >= 49 && middle <= 51, `expected ~50%, got ${middle}`);
  // Price below the range.
  assert.equal(computeRangePositionPct({ lowerBinId: -805, upperBinId: -112, activeBinId: -900 }), 0);
  // Single-bin ranges.
  assert.equal(computeRangePositionPct({ lowerBinId: 10, upperBinId: 10, activeBinId: 10 }), 100);
  assert.equal(computeRangePositionPct({ lowerBinId: 10, upperBinId: 10, activeBinId: 9 }), 0);
});

test("range bar renders the exact concentration", () => {
  assert.equal(renderRangeBar(65), "[██████░░░░]");
  assert.equal(renderRangeBar(0), "[░░░░░░░░░░]");
  assert.equal(renderRangeBar(100), "[██████████]");
  assert.equal(renderRangeBar(99.9), "[█████████░]");
  assert.equal(renderRangeBar(null), "[░░░░░░░░░░]");
  assert.equal(renderRangeBar(50, 4), "[██░░]");
});

test("active position lines show bold status, range position and market cap", () => {
  assert.equal(formatRangeStatus(true), "🟢 <b>IN RANGE</b>");
  assert.equal(formatRangeStatus(false), "🔴 <b>OUT OF RANGE</b>");
  assert.equal(formatRangeStatus(null), "⚪ <b>RANGE UNKNOWN</b>");

  assert.equal(formatCompactUsd(1_250_000), "$1.25M");
  assert.equal(formatCompactUsd(940_000), "$940.0K");
  assert.equal(formatCompactUsd(2_400_000_000), "$2.40B");
  assert.equal(formatCompactUsd(12.5), "$12.50");
  assert.equal(formatCompactUsd(null), null);
  assert.equal(formatCompactUsd(0), null);
  assert.equal(formatMarketCapLine(1_250_000), "🧢 MC: <b>$1.25M</b>");
  assert.equal(formatMarketCapLine(0), null);

  assert.equal(
    formatRangePositionLine({ lower_bin: 100, upper_bin: 140, active_bin: 126 }),
    "📍 Range Position: <b>65%</b> [██████░░░░]",
  );
  assert.equal(formatRangePositionLine({}), null);

  const text = formatPositionLine({
    position: "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd",
    pair: "Anakin/SOL",
    in_range: false,
    total_value_usd: 52.4,
    pnl_usd: -4.2,
    pnl_pct: -8.1,
    unclaimed_fees_usd: 1.15,
    lower_bin: -805,
    upper_bin: -112,
    active_bin: 0,
    age_minutes: 42,
    mcap: 1_250_000,
  }, 0);
  assert.match(text, /Anakin\/SOL<\/b> 🔴 <b>OUT OF RANGE<\/b>/);
  assert.match(text, /PnL -\$4\.20 \(-8\.10%\)/);
  assert.match(text, /📍 Range Position: <b>100%<\/b> \[██████████\]/);
  assert.match(text, /🧢 MC: <b>\$1\.25M<\/b>/);
});

test("open positions stay text-only (no PnL card generator in lp-menu)", () => {
  const src = fs.readFileSync(path.join(ROOT, "services/lp-menu.js"), "utf8");
  assert.doesNotMatch(src, /pnlCardGenerator/);
  assert.match(src, /formatRangeStatus\(position\?\.in_range\)/);
});

test("balance view lists SOL/USDC/USDT and SPL tokens", () => {
  const view = renderBalances({ wallet: WALLET });
  assert.match(view.text, /◎ SOL <b>0\.42<\/b>/);
  assert.match(view.text, /USDC <b>12\.5<\/b>/);
  assert.match(view.text, /USDT <b>3\.25<\/b>/);
  assert.match(view.text, /SPL tokens<\/b> · 2/);
  assert.match(view.text, /BONK/);
  assert.deepEqual(
    view.keyboard.flat().map((button) => button.callback_data),
    ["lp:balance:refresh", "lp:main"],
  );
  assert.equal(formatMoney(4.2, "USD"), "$4.20");
  assert.equal(formatMoney(0.42, "SOL"), "0.42 SOL");
});

test("profit calendar renders history and the empty placeholder", () => {
  const history = {
    hours: 24,
    count: 2,
    total_pnl_usd: 6.3,
    win_rate_pct: 50,
    positions: [
      { pool_name: "Bonk/SOL", pnl_usd: -1.8, pnl_pct: -2.1, minutes_held: 40, close_reason: "stop-loss", closed_at: "2026-03-01T09:00:00.000Z" },
      { pool_name: "Anakin/SOL", pnl_usd: 8.1, pnl_pct: 7.2, fees_earned_usd: 2.4, minutes_held: 90, close_reason: "take-profit", closed_at: "2026-03-01T12:30:00.000Z" },
    ],
  };
  const summary = { total_positions_closed: 12, total_pnl_usd: 56.78, avg_pnl_pct: 3.4, win_rate_pct: 67 };
  const view = renderProfitCalendar({ summary, history, hours: 24 });
  assert.match(view.text, /Closed <b>2<\/b>/);
  assert.match(view.text, /Win rate <b>50%<\/b>/);
  assert.match(view.text, /Realised <b>\$6\.30<\/b>/);
  assert.match(view.text, /All time: 12 closed/);
  assert.match(view.text, /take-profit/);
  assert.match(view.text, /🟢/);
  assert.match(renderProfitCalendar({ hours: 7 }).text, /No closed positions/);
});

test("every sub-view offers a way back to the hub", () => {
  const views = [
    renderChainView(),
    renderWalletView({ wallet: WALLET }),
    renderDammView(),
    renderReferralsView(),
    renderDonateView({ wallet: WALLET }),
    renderHelpView(),
    renderBalances({ wallet: WALLET }),
    renderProfitCalendar(),
    renderPositions({ positions: [] }),
  ];
  for (const view of views) {
    const callbacks = view.keyboard.flat().map((button) => button.callback_data);
    assert.ok(callbacks.includes("lp:main"), `missing back button in: ${view.text.split("\n")[0]}`);
  }
  assert.match(
    renderWalletView({ wallet: WALLET }).text,
    /<code>2hT6qabuzFvD2WixkgQCoYqpG2NrwiGnVa5T5XZWs68s<\/code>/,
  );
  assert.match(renderDammView().text, /DAMM v2/);
});

console.log("\n=== New LP landing & trending ===");

const TRENDING_FIXTURES = [
  { address: "AnakinPool111111111111111111111111111111", name: "Anakin/SOL", tokenXMint: "AnakinMint1111111111111111111111111111111", binStep: 50, tvl: 120_000, volume: 900_000, feeTvl: 3.2, usable: true },
  { address: "PeacePool1111111111111111111111111111111", name: "PEACE/SOL", tokenXMint: "PeaceMint11111111111111111111111111111111", binStep: 100, tvl: 80_000, volume: 1_500_000, feeTvl: 1.1, usable: true },
  { address: "FloatPool1111111111111111111111111111111", name: "FLOAT/SOL", tokenXMint: "FloatMint11111111111111111111111111111111", binStep: 25, tvl: 40_000, volume: 300_000, feeTvl: 9.5, usable: true },
  { address: "AnakinPool222222222222222222222222222222", name: "Anakin/SOL", tokenXMint: "AnakinMint1111111111111111111111111111111", binStep: 250, tvl: 60_000, volume: 500_000, feeTvl: 2.0, usable: true },
  { address: "DustPool11111111111111111111111111111111", name: "DUST/SOL", tokenXMint: "DustMint111111111111111111111111111111111", binStep: 10, tvl: 100, volume: 50, feeTvl: 20, usable: true },
  { address: "SolUsdcPool11111111111111111111111111111", name: "SOL/USDC", tokenXMint: "So11111111111111111111111111111111111111112", binStep: 4, tvl: 4_338_248, volume: 36_186_336, feeTvl: 32, usable: false },
];

test("new-position landing prompts for a CA before any pool scan", () => {
  const picks = buildQuickTokenPicks({});
  const view = renderNewPositionView({ picks });

  assert.match(view.text, /💧 <b>New LP Position<\/b>/);
  assert.ok(view.text.includes(NEW_POSITION_PROMPT), "landing copy must match the spec");
  assert.match(view.text, /Quick picks/);

  const flat = view.keyboard.flat();
  const labels = flat.map((button) => button.text);
  const callbacks = flat.map((button) => button.callback_data);
  assert.ok(labels.includes("🔥 Top Trending"));
  assert.ok(labels.includes("⬅️ Main Menu"));
  assert.ok(callbacks.includes("lp:trending"));
  assert.ok(callbacks.includes("lp:main"));

  // Exactly 3 quick picks, each carrying a mint in its callback payload.
  const quickButtons = flat.filter((button) => button.callback_data.startsWith("lp:tok:"));
  assert.equal(quickButtons.length, 3);
  for (const button of quickButtons) {
    assert.ok(isSolanaAddress(button.callback_data.slice("lp:tok:".length)));
    assert.match(button.text, /^🪐 /);
    assert.ok(button.callback_data.length <= 64);
  }
  // The defaults themselves must be valid mainnet mints.
  for (const token of DEFAULT_QUICK_TOKENS) assert.ok(isSolanaAddress(token.mint));
});

test("quick token picks prefer recent tokens, dedupe and cap at 3", () => {
  const recentMint = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
  const picks = buildQuickTokenPicks({
    tokenQuery: { mint: recentMint, symbol: "FARTCOIN" },
    pools: [
      { baseMint: DEFAULT_QUICK_TOKENS[0].mint, baseSymbol: "BONK" },
      { baseMint: recentMint, baseSymbol: "DUP" },
      { baseMint: "not-an-address", baseSymbol: "BAD" },
    ],
  });

  assert.equal(picks.length, 3);
  assert.equal(picks[0].mint, recentMint);
  assert.equal(picks.filter((pick) => pick.mint === recentMint).length, 1);
  assert.equal(picks[1].mint, DEFAULT_QUICK_TOKENS[0].mint);
  assert.match(picks[0].label, /^🪐 FARTCOIN · 9BB6NF\.\.\.pump$/);
});

test("new-position keyboard wires quick picks to the token search", () => {
  const rows = buildNewPositionKeyboard([
    { mint: DEFAULT_QUICK_TOKENS[0].mint, label: "🪐 BONK · DezXAZ...B263" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0].callback_data, `lp:tok:${DEFAULT_QUICK_TOKENS[0].mint}`);
  assert.deepEqual(rows[1].map((button) => button.callback_data), ["lp:trending", "lp:main"]);
  assert.deepEqual(buildNewPositionKeyboard([]), [
    [{ text: "🔥 Top Trending", callback_data: "lp:trending" }, { text: "⬅️ Main Menu", callback_data: "lp:main" }],
  ]);
});

test("filterTrendingPools drops illiquid and non-SOL-quoted pools", () => {
  const kept = filterTrendingPools(TRENDING_FIXTURES);
  assert.deepEqual(kept.map((pool) => pool.address), [
    "AnakinPool111111111111111111111111111111",
    "PeacePool1111111111111111111111111111111",
    "FloatPool1111111111111111111111111111111",
    "AnakinPool222222222222222222222222222222",
  ]);
  // Relaxing the thresholds keeps the dust pool but never the non-SOL-quoted one.
  const loose = filterTrendingPools(TRENDING_FIXTURES, { minTvl: 0, minVolume: 0 });
  assert.equal(loose.length, 5);
  assert.equal(loose.some((pool) => pool.usable === false), false);
});

test("filterTrendingPools drops pools above the configured TVL cap", () => {
  // The ceiling is read from the loaded config (user-config.json → maxTvl).
  const cap = Number(config.screening.maxTvl);
  assert.ok(Number.isFinite(cap) && cap > 0, "user-config.json must define a positive maxTvl");
  assert.equal(getConfiguredMaxTvl(), cap);

  // A hugely attractive pool — highest volume in the set — that breaches the cap.
  const aboveCap = {
    address: "WhalePool1111111111111111111111111111111",
    name: "WHALE/SOL",
    tokenXMint: "WhaleMint1111111111111111111111111111111",
    binStep: 100,
    tvl: cap + 1,
    volume: 9_000_000,
    feeTvl: 4,
    usable: true,
  };
  // Exactly at the cap: still eligible (the cap is an upper bound, not exclusive).
  const atCap = {
    ...aboveCap,
    address: "AtCapPool1111111111111111111111111111111",
    tokenXMint: "AtCapMint11111111111111111111111111111111",
    tvl: cap,
  };

  const kept = filterTrendingPools([...TRENDING_FIXTURES, aboveCap, atCap]);
  assert.equal(kept.some((pool) => pool.address === aboveCap.address), false, "pool above maxTvl must be dropped");
  assert.ok(kept.some((pool) => pool.address === atCap.address), "pool at exactly maxTvl stays eligible");
  // Ranking must not resurrect it either (it has the highest volume of the set).
  assert.equal(
    rankTrendingPools(kept, { limit: 10 }).some((pool) => pool.address === aboveCap.address),
    false,
  );

  // `tvlUsd` (raw discovery shape) is honoured the same way as `tvl`.
  const rawShape = { ...aboveCap, tvl: undefined, tvlUsd: cap + 1 };
  assert.equal(filterTrendingPools([rawShape]).length, 0);
  assert.equal(filterTrendingPools([{ ...rawShape, tvlUsd: cap - 1 }]).length, 1);

  // Explicit override wins over the config value (UI / tests can retune it)…
  assert.deepEqual(
    filterTrendingPools(TRENDING_FIXTURES, { maxTvl: 50_000 }).map((pool) => pool.address),
    ["FloatPool1111111111111111111111111111111"],
  );
  // …and `0` / `null` disable the ceiling, keeping the lower-bound behaviour.
  const lowerBoundOnly = filterTrendingPools(TRENDING_FIXTURES);
  assert.deepEqual(filterTrendingPools(TRENDING_FIXTURES, { maxTvl: 0 }), lowerBoundOnly);
  assert.deepEqual(filterTrendingPools(TRENDING_FIXTURES, { maxTvl: null }), lowerBoundOnly);
});

test("rankTrendingPools ranks by volume/TVL/fee and keeps one pool per token", () => {
  const liquid = filterTrendingPools(TRENDING_FIXTURES);
  assert.deepEqual(
    rankTrendingPools(liquid, { limit: 10 }).map((pool) => pool.address),
    [
      "PeacePool1111111111111111111111111111111",
      "AnakinPool111111111111111111111111111111",
      "FloatPool1111111111111111111111111111111",
    ],
  );
  const perTokenTwo = rankTrendingPools(liquid, { limit: 10, perToken: 2 });
  assert.ok(perTokenTwo.some((pool) => pool.address === "AnakinPool222222222222222222222222222222"));
  assert.equal(rankTrendingPools(liquid, { limit: 2 }).length, 2);
  assert.ok(rankTrendingPools(liquid)[0].trendScore > 0);
  // Volume dominates: 10x volume must beat a small TVL/fee edge.
  assert.ok(
    scoreTrendingPool({ volume: 1_000_000, tvl: 10_000 }) >
    scoreTrendingPool({ volume: 100_000, tvl: 60_000, feeTvl: 9 }),
  );
  // fee/TVL is clamped: a collapsed-TVL pool with a 70,000%/day ratio cannot
  // outrank a genuinely high-volume pool.
  assert.ok(
    scoreTrendingPool({ volume: 5_000_000, tvl: 2_000_000, feeTvl: 40 }) >
    scoreTrendingPool({ volume: 600_000, tvl: 3_000, feeTvl: 70_772 }),
  );
});

test("trending view renders numbered Quick Zap buttons for each pool", () => {
  const entries = tokenPoolEntries(rankTrendingPools(filterTrendingPools(TRENDING_FIXTURES)));
  const view = renderTrendingPools({ pools: entries, wallet: WALLET });

  assert.match(view.text, /Top Trending<\/b> · 3 SOL pool\(s\)/);
  assert.match(view.text, /PEACE\/SOL/);
  assert.match(view.text, /bin step 100/);
  assert.match(view.text, /Quick Zap/);

  const flat = view.keyboard.flat();
  const labels = flat.map((button) => button.text);
  assert.ok(labels.includes("1. PEACE/SOL · bs100"), `unexpected labels: ${labels.join(" | ")}`);
  assert.ok(labels.includes("2. Anakin/SOL · bs50"));
  assert.ok(labels.includes("3. FLOAT/SOL · bs25"));
  assert.ok(labels.includes("⬅️ Main Menu"));

  const callbacks = flat.map((button) => button.callback_data);
  for (const expected of ["lp:pool:0", "lp:pool:1", "lp:pool:2", "lp:trending:refresh", "lp:main"]) {
    assert.ok(callbacks.includes(expected), `missing ${expected}`);
  }
  for (const button of flat) assert.ok(button.callback_data.length <= 64);
});

test("trending view falls back cleanly and ignores non-SOL pools", () => {
  const empty = renderTrendingPools({ pools: [] });
  assert.match(empty.text, /No trending pool right now/);
  assert.deepEqual(
    empty.keyboard.flat().map((button) => button.callback_data),
    ["lp:trending:refresh", "lp:main"],
  );

  const nonSol = renderTrendingPools({ pools: tokenPoolEntries([TRENDING_FIXTURES[5]]) });
  assert.match(nonSol.text, /No trending pool right now/);
  assert.equal(nonSol.keyboard.flat().some((button) => button.callback_data === "lp:pool:0"), false);
  assert.deepEqual(
    buildTrendingKeyboard([]).pop().map((button) => button.callback_data),
    ["lp:trending:refresh", "lp:main"],
  );
});

console.log("\n=== Quick Zap dashboard controls ===");

test("pool health follows the TVL / market-cap ratio", () => {
  assert.equal(poolHealthLabel({ tvl: 120_000, mcap: 2_400_000 }).label, "Normal"); // 5.0%
  assert.equal(poolHealthLabel({ tvl: 50_000, mcap: 2_500_000 }).label, "Normal"); // exactly 2%
  assert.equal(poolHealthLabel({ tvl: 10_000, mcap: 2_400_000 }).label, "Thin"); // 0.42%
  assert.equal(poolHealthLabel({ tvl: 120_000, mcap: null }).label, "Unknown");
  assert.equal(poolHealthLabel({}).emoji, "❔");
  assert.equal(poolHealthLabel({ tvl: 50_000, mcap: 2_500_000 }).ratioPct, 2);
});

test("bin-array rent and max spendable SOL are conservative", () => {
  assert.equal(estimateBinArrayRentSol(0), 0);
  assert.equal(estimateBinArrayRentSol(1), BIN_ARRAY_FEE_SOL);
  assert.equal(estimateBinArrayRentSol(70), BIN_ARRAY_FEE_SOL);
  assert.equal(estimateBinArrayRentSol(71), Number((2 * BIN_ARRAY_FEE_SOL).toFixed(8)));
  assert.equal(
    maxSpendableSol({ sol: 1.5, gasReserve: 0.2, totalBins: 54 }),
    Number((1.5 - 0.2 - BIN_ARRAY_FEE_SOL).toFixed(4)),
  );
  assert.equal(maxSpendableSol({ sol: 0.1, gasReserve: 0.2 }), 0);
  assert.equal(maxSpendableSol({ sol: Number.NaN }), 0);
});

test("amount and range descriptors format USD and percentages", () => {
  assert.equal(
    describeAmount({ amountMode: "sol", amountSol: 0.08 }, { sol: 1.2, sol_price: 200 }),
    "0.08 SOL (≈ $16.00)",
  );
  const pctLabel = describeAmount(
    { amountMode: "pct", amountPct: 50 },
    { sol: 1.2, sol_price: 200 },
    { gasReserve: 0.2 },
  );
  assert.match(pctLabel, /^50% of balance · 0\.5 SOL \(≈ \$100\.00\)$/);
  assert.equal(describeRange({ downsidePct: 30, upsidePct: 40 }), "-30% to +40%");
  assert.equal(describeRange({ downsidePct: 50 }), "-50% to 0%");
});

test("dashboard card shows health, amount+USD, range, strategy and Max", () => {
  const session = getLpSession({ chat: { id: 11 }, from: { id: 12 } });
  session.pool = {
    ...POOLS[0],
    activeBinId: 1234,
    activeBinSol: 0.582,
    binStep: 20,
    baseFee: 0.2,
    tvl: 120_000,
    mcap: 2_400_000,
  };
  session.amountMode = "sol";
  session.amountSol = 0.08;
  session.amountPct = null;
  session.downsidePct = 50;
  session.upsidePct = 0;
  session.rangeLabel = "-50%";
  session.strategy = "bid_ask";
  session.rangePreview = { minBinId: 1180, maxBinId: 1234, totalBins: 54 };

  const view = renderDashboard(session, { wallet: { sol: 1.5, sol_price: 200 } });
  assert.match(view.text, /🆕 <b>New Position: Anakin\/SOL<\/b>/);
  assert.match(view.text, /Binstep: 20 \| BaseFee: 0\.2%/);
  assert.match(view.text, /1 bin ≈ 0\.582 SOL/);
  assert.match(view.text, /Pool Health: <b>Normal<\/b> \(TVL\/MC 5\.0%\)/);
  assert.match(view.text, /💰 Amount: <b>0\.08 SOL \(≈ \$16\.00\)<\/b>/);
  assert.match(view.text, /📐 Range: <b>-50% to 0%<\/b>/);
  assert.match(view.text, /📊 Strategy: <b>BidAsk<\/b>/);
  assert.match(view.text, /💯 Max: <b>[\d.]+ SOL<\/b>/);
  assert.match(view.text, /⚡ Preset A: 1 SOL · -50% · Spot/);
  assert.match(view.text, /⚡ Preset B: [\d.]+ SOL · -90% · BidAsk/);
});

test("dashboard keyboard matches the Zenith control layout", () => {
  const session = getLpSession({ chat: { id: 21 }, from: { id: 22 } });
  session.amountMode = "pct";
  session.amountPct = 50;
  session.rangeLabel = "Custom";
  session.strategy = "bid_ask";

  const rows = buildDashboardKeyboard(session);
  const labels = rows.map((row) => row.map((button) => button.text));
  assert.deepEqual(labels[1], ["⚡ Preset A", "⚡ Preset B", "🛠 Custom"]);
  assert.deepEqual(labels[3], ["1 SOL", "✅ 50%", "100%"]);
  assert.deepEqual(labels[4], ["✏️ Custom", "✏️ Preset"]);
  assert.deepEqual(labels[6], ["-50%", "-30 +40", "+200%"]);
  assert.deepEqual(labels[7], ["⭐ Default", "✅ ✏️ Range", "✏️ Preset"]);
  assert.deepEqual(labels[8], ["📉 -80% to -20%", "📉 -50% to -10%"]);
  assert.deepEqual(labels[10], ["➖ Spot", "✅ ☍ BidAsk", "🔔 Curve"]);
  assert.deepEqual(labels[11], ["⚡ Spot & BA", "⚡ Spot & Curve"]);
  assert.deepEqual(labels[13], ["✅ Continue"]);
  assert.deepEqual(labels[14], ["⚡ Deploy Position"]);
  assert.deepEqual(labels[15], ["🔄 Refresh", "⬅️ Back", "🏠 Main Menu"]);

  const callbacks = rows.flat().map((button) => button.callback_data);
  const expected = [
    "lp:zap:a", "lp:zap:b", "lp:zap:custom",
    "lp:amt:1", "lp:amt:50", "lp:amt:100", "lp:amt:custom", "lp:amt:preset",
    "lp:rng:-50", "lp:rng:m30p40", "lp:rng:p200", "lp:rng:default", "lp:rng:custom", "lp:rng:preset",
    "lp:rng:b80t20", "lp:rng:b50t10",
    "lp:str:spot", "lp:str:bid_ask", "lp:str:curve", "lp:str:spot_ba", "lp:str:spot_curve",
    "lp:continue", "lp:deploy", "lp:refresh", "lp:back", "lp:main",
  ];
  for (const callback of expected) assert.ok(callbacks.includes(callback), `missing ${callback}`);
  for (const button of rows.flat()) assert.ok(button.callback_data.length <= 64);

  // Typing a custom range also lights the ✏️ Range button up.
  session.rangeLabel = "-50%";
  session.awaiting = "range";
  assert.ok(buildDashboardKeyboard(session).flat().some((button) => button.text === "✅ ✏️ Range"));
});

test("deploy receipt links the tx on Solscan and shows bin coverage", () => {
  const text = formatDeployResult({
    pool: "STONKpool111111111111111111111111111111111",
    pool_name: "STONK/SOL",
    amount_sol: 0.1,
    amount_token: 1250.5,
    two_sided: true,
    strategy: "spot_ba",
    strategy_label: "Spot & BA",
    bin_step: 20,
    base_fee: 0.2,
    swap_tx: "SwapTx1111111111111111111111111111111111111",
    bin_range: {
      minBinId: 1180,
      maxBinId: 1234,
      activeBinId: 1230,
      minPrice: 0.0001,
      maxPrice: 0.0002,
      downsideCoveragePct: 20,
      upsideCoveragePct: 10,
    },
    positions: [{ strategy: "spot", position: "Pos1111111111111111111111111111111111111111" }],
    txs: ["Tx111111111111111111111111111111111111111111"],
  });

  assert.match(text, /Position opened/);
  assert.match(text, /https:\/\/solscan\.io\/tx\/Tx111111/);
  assert.match(text, /https:\/\/solscan\.io\/tx\/SwapTx111/);
  assert.match(text, /Coverage: -20\.00% \/ \+10\.00%/);
  assert.match(text, /Binstep: 20 \| BaseFee: 0\.2%/);
  assert.match(text, /Spot &(?:amp;)? BA/);
});

console.log("\n=== Liquidity distribution chart ===");

const CHART_BINS = Array.from({ length: 41 }, (_, index) => {
  const binId = 1000 + index;
  const price = 0.002 * Math.pow(1.002, binId - 1020);
  return {
    binId,
    price: String(price),
    xAmount: { toString: () => String(2_000_000_000) }, // 2,000 tokens (6 decimals)
    yAmount: { toString: () => String(1_000_000_000) }, // 1 SOL (9 decimals)
  };
});

const CHART_SERIES = buildLiquiditySeries({
  bins: CHART_BINS,
  activeBinId: 1020,
  binStep: 20,
  xDecimals: 6,
  yDecimals: 9,
  yIsSol: true,
  userRange: { minBinId: 1010, maxBinId: 1020 },
  baseSymbol: "STONK",
  quoteSymbol: "SOL",
  poolAddress: "StonkPool11111111111111111111111111111111",
});

test("chart range helpers normalise bins and size the fetch window", () => {
  assert.deepEqual(normalizeUserRange({ minBinId: 120, maxBinId: 100 }), { minBinId: 100, maxBinId: 120 });
  assert.deepEqual(normalizeUserRange({ binsBelow: 30, binsAbove: 20 }, 500), { minBinId: 470, maxBinId: 520 });
  assert.deepEqual(normalizeUserRange(null), { minBinId: null, maxBinId: null });

  assert.deepEqual(deriveBinsEachSide(500, null), { left: 60, right: 60 });
  const wide = deriveBinsEachSide(500, { minBinId: 300, maxBinId: 500 });
  assert.equal(wide.left, 216); // 200 bins + 8 % headroom
  assert.equal(wide.right, 60); // default window on the upside
  const capped = deriveBinsEachSide(20_000, { minBinId: 0, maxBinId: 20_000 });
  assert.equal(capped.left, MAX_BINS_EACH_SIDE);
});

test("liquidity series converts bins to SOL and flags the user range", () => {
  assert.equal(CHART_SERIES.bins.length, 41);
  assert.equal(CHART_SERIES.inRangeBins, 11);
  assert.equal(CHART_SERIES.bins.find((bin) => bin.binId === 1020).inRange, true);
  assert.equal(CHART_SERIES.bins.find((bin) => bin.binId === 1021).inRange, false);
  assert.equal(CHART_SERIES.bins.find((bin) => bin.binId === 1020).pct, 0);
  assert.ok(CHART_SERIES.bins[0].pct < -3);

  // value = y + x * price (SOL is token Y)
  const active = CHART_SERIES.bins.find((bin) => bin.binId === 1020);
  const expected = 1 + 2_000 * Number(CHART_BINS[20].price);
  assert.ok(Math.abs(active.valueSol - expected) < 1e-6, `${active.valueSol} vs ${expected}`);
  assert.ok(CHART_SERIES.totalSol > 0 && CHART_SERIES.maxSol > 0);
  assert.equal(CHART_SERIES.quoteSymbol, "SOL");
});

test("chart axis ticks target -80/-50/0/+20/+40 percent", () => {
  const ticks = selectAxisTicks(CHART_SERIES);
  assert.ok(ticks.length >= 3 && ticks.length <= 6);
  assert.ok(ticks.some((tick) => tick.binId === 1020 && tick.pct === 0));
  for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i].binId > ticks[i - 1].binId);
});

test("chart signature changes only with pool, active bin or range", () => {
  const base = { poolAddress: "pool1", activeBinId: 10, minBinId: 5, maxBinId: 12 };
  assert.equal(chartSignature(base), chartSignature({ ...base }));
  assert.notEqual(chartSignature(base), chartSignature({ ...base, maxBinId: 13 }));
  assert.notEqual(chartSignature(base), chartSignature({ ...base, activeBinId: 11 }));
  assert.notEqual(chartSignature(base), chartSignature({ ...base, poolAddress: "pool2" }));
});

test("photo caption stays within Telegram's 1024-char limit", () => {
  const long = Array.from({ length: 80 }, (_, i) => `line ${i} <b>value</b>`).join("\n");
  const caption = buildPhotoCaption(long);
  assert.ok(caption.length <= PHOTO_CAPTION_LIMIT, `caption too long: ${caption.length}`);
  assert.ok(caption.endsWith("…"));
  assert.equal(buildPhotoCaption("hello"), "hello");
});

await testAsync("chart generator returns a valid PNG buffer", async () => {
  const png = await generateLiquidityDistributionChart(
    null,
    { minBinId: 1010, maxBinId: 1020 },
    { series: CHART_SERIES },
  );
  assert.ok(Buffer.isBuffer(png), "expected a Buffer");
  assert.ok(png.length > 5_000, `suspiciously small PNG: ${png.length} bytes`);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); // PNG magic
  assert.equal(png.readUInt32BE(16), CHART_DEFAULT_WIDTH);
  assert.equal(png.readUInt32BE(20), CHART_DEFAULT_HEIGHT);

  const small = await generateLiquidityDistributionChart(
    null,
    null,
    { series: CHART_SERIES, width: 640, height: 320 },
  );
  assert.equal(small.readUInt32BE(16), 640);
  assert.equal(small.readUInt32BE(20), 320);
});

console.log("\n=== Closed-position PnL card ===");

const PNL_CARD_FIXTURE = {
  position: "PnlCardPos111111111111111111111111111111111",
  pool: "PnlCardPool11111111111111111111111111111111",
  pool_name: "Anakin/SOL",
  pnl_usd: -12.34,
  pnl_pct: -8.1,
  initial_value_usd: 150,
  final_value_usd: 135.9,
  fees_earned_usd: 1.76,
  minutes_held: 315,
  opened_at: "2026-03-01T07:00:00.000Z",
  closed_at: "2026-03-01T12:15:00.000Z",
  bin_step: 20,
  bin_range: { min: 1180, max: 1234, active: 1200 },
  entry_bin_id: 1200,
  close_bin_id: 1170,
  base_fee_pct: 0.2,
  close_reason: "stop loss",
  price_path: [
    { at: 1_700_000_000_000, price: 11.2 },
    { at: 1_700_000_600_000, price: 11.6 },
    { at: 1_700_001_200_000, price: 11.1 },
    { at: 1_700_001_800_000, price: 10.6 },
  ],
};

test("pnl card helpers format hold time and bin prices", () => {
  assert.equal(formatHoldDuration(315), "5h 15m");
  assert.equal(formatHoldDuration(42), "42m");
  assert.equal(formatHoldDuration(1500), "1d 1h");
  assert.equal(formatHoldDuration(-5), "0m");
  assert.equal(formatHoldDuration(Number.NaN), "0m");

  assert.equal(priceAtBin(0, 20), 1);
  assert.ok(Math.abs(priceAtBin(100, 20) - Math.pow(1.002, 100)) < 1e-12);
  assert.equal(priceAtBin(10, 0), null);
  assert.equal(priceAtBin("nope", 20), null);
});

test("pnl card payload derives price lines from bins (incl. below-price ranges)", () => {
  const card = normalizePnlCardData(PNL_CARD_FIXTURE);
  assert.equal(card.pair, "Anakin/SOL");
  assert.equal(card.holdLabel, "5h 15m");
  assert.equal(card.profit, false);
  assert.equal(card.depositedUsd, 150);
  assert.equal(card.returnedUsd, 135.9);
  assert.equal(card.feesUsd, 1.76);
  assert.ok(Math.abs(card.prices.top - priceAtBin(1234, 20)) < 1e-12);
  assert.ok(Math.abs(card.prices.bottom - priceAtBin(1180, 20)) < 1e-12);
  assert.ok(card.prices.top > card.prices.bottom);
  assert.equal(card.pricePath.length, 4);
  assert.equal(card.pricePath[0].t, 0);
  assert.equal(card.pricePath[card.pricePath.length - 1].t, 1);

  // Single-sided SOL limit range entirely below the active price.
  const belowPrice = normalizePnlCardData({
    pool_name: "Peace/SOL",
    pnl_usd: 4.2,
    pnl_pct: 6.5,
    bin_step: 20,
    bin_range: { min: -805, max: -112 },
    entry_bin_id: 0,
    close_bin_id: -400,
  });
  assert.ok(belowPrice.prices.top > belowPrice.prices.bottom);
  assert.ok(belowPrice.prices.top < belowPrice.prices.entry, "below-price TOP sits under the entry price");
  assert.ok(belowPrice.prices.close < belowPrice.prices.top, "close moved into the range");
  // No recorded path → entry → close segment (never a fabricated curve).
  assert.deepEqual(belowPrice.pricePath.map((point) => point.price), [
    belowPrice.prices.entry,
    belowPrice.prices.close,
  ]);

  // Missing bins degrade to em dashes instead of throwing.
  const bare = normalizePnlCardData({ pair: "X/SOL", pnl_usd: 1, pnl_pct: 1 });
  assert.equal(bare.prices.top, null);
  assert.deepEqual(bare.pricePath, []);
  assert.equal(bare.feesUsd, 0);

  // PnL-history records (lessons.js) feed the same payload shape.
  const history = normalizePnlCardData({
    pool_name: "Peace/SOL",
    pnl_usd: 1.5,
    pnl_pct: 3,
    fees_earned_usd: 0.5,
    minutes_held: 30,
    recorded_at: "2026-03-02T10:00:00.000Z",
    close_reason: "take-profit",
  });
  assert.equal(history.closedAt, "2026-03-02T10:00:00.000Z");
  assert.equal(history.holdLabel, "30m");
  assert.equal(history.closeReason, "take-profit");
});

test("closed-position caption summarises the trade for Telegram", () => {
  const caption = buildClosedPositionCaption(PNL_CARD_FIXTURE);
  assert.match(caption, /🔒 <b>Closed<\/b> Anakin\/SOL/);
  assert.match(caption, /PnL: <b>-\$12\.34<\/b> \(-8\.10%\)/);
  assert.match(caption, /Deposited \$150\.00 → Returned \$135\.90/);
  assert.match(caption, /Fees \$1\.76/);
  assert.match(caption, /5h 15m held/);
  assert.match(caption, /stop loss/);
  assert.ok(caption.length <= PNL_CARD_CAPTION_LIMIT);

  const win = buildClosedPositionCaption({ pool_name: "A/B", pnl_usd: 12.34, pnl_pct: 8.1 });
  assert.match(win, /PnL: <b>\+\$12\.34<\/b> \(\+8\.10%\)/);

  const long = buildClosedPositionCaption({ pool_name: `<b>${"X".repeat(2000)}</b>`, pnl_usd: 1, pnl_pct: 1 });
  assert.ok(long.length <= PNL_CARD_CAPTION_LIMIT);
  assert.doesNotMatch(long, /<b>XXXX/); // pool names are escaped
});

test("price samples feed the card path and stay throttled", () => {
  clearPriceSamples();
  const t0 = 1_700_000_000_000;
  assert.equal(recordPriceSample("PosA", 100, 20, t0), true);
  assert.equal(recordPriceSample("PosA", 110, 20, t0 + 1_000), false); // inside the 15 s throttle
  assert.equal(recordPriceSample("PosA", 120, 20, t0 + 20_000), true);
  assert.equal(recordPriceSample("PosA", 130, 0, t0 + 40_000), false); // invalid bin step
  assert.equal(recordPriceSample("", 100, 20, t0), false); // no position address

  const samples = getPriceSamples("PosA");
  assert.equal(samples.length, 2);
  const path = buildPricePath(samples);
  assert.equal(path.length, 2);
  assert.equal(path[0].t, 0);
  assert.equal(path[1].t, 1);
  assert.ok(path[1].price > path[0].price);

  clearPriceSamples("PosA");
  assert.equal(getPriceSamples("PosA").length, 0);
  assert.deepEqual(buildPricePath(null), []);
  assert.equal(buildPricePath(null, { entryPrice: 2, closePrice: 3 }).length, 2);
});

test("pnl card renderer requires an injected canvas factory", () => {
  assert.throws(() => drawPnlCard({ pair: "X/SOL" }), /canvas factory is required/);
});

await testAsync("pnl card renders a valid PNG buffer", async () => {
  const png = await generatePnlCard(PNL_CARD_FIXTURE);
  assert.ok(Buffer.isBuffer(png), "expected a Buffer");
  assert.ok(png.length > 5_000, `suspiciously small PNG: ${png.length} bytes`);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); // PNG magic
  assert.equal(png.readUInt32BE(16), PNL_CARD_DEFAULT_WIDTH);
  assert.equal(png.readUInt32BE(20), PNL_CARD_DEFAULT_HEIGHT);

  const small = await generatePnlCard(PNL_CARD_FIXTURE, { width: 640, height: 400 });
  assert.equal(small.readUInt32BE(16), 640);
  assert.equal(small.readUInt32BE(20), 400);

  // Profitable card, a below-price range and an almost-empty payload all render.
  const win = await generatePnlCard({ ...PNL_CARD_FIXTURE, pnl_usd: 22.5, pnl_pct: 15 });
  assert.ok(win.length > 5_000);
  const belowPrice = await generatePnlCard({
    pool_name: "Peace/SOL",
    pnl_usd: 4.2,
    pnl_pct: 6.5,
    bin_step: 20,
    bin_range: { min: -805, max: -112 },
    entry_bin_id: 0,
    close_bin_id: -400,
  });
  assert.ok(belowPrice.length > 5_000);
  const bare = await generatePnlCard({ pair: "X/SOL" });
  assert.ok(bare.length > 2_000);
});

await testAsync("closed-position cards render in code and are dispatched detached", async () => {
  const pnlSrc = fs.readFileSync(path.join(ROOT, "services/pnlCardGenerator.js"), "utf8");
  const executorSrc = fs.readFileSync(path.join(ROOT, "tools/executor.js"), "utf8");
  const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

  // ── Pure code-based renderer: rust canvas, zero external assets ──
  assert.match(pnlSrc, /@napi-rs\/canvas/);
  assert.doesNotMatch(pnlSrc, /loadImage|drawImage|registerFont|readFileSync/, "no image/font assets may be loaded");
  assert.match(pnlSrc, /createLinearGradient\(/, "background panels are drawn in code");
  assert.match(pnlSrc, /setLineDash\(\[/, "price-path guides are code-drawn dashes");
  assert.equal(PNL_CARD_TIMEOUT_MS, 5_000);

  // ── Detached dispatch: setImmediate + hard deadline, never awaited ──
  assert.match(pnlSrc, /export function queueClosedPositionPnlCard\(/);
  assert.match(pnlSrc, /setImmediate\(/);
  assert.match(pnlSrc, /withTimeout\(work, deadlineMs/);
  for (const [label, src] of [["executor", executorSrc], ["index", indexSrc]]) {
    assert.doesNotMatch(src, /await\s+sendClosedPositionPnlCard\(/, `${label} must not await the card`);
  }
  assert.match(executorSrc, /queueClosedPositionPnlCard\(result/);

  // The Telegram poll loop / exit tick returns before the canvas even starts.
  let startedAt = 0;
  let settleCard = null;
  const stalled = new Promise((resolve) => { settleCard = resolve; });
  const dispatchedAt = Date.now();
  const scheduled = queueClosedPositionPnlCard(
    { pair: "X/SOL", pnl_usd: 1, pnl_pct: 1 },
    {
      timeoutMs: 60,
      send: () => { startedAt = Date.now(); return new Promise(() => {}); },
      onSettled: (error, messageId) => settleCard({ error, messageId }),
    },
  );
  assert.equal(scheduled, true);
  assert.ok(Date.now() - dispatchedAt < 100, "dispatch must return synchronously");
  assert.equal(startedAt, 0, "the renderer must not run inline with the close path");

  const timeout = await stalled;
  assert.equal(isTimeoutError(timeout.error), true, "a stalled upload is abandoned at the deadline");
  assert.equal(timeout.messageId, null);
  assert.ok(startedAt >= dispatchedAt, "the background job ran on a later event-loop turn");

  // A fast upload passes the message id through (real canvas, no Telegram).
  const fastCard = await new Promise((resolve) => {
    queueClosedPositionPnlCard(
      { position: "DetachedFastCard", pair: "X/SOL", pnl_usd: 2.5, pnl_pct: 1.5 },
      { timeoutMs: 4_000, send: async () => 4242, onSettled: (error, messageId) => resolve({ error, messageId }) },
    );
  });
  assert.equal(fastCard.error, null);
  assert.equal(fastCard.messageId, 4242);

  // A duplicate dispatch for a position already rendering is skipped.
  const slowSend = () => new Promise((resolve) => setTimeout(() => resolve(7), 20));
  assert.equal(queueClosedPositionPnlCard({ position: "DupCard" }, { timeoutMs: 1_000, send: slowSend }), true);
  assert.equal(queueClosedPositionPnlCard({ position: "DupCard" }, { timeoutMs: 1_000, send: slowSend }), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
});

test("every close path triggers the closed-position PnL card", () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const executorSrc = fs.readFileSync(path.join(ROOT, "tools/executor.js"), "utf8");
  const dlmmSrc = fs.readFileSync(path.join(ROOT, "tools/dlmm.js"), "utf8");
  // Automatic exits (hard TP/SL, range out) close through the executor.
  assert.match(executorSrc, /queueClosedPositionPnlCard\(result/);
  // Manual /close and /closeall close directly and dispatch the card themselves.
  const manualCalls = indexSrc.match(/dispatchClosedPositionPnlCard\(pos, result\)/g) || [];
  assert.ok(manualCalls.length >= 2, `expected /close and /closeall cards, found ${manualCalls.length}`);
  // Both close paths funnel through the detached dispatcher.
  assert.match(indexSrc, /function dispatchClosedPositionPnlCard\(pos, result\)/);
  assert.match(indexSrc, /queueClosedPositionPnlCard\(/);
  // The price path is sampled while the position is open.
  assert.match(indexSrc, /recordPriceSample\(/);
  // Close results carry everything the card needs.
  assert.match(dlmmSrc, /buildCloseSummaryFields\(\{/);
});

console.log("\n=== Below-the-price range presets ===");

test("below-price presets set both bounds under the active price", () => {
  const session = { pool: { binStep: 20 } };
  assert.equal(applyRangePreset(session, "b80t20"), true);
  assert.deepEqual(
    [session.downsidePct, session.upsidePct, session.rangeUpperPct, session.rangeLabel],
    [80, 0, -20, "-80 -20"],
  );
  assert.equal(describeRange(session), "-80% to -20% (Below Active Price)");

  assert.equal(applyRangePreset(session, "b50t10"), true);
  assert.equal(session.rangeUpperPct, -10);
  assert.equal(describeRange(session), "-50% to -10% (Below Active Price)");

  // Switching back to a standard preset clears the below-price upper bound.
  assert.equal(applyRangePreset(session, "-50"), true);
  assert.equal(session.rangeUpperPct, null);
  assert.equal(describeRange(session), "-50% to 0%");
});

test("range keyboard exposes and marks the below-price presets", () => {
  const session = getLpSession({ chat: { id: 31 }, from: { id: 32 } });
  session.downsidePct = 80;
  session.upsidePct = 0;
  session.rangeUpperPct = -20;
  session.rangeLabel = "-80 -20";

  const rows = buildDashboardKeyboard(session);
  const labels = rows.flat().map((button) => button.text);
  assert.ok(labels.includes("✅ 📉 -80% to -20%"));
  assert.ok(labels.includes("📉 -50% to -10%"));
  // The standard single-sided preset is no longer marked.
  assert.ok(labels.includes("-50%"));

  const callbacks = rows.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("lp:rng:b80t20"));
  assert.ok(callbacks.includes("lp:rng:b50t10"));
});

test("below-price dashboard reads clearly and the chart highlights the left side only", () => {
  const session = getLpSession({ chat: { id: 41 }, from: { id: 42 } });
  session.pool = {
    ...POOLS[0],
    binStep: 20,
    baseFee: 0.2,
    activeBinId: 0,
    activeBinSol: 0.5,
    tvl: 120_000,
    mcap: 2_400_000,
  };
  session.rangePreview = { minBinId: -805, maxBinId: -112, totalBins: 694 };
  applyRangePreset(session, "b80t20");

  const view = renderDashboard(session, { wallet: { sol: 2, sol_price: 180 } });
  assert.match(view.text, /📐 Range: <b>-80% to -20% \(Below Active Price\)<\/b>/);
  assert.match(view.text, /🗂 Bins: <b>-805<\/b> → <b>-112<\/b>/);

  // Chart series: only bins strictly below the active bin are in range.
  const bins = Array.from({ length: 21 }, (_, index) => {
    const binId = -10 + index;
    return {
      binId,
      price: String(Math.pow(0.998, 10 - binId)),
      xAmount: { toString: () => "0" }, // single-sided SOL
      yAmount: { toString: () => "1000000000" },
    };
  });
  const series = buildLiquiditySeries({
    bins,
    activeBinId: 0,
    binStep: 20,
    xDecimals: 9,
    yDecimals: 9,
    yIsSol: true,
    userRange: { minBinId: -8, maxBinId: -2 },
  });
  assert.deepEqual(series.bins.filter((bin) => bin.inRange).map((bin) => bin.binId), [-8, -7, -6, -5, -4, -3, -2]);
  assert.equal(series.bins.find((bin) => bin.binId === 0).inRange, false);
  assert.ok(series.bins.filter((bin) => bin.binId > 0).every((bin) => !bin.inRange));
  assert.equal(series.bins.find((bin) => bin.binId === 0).pct, 0);
});

await testAsync("computeBinRange keeps below-price bounds under the active bin", async () => {
  const { computeBinRange } = await import("../services/meteoraService.js");
  const snapshot = { activeBinId: 0, binStep: 20, activePrice: 1 };

  const below = await computeBinRange({ snapshot, downsidePct: 80, upperPct: -20 });
  assert.equal(below.belowOnly, true);
  assert.ok(below.maxBinId < 0, `expected maxBinId below the active bin, got ${below.maxBinId}`);
  assert.ok(below.minBinId < below.maxBinId);
  assert.equal(below.binsAbove, 0); // nothing is deposited above the active bin
  assert.ok(below.totalBins > 100);
  assert.ok(below.downsideCoveragePct > 79 && below.downsideCoveragePct < 81);
  assert.ok(below.upsideCoveragePct < 0); // upper bound is below the active price
  assert.equal(below.upperPct, -20);

  // Standard single-sided ranges are unchanged.
  const standard = await computeBinRange({ snapshot, downsidePct: 50 });
  assert.equal(standard.maxBinId, 0);
  assert.equal(standard.belowOnly, false);
  assert.equal(standard.binsAbove, 0);
  assert.equal(standard.upperPct, null);

  // A swapped pair (-20 -80) is rejected instead of producing a huge upside.
  await assert.rejects(() => computeBinRange({ snapshot, downsidePct: 20, upperPct: -80 }), /Invalid below-price range/);
});

console.log("\n=== Network timeouts & Telegram polling resilience ===");

await testAsync("withTimeout releases slow work with a TimeoutError", async () => {
  // Fast work passes through untouched.
  assert.equal(await withTimeout(Promise.resolve(42), 250, "fast"), 42);

  // Stalled work is abandoned at the deadline instead of blocking the caller.
  const started = Date.now();
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 60, "stalled rpc"),
    (error) => {
      assert.equal(error instanceof TimeoutError, true);
      assert.equal(error.name, "TimeoutError");
      assert.equal(error.code, "ETIMEDOUT");
      assert.equal(error.label, "stalled rpc");
      assert.match(error.message, /stalled rpc timed out after 60ms/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1_000, "the deadline must fire immediately");

  // Rejections and disabled guards still propagate.
  await assert.rejects(() => withTimeout(Promise.reject(new Error("rpc down")), 250, "rpc"), /rpc down/);
  assert.equal(await withTimeout(Promise.resolve("ok"), 0, "disabled"), "ok");

  // Classification used by every caller.
  assert.equal(isTimeoutError(new TimeoutError("x", 10)), true);
  assert.equal(isTimeoutError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assert.equal(isTimeoutError(Object.assign(new Error("boom"), { code: "ETIMEDOUT" })), true);
  assert.equal(isTimeoutError(new Error("boom")), false);
  assert.equal(isTimeoutError(null), false);
});

test("pollBackoffMs grows exponentially and caps at 60s", () => {
  const fixed = { random: () => 0 };
  assert.equal(pollBackoffMs(1, fixed), 1_000);
  assert.equal(pollBackoffMs(2, fixed), 2_000);
  assert.equal(pollBackoffMs(3, fixed), 4_000);
  assert.equal(pollBackoffMs(4, fixed), 8_000);
  assert.equal(pollBackoffMs(10, fixed), 60_000);
  // Jitter can never push a delay past the cap.
  assert.equal(pollBackoffMs(99, { random: () => 0.999 }), 60_000);
  // Junk input still yields a usable delay.
  assert.ok(pollBackoffMs(undefined) >= 1_000);
});

test("telegram polling acks callbacks first and never awaits a handler", () => {
  const src = fs.readFileSync(path.join(ROOT, "telegram.js"), "utf8");

  // Immediate acknowledgement, before any view work is dispatched.
  const ackAt = src.indexOf("answerCallbackQuery(callback.id)");
  const dispatchAt = src.indexOf("dispatchUpdate(onMessage, {");
  assert.ok(ackAt > 0, "the poll loop must answer every callback query");
  assert.ok(dispatchAt > ackAt, "the ack must happen before the handler runs");

  // Non-blocking command queue: handlers are dispatched, never awaited inline.
  assert.equal(/await onMessage\(/.test(src), false, "the poll loop must not await handlers");
  assert.match(src, /function dispatchUpdate\(/);
  assert.match(src, /Handler failed for/);

  // Exponential backoff auto-reconnect around the polling engine.
  assert.match(src, /export function pollBackoffMs/);
  assert.match(src, /reconnecting in \$\{delay\}ms/);
  assert.match(src, /Polling loop exited unexpectedly/);
  assert.match(src, /if \(_pollLoopActive\) return;/);

  // Every outbound Bot API call is abortable, and duplicate acks are suppressed.
  assert.match(src, /function telegramFetch\(/);
  assert.match(src, /AbortSignal\.timeout\(/);
  assert.match(src, /claimCallbackAnswer/);
});

test("lp-menu bounds every /pool RPC, API and canvas call at 5s", () => {
  const src = fs.readFileSync(path.join(ROOT, "services/lp-menu.js"), "utf8");
  assert.match(src, /const NETWORK_TIMEOUT_MS = 5_000;/);
  assert.match(src, /const TIMEOUT_NOTE = "⚠️ Network timeout, please try again";/);
  assert.match(src, /function networkDeadline\(/);
  assert.match(src, /await sendHTML\(TIMEOUT_NOTE\)/);

  for (const label of [
    "wallet balances",
    "candidate scan",
    "trending scan",
    "pool metadata",
    "pool snapshot",
    "token pool search",
    "address lookup",
    "positions read",
    "liquidity chart",
    "pool refresh",
  ]) {
    assert.ok(src.includes(`"${label}"`), `network deadline label "${label}" missing`);
  }
  const guarded = (src.match(/networkDeadline\(/g) || []).length;
  assert.ok(guarded >= 10, `expected every network call to be guarded (found ${guarded})`);
});

test("index.js threads the interactive deadline through /pool and the command queue", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.match(src, /const NETWORK_TIMEOUT_MS = 5_000;/);
  assert.match(src, /const TIMEOUT_MESSAGE = "⚠️ Network timeout, please try again";/);
  assert.match(src, /useLLM: true,\s*silent: true,\s*ioTimeoutMs: NETWORK_TIMEOUT_MS,\s*abortToken,/);
  assert.match(src, /ioTimeoutMs = 0,/);
  // Every network read inside the interactive screening cycle is bounded.
  for (const label of [
    "positions read",
    "wallet read",
    "candidate scan",
    "smart wallet check",
    "token narrative",
    "token info",
    "active bin",
  ]) {
    assert.ok(src.includes(`"${label}"`), `interactive screening read "${label}" is not bounded`);
  }
  assert.match(src, /if \(scanTimedOut\)/);
  // Queued commands are replayed after a cycle, not only in the REPL path.
  const drains = (src.match(/drainTelegramQueue\(\)/g) || []).length;
  assert.ok(drains >= 3, `expected the queue to drain after each cycle (found ${drains})`);
  assert.match(src, /Queued command failed/);
});

console.log("\n=== /pool 8s isolation, cron dedupe & RPC fallback ===");

await testAsync("a slow LLM /pool handler times out at the deadline and returns the fallback UI", async () => {
  // The production budget is 8 s (asserted below); the behaviour is exercised with
  // a scaled-down deadline so the suite stays fast.
  assert.equal(POOL_TIMEOUT_MS, 8_000);
  assert.equal(
    POOL_TIMEOUT_MESSAGE,
    "⚠️ Screening timed out (RPC/LLM slow). Showing basic pool metrics instead.",
  );

  // A hung LLM call never settles — the isolated runner must still return.
  const started = Date.now();
  const outcome = await runIsolatedTask(
    () => new Promise(() => {}),
    { timeoutMs: 120, label: "pool screening" },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.label, "pool screening");
  assert.ok(Date.now() - started < 2_000, "the handler must be released at the deadline");

  // Fast work passes straight through.
  const fast = await runIsolatedTask(async () => "Screening Cycle report", { timeoutMs: 500 });
  assert.equal(fast.ok, true);
  assert.equal(fast.value, "Screening Cycle report");

  // A failing LLM call is captured, never thrown at the caller.
  const failing = await runIsolatedTask(async () => { throw new Error("llm exploded"); }, { timeoutMs: 500 });
  assert.equal(failing.ok, false);
  assert.match(failing.error.message, /llm exploded/);

  // Fallback UI: cached metrics only, no network.
  const fallback = formatBasicPoolMetrics(
    [{ name: "BONK/SOL", fee_active_tvl_ratio: 12.5, volume_window: 48000, tvl: 92000, active_pct: 71, organic_score: 74 }],
    { reason: "LLM/RPC slow" },
  );
  assert.match(fallback, /Basic pool metrics \(LLM\/RPC slow\)/);
  assert.match(fallback, /1\. BONK\/SOL \| fee\/aTVL 12\.5% \| vol \$48000 \| TVL \$92000 \| in-range 71% \| organic 74/);
  assert.match(formatBasicPoolMetrics([]), /No cached pool metrics yet/);
});

await testAsync("a detached task can never leak an unhandled rejection", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const outcome = await runIsolatedTask(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("late boom")), 120)),
      { timeoutMs: 30 },
    );
    assert.equal(outcome.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, 0, "late failures of an abandoned task must stay contained");
});

await testAsync("a timed-out /pool run is cancelled before it can deploy", async () => {
  const token = createAbortToken();
  assert.equal(token.aborted, false);
  token.throwIfAborted("pool"); // inside the deadline → no throw
  token.abort();
  assert.equal(token.aborted, true);
  assert.throws(() => token.throwIfAborted("pool"), /pool aborted after the deadline/);

  // The deadline is what flips the token.
  let fired = false;
  const outcome = await runIsolatedTask(
    () => new Promise(() => {}),
    { timeoutMs: 40, label: "pool screening", onDeadline: () => { fired = true; token.abort(); } },
  );
  assert.equal(outcome.timedOut, true);
  assert.equal(fired, true);

  // index.js checks the token at every checkpoint that could act.
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  for (const phase of ["before discovery", "before LLM selection", "before deploy"]) {
    assert.ok(src.includes(`abortIfCancelled("${phase}")`), `missing abort checkpoint: ${phase}`);
  }
});

test("cron expressions are minute-granular and can never fire sub-minute", () => {
  assert.equal(cronExprForInterval(10), "*/10 * * * *");
  assert.equal(cronExprForInterval(30), "*/30 * * * *");
  assert.equal(cronExprForInterval(0), "*/1 * * * *");      // invalid → 1 min
  assert.equal(cronExprForInterval(0.2), "*/1 * * * *");    // sub-minute → clamped
  assert.equal(cronExprForInterval("11s"), "*/1 * * * *");  // junk → 1 min
  assert.equal(cronExprForInterval(500), "*/59 * * * *");   // capped
  // Always 5 fields — a 6-field expression would make node-cron read *seconds*.
  for (const minutes of [1, 7, 11, 30, 59]) {
    assert.equal(cronExprForInterval(minutes).split(" ").length, 5);
  }
  assert.equal(clampIntervalMin(0.25), 1);
  assert.equal(clampIntervalMin(15), 15);
});

test("screening triggers are single-flight and de-duplicated", () => {
  const now = 1_000_000;
  const window = 30_000;

  const running = shouldAcceptScreeningTrigger({ isRunning: true, lastAcceptedAt: 0, now, dedupeMs: window });
  assert.equal(running.accept, false);
  assert.match(running.reason, /already running/);

  // The "fires again 11 s later" symptom: dropped by the dedupe window.
  const duplicate = shouldAcceptScreeningTrigger({ isRunning: false, lastAcceptedAt: now - 11_000, now, dedupeMs: window });
  assert.equal(duplicate.accept, false);
  assert.match(duplicate.reason, /duplicate trigger 11s/);

  assert.equal(
    shouldAcceptScreeningTrigger({ isRunning: false, lastAcceptedAt: now - window - 1, now, dedupeMs: window }).accept,
    true,
  );
  // Startup / explicit runs pass dedupeMs = 0.
  assert.equal(shouldAcceptScreeningTrigger({ isRunning: false, lastAcceptedAt: now - 1, now, dedupeMs: 0 }).accept, true);
});

test("index.js routes cron through the screening guards and isolates /pool", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

  // Single-flight guard + dedupe entry point.
  assert.match(src, /export function isScreeningRunning\(\)/);
  assert.match(src, /export async function requestScreeningCycle\(/);
  assert.match(src, /requestScreeningCycle\(\{ reason: "cron" \}\)/);
  assert.match(src, /shouldAcceptScreeningTrigger\(/);
  assert.match(src, /cronExprForInterval\(config\.schedule\.screeningIntervalMin, 30\)/);
  // No raw `*/${...}` interpolation left in the scheduler.
  assert.equal(/\*\/\$\{/.test(src), false, "cron expressions must go through cronExprForInterval");
  assert.match(src, /_cronStarted/);

  // /pool is deadline-isolated and has a metrics fallback.
  assert.match(src, /runIsolatedTask\(/);
  assert.match(src, /POOL_TIMEOUT_MS/);
  assert.match(src, /async function sendPoolTimeoutFallback\(/);
  assert.match(src, /POOL_TIMEOUT_MESSAGE/);
  assert.match(src, /const poolAddressMatch = text\.match\(/);

  // The cron screening callback is guarded before the cycle is spawned.
  const cronBlock = src.slice(src.indexOf("const screenTask = cron.schedule"), src.indexOf("const healthTask"));
  assert.match(cronBlock, /requestScreeningCycle\(\{ reason: "cron" \}\)/);
});

test("RPC position reads degrade to empty positions instead of stalling", () => {
  const pnl = fs.readFileSync(path.join(ROOT, "tools/pnl.js"), "utf8");
  assert.match(pnl, /rpc_warn/);
  assert.match(pnl, /RPC positions unavailable/);
  assert.match(pnl, /withTimeout\(/);
  assert.match(pnl, /AbortSignal\.timeout/);

  const dlmm = fs.readFileSync(path.join(ROOT, "tools/dlmm.js"), "utf8");
  assert.match(dlmm, /POSITIONS_RPC_TIMEOUT_MS/);
  assert.match(dlmm, /Portfolio API unavailable/);
  assert.match(dlmm, /positions: \[\], error:/);

  const index = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.match(index, /POSITIONS_READ_TIMEOUT_MS/);
  assert.match(index, /pnl_poll_warn/);
  assert.match(index, /if \(result\?\.error\)/);
});

console.log("\n=== ASCII tree layout & progress bars ===");

test("progress bar helper renders the range concentration", () => {
  assert.equal(renderProgressBar(65), "[██████░░░░]");
  assert.equal(renderProgressBar(0), "[░░░░░░░░░░]");
  assert.equal(renderProgressBar(100), "[██████████]");
  assert.equal(renderProgressBar(99.9), "[█████████░]");
  assert.equal(renderProgressBar(null), "[░░░░░░░░░░]");
  assert.equal(renderProgressBar(50, 4), "[██░░]");

  assert.equal(formatProgressBar(100), "[██████████] 100%");
  assert.equal(formatProgressBar(65), "[██████░░░░] 65%");
  assert.equal(formatProgressBar(null), null);
  // `renderRangeBar` keeps its historical name/behaviour on top of the helper.
  assert.equal(renderRangeBar(65), renderProgressBar(65));
  assert.equal(renderRangeBar(50, 4), "[██░░]");
});

test("tree rows use branch glyphs and drop empty optional rows", () => {
  assert.equal(formatTreeRows([]), "");
  assert.equal(formatTreeRows([null, undefined, ""]), "");
  assert.equal(
    formatTreeRows([
      { label: "💵 Value", value: "$52.40" },
      null,
      "plain",
      { label: "⏱ Age", value: "42m" },
    ]),
    "├─ 💵 Value $52.40\n├─ plain\n└─ ⏱ Age 42m",
  );
  assert.match(SECTION_DIVIDER, /^━{10,}$/);
});

test("/positions renders the tree layout with monospace values", () => {
  const text = formatOpenPositionsMessage({
    totalPositions: 2,
    maxPositions: 4,
    mode: "USD",
    positions: [
      {
        position: "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd",
        pair: "Anakin/SOL",
        in_range: true,
        total_value_usd: 52.4,
        pnl_usd: -4.2,
        pnl_pct: -8.1,
        unclaimed_fees_usd: 1.15,
        lower_bin: -805,
        upper_bin: -112,
        active_bin: 0,
        age_minutes: 42,
        mcap: 1_250_000,
      },
      {
        position: "ZzZzYyYyXxXx",
        pair: "Bonk/SOL",
        in_range: false,
        minutes_out_of_range: 14,
        total_value_usd: 10,
        pnl_usd: 1.5,
        pnl_pct: 3.2,
        unclaimed_fees_usd: 0.2,
        lower_bin: 100,
        upper_bin: 140,
        active_bin: 126,
        age_minutes: 61,
      },
    ],
  });

  assert.match(text, /📊 <b>OPEN POSITIONS<\/b> · <code>2\/4<\/code>/);
  assert.ok(text.includes(SECTION_DIVIDER), "sections are separated by the divider");
  assert.match(text, /<b>1<\/b> · <code>Anakin\/SOL<\/code> · 🟢 <b>IN RANGE<\/b>/);
  assert.match(text, /├─ 💵 Value <code>\$52\.40<\/code>/);
  assert.match(text, /├─ 📈 PnL <code>-\$4\.20<\/code> <code>-8\.10%<\/code>/);
  assert.match(text, /├─ 📍 Range <code>\[██████████\]<\/code> <code>100%<\/code>/);
  assert.match(text, /├─ 🧢 MC <code>\$1\.25M<\/code>/);
  assert.match(text, /<b>2<\/b> · <code>Bonk\/SOL<\/code> · 🔴 <b>OUT OF RANGE<\/b>/);
  assert.match(text, /├─ 📍 Range <code>\[██████░░░░\]<\/code> <code>65%<\/code>/);
  assert.match(text, /├─ 🚨 OOR <code>14m<\/code>/);
  assert.match(text, /└─ ⏱ Age <code>61m<\/code> · 🆔 <code>ZzZzYyYy…<\/code>/);
  assert.match(text, /💼 <code>2\/4<\/code> open · 💵 <code>\$62\.40<\/code>/);
  assert.match(text, /\/close &lt;n&gt; to close/);

  // Empty state keeps the divider + a way forward.
  const empty = formatOpenPositionsMessage({ positions: [], totalPositions: 0 });
  assert.match(empty, /No open positions\./);
  assert.match(empty, /\/pool/);
});

test("/positions never exceeds Telegram's 4096-character cap", () => {
  // Whole blocks are dropped and counted — the message is never sliced mid-tag.
  const many = formatOpenPositionsMessage({
    positions: Array.from({ length: 40 }, (_, i) => ({
      position: `Position${i}AbCdEfGhIjKlMnOpQrSt`,
      pair: `Token${i}/SOL`,
      in_range: true,
      total_value_usd: 10,
      pnl_usd: 1,
      pnl_pct: 1,
      unclaimed_fees_usd: 0.1,
      lower_bin: 0,
      upper_bin: 10,
      active_bin: 5,
      age_minutes: 5,
    })),
    totalPositions: 40,
  });
  assert.ok(many.length <= MESSAGE_LIMIT, `message must fit the Telegram cap (got ${many.length})`);
  assert.match(many, /… \+\d+ more/);
  assert.match(many, /<\/code>$|\/set &lt;n&gt; &lt;note&gt; to set instruction$/);
});

test("token symbols and values are escaped for the Telegram HTML parser", () => {
  assert.equal(escapeHtml("a<b>&c"), "a&lt;b&gt;&amp;c");
  const text = formatOpenPositionsMessage({
    positions: [{ pair: "<b>A&B</b>/SOL", in_range: null, total_value_usd: 10 }],
  });
  assert.match(text, /&lt;b&gt;A&amp;B&lt;\/b&gt;\/SOL/);
  assert.doesNotMatch(text, /<b>A&B<\/b>\/SOL/);
  assert.match(text, /⚪ <b>RANGE UNKNOWN<\/b>/);
});

test("out-of-range alerts reuse the same tree layout", () => {
  const text = formatOutOfRangeAlert({
    pair: "Anakin/SOL",
    minutesOOR: 14,
    mode: "USD",
    waitMinutes: 30,
    position: {
      lower_bin: 1180,
      upper_bin: 1234,
      active_bin: 1234,
      pnl_pct: -8.1,
      total_value_usd: 52.4,
    },
  });
  assert.match(text, /⚠️ <b>OUT OF RANGE<\/b> · <code>Anakin\/SOL<\/code>/);
  assert.ok(text.includes(SECTION_DIVIDER));
  assert.match(text, /├─ ⏱ Drifting <code>14m<\/code>/);
  assert.match(text, /├─ 📍 Range <code>\[██████████\]<\/code> <code>100%<\/code>/);
  assert.match(text, /├─ 📈 PnL <code>-8\.10%<\/code>/);
  assert.match(text, /└─ 💵 Value <code>\$52\.40<\/code>/);
  assert.match(text, /Close rule fires at <code>30m<\/code> out of range/);

  // Flat signature (pair + minutes only) still renders a valid message.
  const minimal = formatOutOfRangeAlert({ pair: "X/SOL", minutesOOR: 5 });
  assert.match(minimal, /└─ ⏱ Drifting <code>5m<\/code>/);
  assert.match(minimal, /Monitoring — no action taken yet/);
});

test("management cycle and /positions share the pure tree helpers", () => {
  const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const management = indexSrc.slice(
    indexSrc.indexOf("export async function runManagementCycle"),
    indexSrc.indexOf("export async function runScreeningCycle"),
  );
  assert.match(management, /formatTreeRows\(/, "management report uses the tree layout");
  assert.match(management, /formatProgressBar\(/, "management report uses the progress bar");
  assert.match(management, /SECTION_DIVIDER/, "management report uses section dividers");

  const positionsHandler = indexSrc.slice(
    indexSrc.indexOf('if (text === "/positions")'),
    indexSrc.indexOf("// /pool (no argument)"),
  );
  assert.match(positionsHandler, /formatOpenPositionsMessage\(/);

  const telegramSrc = fs.readFileSync(path.join(ROOT, "telegram.js"), "utf8");
  assert.match(telegramSrc, /formatOutOfRangeAlert\(/);

  // The layout module must stay pure: no imports, no I/O, no async work.
  const formatSrc = fs.readFileSync(path.join(ROOT, "services/telegramFormat.js"), "utf8");
  assert.equal(/^import\s/m.test(formatSrc), false, "format helpers must stay dependency-free");
  assert.equal(/\bfetch\s*\(/.test(formatSrc), false, "format helpers must never fetch");
  assert.equal(/\bawait\b/.test(formatSrc), false, "format helpers must stay synchronous");
});

console.log("\n=== Jupiter referral (disabled by default) ===");

// The old built-in referral address. It must not exist outside these fixtures.
const LEGACY_REFERRAL_ADDRESS = "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey";

test("referral params are omitted entirely when the fee is disabled", () => {
  // Default config: no account + 0 bps → feature off.
  assert.equal(buildJupiterReferralParams({ account: null, feeBps: 0 }), null);
  assert.equal(buildJupiterReferralParams({}), null);
  // 0 bps disables the fee even when an account is configured.
  assert.equal(buildJupiterReferralParams({ account: LEGACY_REFERRAL_ADDRESS, feeBps: 0 }), null);
  assert.equal(buildJupiterReferralParams({ account: LEGACY_REFERRAL_ADDRESS }), null);
  // No account disables the fee even with a valid bps.
  assert.equal(buildJupiterReferralParams({ account: "", feeBps: 50 }), null);
  assert.equal(buildJupiterReferralParams({ account: "not-a-pubkey", feeBps: 50 }), null);
  // Below Jupiter Ultra's 50 bps minimum.
  assert.equal(buildJupiterReferralParams({ account: LEGACY_REFERRAL_ADDRESS, feeBps: 40 }), null);

  // Payload: a disabled referral adds ZERO fee-account query parameters.
  const search = new URLSearchParams({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "1000000",
  });
  const before = search.toString();
  applyJupiterReferralParams(search, buildJupiterReferralParams({ account: null, feeBps: 0 }));
  assert.equal(search.toString(), before, "the request query must be untouched");
  assert.equal(search.has("referralAccount"), false);
  assert.equal(search.has("referralFee"), false);
  assert.equal(search.has("feeAccount"), false);
  assert.equal(search.has("referralFeeBps"), false);
});

test("referral params are attached only on an explicit opt-in", () => {
  const params = buildJupiterReferralParams({ account: LEGACY_REFERRAL_ADDRESS, feeBps: 50 });
  assert.deepEqual(params, { referralAccount: LEGACY_REFERRAL_ADDRESS, referralFee: 50 });

  const search = new URLSearchParams({ inputMint: "in", outputMint: "out" });
  applyJupiterReferralParams(search, params);
  assert.equal(search.get("referralAccount"), LEGACY_REFERRAL_ADDRESS);
  assert.equal(search.get("referralFee"), "50");

  // 255 is the documented ceiling, 256 is rejected.
  assert.equal(buildJupiterReferralParams({ account: LEGACY_REFERRAL_ADDRESS, feeBps: 255 }).referralFee, 255);
  assert.equal(buildJupiterReferralParams({ account: LEGACY_REFERRAL_ADDRESS, feeBps: 256 }), null);
});

test("config ships with the referral disabled and no hard-coded address", () => {
  const configSrc = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  assert.match(configSrc, /JUPITER_REFERRAL_FEE_BPS \?\? 0/, "the BPS default must be 0");
  assert.match(configSrc, /referralEnabled:/, "config exposes the derived flag");
  assert.doesNotMatch(configSrc, new RegExp(LEGACY_REFERRAL_ADDRESS), "no built-in referral address");

  assert.equal(typeof config.jupiter.referralEnabled, "boolean");
  const bps = Number(config.jupiter.referralFeeBps ?? 0);
  assert.ok(Number.isFinite(bps) && bps >= 0, `referralFeeBps must be a non-negative number (got ${bps})`);
  // Unless .env opts in with BOTH values, the feature is off.
  if (!config.jupiter.referralAccount || bps === 0) {
    assert.equal(config.jupiter.referralEnabled, false);
    assert.equal(getJupiterReferralParams(), null);
  }

  // Repo-wide guard: the legacy address must not survive anywhere in the
  // shipped sources / docs / .env.example (test fixtures are excluded).
  const SKIP_DIRS = new Set(["node_modules", ".git", "logs", "test", ".claude", "discord-listener"]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(js|mjs|cjs|md|example)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (fs.readFileSync(full, "utf8").includes(LEGACY_REFERRAL_ADDRESS)) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(offenders, [], `built-in referral address still present in: ${offenders.join(", ")}`);
});

test("referral card shows 'Disabled (0 BPS)' and hides the account", () => {
  const snapshot = { ...config.jupiter };
  try {
    config.jupiter.referralAccount = null;
    config.jupiter.referralFeeBps = 0;
    const disabled = renderReferralsView();
    assert.match(disabled.text, /Referral Fee: Disabled \(0 BPS\)/);
    // No account block at all — no address is displayed or hinted at.
    assert.doesNotMatch(disabled.text, /🔗/);
    assert.doesNotMatch(disabled.text, /<code>[1-9A-HJ-NP-Za-km-z]{32,44}<\/code>/);
    assert.match(disabled.text, /zero platform fee/);

    // Opt-in (custom account) → the card shows the fee and the account.
    config.jupiter.referralAccount = LEGACY_REFERRAL_ADDRESS;
    config.jupiter.referralFeeBps = 50;
    const enabled = renderReferralsView();
    assert.match(enabled.text, /Referral Fee: 50 BPS \(0\.50%\)/);
    assert.match(enabled.text, new RegExp(`<code>${LEGACY_REFERRAL_ADDRESS}</code>`));
  } finally {
    Object.assign(config.jupiter, snapshot);
  }
});

console.log("\n=== Transaction sending: expired blockhash retries + priority fees ===");

/** A 32-byte base58 value usable as a fake blockhash. */
const fakeBlockhash = () => Keypair.generate().publicKey.toBase58();

/** Deterministic build of one transfer instruction for the sender tests. */
function buildTestTransaction(payer) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = fakeBlockhash();
  return tx;
}

/** Fake Connection: records broadcasts, replays a scripted confirm outcome. */
function fakeConnection({ blockhashes = [], confirmFailures = 0 } = {}) {
  const state = { hashCalls: 0, broadcasts: [], confirms: 0 };
  const connection = {
    async getLatestBlockhash() {
      const blockhash = blockhashes[Math.min(state.hashCalls, blockhashes.length - 1)] ?? fakeBlockhash();
      state.hashCalls += 1;
      return { blockhash, lastValidBlockHeight: 1_000 + state.hashCalls };
    },
    async sendRawTransaction(raw) {
      const decoded = Transaction.from(raw);
      state.broadcasts.push({
        blockhash: decoded.recentBlockhash,
        signature: Buffer.from(decoded.signatures[0].signature).toString("base64"),
        computeBudget: decoded.instructions
          .filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
          .map((ix) => Number(ix.data[0])),
        priorityFee: decoded.instructions
          .filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && Number(ix.data[0]) === 3)
          .map((ix) => ix.data.readBigUInt64LE(1).toString()),
      });
      return `sig-${state.broadcasts.length}`;
    },
    async confirmTransaction() {
      state.confirms += 1;
      if (state.confirms <= confirmFailures) {
        const error = new Error("Signature sig-1 expired: block height exceeded");
        error.name = "TransactionExpiredBlockheightExceededError";
        throw error;
      }
    },
  };
  return { connection, state };
}

test("blockhash-expiry errors are detected across shapes", () => {
  const named = new Error("signature expired");
  named.name = "TransactionExpiredBlockheightExceededError";
  assert.equal(isBlockhashExpiredError(named), true);

  assert.equal(isBlockhashExpiredError(new Error("Signature 4xY… expired: block height exceeded")), true);
  assert.equal(isBlockhashExpiredError({ code: -32002, message: "Blockhash not found" }), true);
  assert.equal(isBlockhashExpiredError({ message: "send failed", error: { code: -32002, message: "Blockhash not found" } }), true);
  assert.equal(isBlockhashExpiredError({ logs: ["Program log: ok", "BlockheightExceeded"] }), true);
  assert.equal(isBlockhashExpiredError("Signature has expired"), true);

  // Everything else must fail fast instead of burning blockhash slots.
  assert.equal(isBlockhashExpiredError(new Error("Transaction simulation failed: insufficient funds")), false);
  assert.equal(isBlockhashExpiredError({ code: 6001, message: "Slippage tolerance exceeded" }), false);
  assert.equal(isBlockhashExpiredError(null), false);
  assert.equal(isBlockhashExpiredError(undefined), false);
});

test("priority fee instructions come from config and are never duplicated", () => {
  assert.equal(MAX_SEND_RETRIES, 3);
  const settings = resolveTxSettings();
  assert.ok(Number.isFinite(settings.priorityFeeMicroLamports));
  assert.ok(settings.priorityFeeMicroLamports > 0, "priority fee must be enabled by default");
  assert.equal(settings.maxSendRetries, 3);
  // Clamped to the hard cap / floor.
  assert.equal(resolveTxSettings({ maxSendRetries: 99 }).maxSendRetries, 3);
  assert.equal(resolveTxSettings({ maxSendRetries: -5 }).maxSendRetries, 0);

  const feeInstructions = buildPriorityFeeInstructions({
    priorityFeeMicroLamports: 50_000,
    computeUnitLimit: 200_000,
  });
  assert.equal(feeInstructions.length, 2);
  assert.ok(feeInstructions.every((ix) => ix.programId.equals(ComputeBudgetProgram.programId)));
  assert.equal(Number(feeInstructions[0].data[0]), 2, "setComputeUnitLimit first");
  assert.equal(Number(feeInstructions[1].data[0]), 3, "setComputeUnitPrice second");
  assert.equal(feeInstructions[1].data.readBigUInt64LE(1), 50_000n);

  // 0 µL / no limit → no instruction at all (fee disabled).
  assert.deepEqual(buildPriorityFeeInstructions({}), []);
  assert.deepEqual(buildPriorityFeeInstructions({ priorityFeeMicroLamports: 0, computeUnitLimit: 0 }), []);

  // Existing ComputeBudget instructions are kept as-is (no duplicates).
  const deduped = withPriorityFeeInstructions(feeInstructions, {
    priorityFeeMicroLamports: 50_000,
    computeUnitLimit: 200_000,
  });
  assert.equal(deduped.length, 2);
});

test("prepared transactions carry the fresh blockhash and the priority fee", () => {
  const payer = Keypair.generate();
  const original = buildTestTransaction(payer);
  const originalBlockhash = original.recentBlockhash;
  const fresh = fakeBlockhash();

  const prepared = prepareLegacyTransaction(original, {
    blockhash: fresh,
    lastValidBlockHeight: 424_242,
    priorityFeeMicroLamports: 50_000,
    computeUnitLimit: 200_000,
  });

  assert.equal(prepared.recentBlockhash, fresh);
  assert.equal(prepared.lastValidBlockHeight, 424_242);
  assert.ok(prepared.feePayer.equals(payer.publicKey));
  assert.equal(prepared.instructions.length, 3, "2 ComputeBudget instructions + the transfer");
  assert.ok(prepared.instructions[0].programId.equals(ComputeBudgetProgram.programId));
  assert.ok(prepared.instructions[1].programId.equals(ComputeBudgetProgram.programId));
  assert.ok(prepared.instructions[2].programId.equals(SystemProgram.programId), "the payload stays last");
  // The caller's transaction is never mutated, so it can be retried as-is.
  assert.equal(original.recentBlockhash, originalBlockhash);
  assert.equal(original.instructions.length, 1);
});

test("the priority fee is dropped when the packet is already at the size limit", () => {
  const payer = Keypair.generate();
  const programId = Keypair.generate().publicKey;
  const buildBulky = (dataLength) => {
    const tx = new Transaction().add({
      programId,
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.alloc(dataLength, 7),
    });
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = fakeBlockhash();
    return tx;
  };

  // Size the payload so the transaction fits on its own but NOT with the two
  // ComputeBudget instructions (~40 bytes) added on top.
  const overhead = buildBulky(0).serializeMessage().length;
  const dataLength = Math.max(1, 1232 - 3 - 64 - overhead - 8);
  const bulky = buildBulky(dataLength);
  const baseSize = bulky.serializeMessage().length + 3 + 64;
  assert.ok(baseSize <= 1232, "the fixture itself must fit a packet");

  const prepared = prepareLegacyTransaction(bulky, {
    blockhash: fakeBlockhash(),
    priorityFeeMicroLamports: 50_000,
    computeUnitLimit: 200_000,
  });

  assert.equal(
    prepared.instructions.length,
    bulky.instructions.length,
    "the fee instructions are skipped rather than blowing the packet limit",
  );
  assert.ok(prepared.serializeMessage().length <= 1232 - 3 - 64);

  // A normal-sized transaction still gets the fee.
  const normal = buildTestTransaction(payer);
  assert.equal(
    prepareLegacyTransaction(normal, { blockhash: fakeBlockhash(), priorityFeeMicroLamports: 50_000 }).instructions.length,
    2,
  );
});

await testAsync("an expired blockhash is retried with a fresh one and a new signature", async () => {
  const payer = Keypair.generate();
  const tx = buildTestTransaction(payer);
  const blockhashes = [fakeBlockhash(), fakeBlockhash()];
  const { connection, state } = fakeConnection({ blockhashes, confirmFailures: 1 });

  const signature = await sendAndConfirmWithRetry(connection, tx, [payer], {
    label: "zap tx",
    retryDelayMs: 0,
    priorityFeeMicroLamports: 50_000,
    computeUnitLimit: 200_000,
    maxSendRetries: 3,
  });

  assert.equal(signature, "sig-2", "the retried broadcast is the one that confirmed");
  assert.equal(state.hashCalls, 2, "a fresh blockhash is fetched for the retry");
  assert.equal(state.broadcasts.length, 2);
  assert.equal(state.broadcasts[0].blockhash, blockhashes[0]);
  assert.equal(state.broadcasts[1].blockhash, blockhashes[1]);
  assert.notEqual(state.broadcasts[0].blockhash, state.broadcasts[1].blockhash);
  // Re-signed: the signature changed with the message.
  assert.notEqual(state.broadcasts[0].signature, state.broadcasts[1].signature);
  // Priority fee attached to EVERY broadcast.
  for (const broadcast of state.broadcasts) {
    assert.deepEqual(broadcast.computeBudget, [2, 3]);
    assert.deepEqual(broadcast.priorityFee, ["50000"]);
  }
});

await testAsync("the expiry retry is capped at 3 attempts after the first broadcast", async () => {
  const payer = Keypair.generate();
  const tx = buildTestTransaction(payer);
  const { connection, state } = fakeConnection({ confirmFailures: 99 });

  let error = null;
  try {
    await sendAndConfirmWithRetry(connection, tx, [payer], {
      label: "always expired",
      retryDelayMs: 0,
      maxSendRetries: 3,
    });
  } catch (err) {
    error = err;
  }

  assert.ok(error, "the expiry error surfaces once the retries are exhausted");
  assert.equal(isBlockhashExpiredError(error), true);
  assert.equal(state.broadcasts.length, 1 + MAX_SEND_RETRIES, "1 broadcast + 3 retries");
  assert.equal(state.hashCalls, 1 + MAX_SEND_RETRIES, "a fresh blockhash per attempt");
});

await testAsync("non-expiry failures are never retried", async () => {
  const payer = Keypair.generate();
  const tx = buildTestTransaction(payer);
  let broadcasts = 0;
  const connection = {
    async getLatestBlockhash() {
      return { blockhash: fakeBlockhash(), lastValidBlockHeight: 1 };
    },
    async sendRawTransaction() {
      broadcasts += 1;
      throw new Error("Transaction simulation failed: insufficient funds");
    },
    async confirmTransaction() {},
  };

  await assert.rejects(
    () => sendAndConfirmWithRetry(connection, tx, [payer], { label: "no funds", retryDelayMs: 0 }),
    /insufficient funds/,
  );
  assert.equal(broadcasts, 1, "a deterministic failure must fail fast");
});

await testAsync("a v0 (versioned) message is re-signed against the refreshed blockhash", async () => {
  const payer = Keypair.generate();
  const fresh = fakeBlockhash();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: fakeBlockhash(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const seen = [];

  const connection = {
    async getLatestBlockhash() {
      return { blockhash: fresh, lastValidBlockHeight: 7 };
    },
    async sendRawTransaction(raw) {
      const decoded = VersionedTransaction.deserialize(raw);
      seen.push({
        blockhash: decoded.message.recentBlockhash,
        signature: Buffer.from(decoded.signatures[0]).toString("base64"),
      });
      return "v0-signature";
    },
    async confirmTransaction() {},
  };

  const signature = await sendAndConfirmWithRetry(connection, tx, [payer], {
    label: "v0 swap",
    retryDelayMs: 0,
  });

  assert.equal(signature, "v0-signature");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].blockhash, fresh, "the freshly fetched blockhash is applied to the v0 message");
  assert.equal(tx.message.recentBlockhash, fresh);
  // The re-signature covers the refreshed message.
  if (typeof tx.verify === "function") {
    assert.equal(tx.verify([payer.publicKey]), true, "the new signature matches the new message");
  }
});

await testAsync("the Jupiter swap re-quotes, re-signs and retries an expired signature", async () => {
  const wallet = Keypair.generate();
  const buildOrder = (blockhash, requestId) => {
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([wallet]);
    return {
      transaction: Buffer.from(tx.serialize()).toString("base64"),
      requestId,
      prioritizationFeeLamports: 1_000,
    };
  };

  const firstHash = fakeBlockhash();
  const freshHash = fakeBlockhash();
  const calls = [];
  const responses = [
    { ok: true, json: async () => buildOrder(firstHash, "req-1") },
    {
      ok: false,
      status: 502,
      text: async () => "{\"error\":\"Signature expired: block height exceeded\"}",
    },
    { ok: true, json: async () => buildOrder(freshHash, "req-2") },
    {
      ok: true,
      json: async () => ({
        status: "Success",
        signature: "swap-sig",
        inputAmountResult: "100",
        outputAmountResult: "200",
      }),
    },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next;
  };

  try {
    const search = new URLSearchParams({ inputMint: "in", outputMint: "out", amount: "1", taker: "t" });
    const { order, result, attempts } = await landJupiterSwap({
      search,
      jupiterApiKey: null,
      wallet,
      connection: { getLatestBlockhash: async () => ({ blockhash: fakeBlockhash(), lastValidBlockHeight: 1 }) },
      maxRetries: 3,
    });

    assert.equal(attempts, 2, "one retry after the expired signature");
    assert.equal(order.requestId, "req-2", "the retry uses a freshly quoted order");
    assert.equal(result.signature, "swap-sig");
    assert.equal(calls.length, 4, "order → execute → order → execute");
    assert.ok(calls[0].url.includes("/order?"));
    assert.ok(calls[2].url.includes("/order?"), "the retry re-quotes with the same query");
    assert.equal(calls[0].url, calls[2].url);
    assert.equal(calls[1].body.requestId, "req-1");
    assert.equal(calls[3].body.requestId, "req-2");

    // The re-quoted transaction carries a fresh blockhash and is re-signed.
    const resign = VersionedTransaction.deserialize(Buffer.from(calls[3].body.signedTransaction, "base64"));
    assert.equal(resign.message.recentBlockhash, freshHash);
    if (typeof resign.verify === "function") {
      assert.equal(resign.verify([wallet.publicKey]), true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\n✓ ${passed} LP-menu tests passed`);

