/**
 * Interactive LP menu tests (no network, no Telegram, no transactions).
 * Run: node test/test-lp-menu.js
 */

import assert from "node:assert/strict";
import {
  DEFAULT_QUICK_TOKENS,
  NEW_POSITION_PROMPT,
  binsToDownsidePct,
  buildDashboardKeyboard,
  buildHubKeyboard,
  buildNewPositionKeyboard,
  buildQuickTokenPicks,
  buildTokenPoolsKeyboard,
  buildTrendingKeyboard,
  estimateApr,
  extractPoolAddress,
  findTokenBalance,
  formatDeployResult,
  formatMoney,
  formatSolAmount,
  formatUsd,
  getLpSession,
  isLpAddressCommandWithBadArg,
  isSolanaAddress,
  parseAmountInput,
  parseLpAddressCommand,
  parseRangeInput,
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
  renderReferralsView,
  renderTokenPools,
  renderTrendingPools,
  renderWalletView,
  tokenPoolEntries,
  toPoolEntry,
  truncateAddress,
} from "../services/lp-menu.js";
import {
  filterTrendingPools,
  normalizeStrategyKind,
  rankPoolsForToken,
  rankTrendingPools,
  scoreTrendingPool,
  strategyLabel,
  strategyLegs,
  toSdkStrategyType,
  toTokenPoolEntry,
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

console.log(`\n✓ ${passed} LP-menu tests passed`);

