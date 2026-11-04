/**
 * Hot Fees screener tests — strict fee-tier + bin-step gate (no network, no
 * Telegram, no transactions).
 *
 * Run: node test/test-screener.js
 *
 * Covers the pure row pipeline only: `normalizeHotPool()` (row → digest entry)
 * and `passesFeeTierGate()` / `passesDigestFloors()` (the strict gate). Network,
 * cache and rendering behaviour is exercised elsewhere.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_MAX_BIN_STEP,
  DEFAULT_MIN_BASE_FEE_PCT,
  DEFAULT_MIN_BIN_STEP,
  HARD_MIN_BASE_FEE_PCT,
  buildHotFeedFilter,
  getScreenerSettings,
  normalizeHotPool,
  passesDigestFloors,
  passesFeeTierGate,
} from "../services/screenerService.js";

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** A normalized-entry factory — only the fields the gate looks at matter. */
function pool(overrides = {}) {
  return {
    pool: "3uijTWAzhQKnqZ59Wwgay7sccFWAk5reEibKg2ZRAGZ9",
    name: "AMD-SOL",
    pair: "AMD-SOL",
    feePct: 0.3,
    binStep: 100,
    tvl: 61_968,
    activeTvl: 58_803,
    volumeWindowUsd: 1_835_050,
    feeWindowUsd: 33_334,
    feeTvlPct: 53.65,
    aprPct: 19_582.25,
    mcap: 558_573,
    ...overrides,
  };
}

/** A discovery-API row factory matching the live payload shape. */
function row(overrides = {}) {
  return {
    pool_address: "3uijTWAzhQKnqZ59Wwgay7sccFWAk5reEibKg2ZRAGZ9",
    name: "AMD-SOL",
    token_x: { address: "DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump", symbol: "AMD", market_cap: 558_573, holders: 5691 },
    token_y: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", market_cap: 56_288_161_174 },
    pool_type: "dlmm",
    fee_pct: 1,
    pool_created_at: Date.now() - 5 * 3600_000,
    tvl: 61_968,
    active_tvl: 58_803,
    fee: 33_334,
    volume: 1_835_050,
    fee_tvl_ratio: 53.65,
    dlmm_params: { bin_step: 100, collect_fee_mode: "both" },
    ...overrides,
  };
}

console.log("=== Strict gate constants ===");

test("the hard fee floor is 0.25 % and the defaults are 80 / 125 / 0.30", () => {
  assert.equal(HARD_MIN_BASE_FEE_PCT, 0.25);
  assert.equal(DEFAULT_MIN_BIN_STEP, 80);
  assert.equal(DEFAULT_MAX_BIN_STEP, 125);
  assert.equal(DEFAULT_MIN_BASE_FEE_PCT, 0.3);
});

console.log("\n=== normalizeHotPool() ===");

test("maps the live discovery-API row into a digest entry", () => {
  const p = normalizeHotPool(row(), { timeframeHours: 24 });
  assert.ok(p, "a row with a pool address must normalize");
  assert.equal(p.pool, "3uijTWAzhQKnqZ59Wwgay7sccFWAk5reEibKg2ZRAGZ9");
  assert.equal(p.name, "AMD-SOL");
  assert.equal(p.pair, "AMD-SOL");
  assert.equal(p.baseMint, "DDmGnuvroxVrb7CSyjYcezFU8gnAfhKasg4ZZezmpump");
  assert.equal(p.quoteIsSol, true);
  assert.equal(p.tvl, 61_968);
  assert.equal(p.feeWindowUsd, 33_334);
  assert.equal(p.volumeWindowUsd, 1_835_050);
  assert.equal(p.feeTvlPct, 53.65);
  assert.equal(p.aprPct, 19_582.25);
  assert.equal(p.mcap, 558_573);
  assert.equal(p.feePct, 1);
  assert.equal(p.binStep, 100);
});

test("exposes the fee tier and bin step the strict gate needs", () => {
  assert.equal(normalizeHotPool(row({ fee_pct: 0.25 })).feePct, 0.25);
  assert.equal(normalizeHotPool(row({ dlmm_params: { bin_step: 80 } })).binStep, 80);
  assert.equal(normalizeHotPool(row({ dlmm_params: null, bin_step: 125 })).binStep, 125);
  assert.equal(normalizeHotPool(row({ fee_pct: null, base_fee_pct: 0.3 })).feePct, 0.3);
});

test("drops rows without a pool address", () => {
  assert.equal(normalizeHotPool({}), null);
  assert.equal(normalizeHotPool(null), null);
  assert.equal(normalizeHotPool(row({ pool_address: "  " })), null);
});

console.log("\n=== passesFeeTierGate(): fee tiers ===");

test("excludes every tier at or below 0.25 %", () => {
  for (const feePct of [0.01, 0.05, 0.1, 0.25]) {
    assert.equal(passesFeeTierGate(pool({ feePct })), false, `${feePct}% must be excluded`);
  }
});

test("allows the 0.30 %+ tiers", () => {
  for (const feePct of [0.3, 0.4, 0.5, 1, 2]) {
    assert.equal(passesFeeTierGate(pool({ feePct })), true, `${feePct}% must be allowed`);
  }
});

test("0.26-0.29 % clears the 0.25 % floor but fails the default 0.30 % floor", () => {
  for (const feePct of [0.26, 0.28, 0.29]) {
    assert.equal(passesFeeTierGate(pool({ feePct })), false, `${feePct}% must fail the 0.30 % default`);
    assert.equal(passesFeeTierGate(pool({ feePct }), { minBaseFeePct: 0.26 }), true);
  }
});

test("a configured floor below 0.25 % cannot loosen the hard floor", () => {
  assert.equal(passesFeeTierGate(pool({ feePct: 0.25 }), { minBaseFeePct: 0.1 }), false);
  assert.equal(passesFeeTierGate(pool({ feePct: 0.1 }), { minBaseFeePct: 0.1 }), false);
});

test("a higher configured floor tightens the gate", () => {
  assert.equal(passesFeeTierGate(pool({ feePct: 0.3 }), { minBaseFeePct: 0.5 }), false);
  assert.equal(passesFeeTierGate(pool({ feePct: 0.5 }), { minBaseFeePct: 0.5 }), true);
});

test("a missing fee tier is dropped (strict)", () => {
  assert.equal(passesFeeTierGate(pool({ feePct: null })), false);
  assert.equal(passesFeeTierGate(pool({ feePct: undefined })), false);
});

console.log("\n=== passesFeeTierGate(): bin steps ===");

test("allows bin_step 80 and 125 (band edges)", () => {
  assert.equal(passesFeeTierGate(pool({ binStep: 80 })), true);
  assert.equal(passesFeeTierGate(pool({ binStep: 125 })), true);
});

test("excludes bin_step below 80", () => {
  for (const binStep of [1, 10, 25, 50, 79]) {
    assert.equal(passesFeeTierGate(pool({ binStep })), false, `bin_step ${binStep} must be excluded`);
  }
});

test("excludes bin_step above 125", () => {
  for (const binStep of [126, 200, 400, 1000]) {
    assert.equal(passesFeeTierGate(pool({ binStep })), false, `bin_step ${binStep} must be excluded`);
  }
});

test("a missing bin step is dropped (strict)", () => {
  assert.equal(passesFeeTierGate(pool({ binStep: null })), false);
  assert.equal(passesFeeTierGate(pool({ binStep: undefined })), false);
});

test("custom bounds are honoured", () => {
  const tight = { minBinStep: 90, maxBinStep: 110 };
  assert.equal(passesFeeTierGate(pool({ binStep: 80 }), tight), false);
  assert.equal(passesFeeTierGate(pool({ binStep: 90 }), tight), true);
  assert.equal(passesFeeTierGate(pool({ binStep: 110 }), tight), true);
  assert.equal(passesFeeTierGate(pool({ binStep: 111 }), tight), false);
});

test("an inverted band collapses instead of allowing everything", () => {
  const inverted = { minBinStep: 125, maxBinStep: 80 };
  assert.equal(passesFeeTierGate(pool({ binStep: 100 }), inverted), false);
  assert.equal(passesFeeTierGate(pool({ binStep: 125 }), inverted), true);
});

console.log("\n=== passesDigestFloors(): gate + liquidity floors ===");

/**
 * Explicit floors — kept as a literal instead of `getScreenerSettings()` so the
 * assertions never depend on the operator's `user-config.json` overrides.
 */
const FLOORS = {
  minTvl: 20_000,
  maxTvl: null,
  minVolume24h: 25_000,
  minFee24hUsd: 100,
  minFeeTvlPct: 0.5,
  minBinStep: 80,
  maxBinStep: 125,
  minBaseFeePct: 0.3,
};

test("a pool that clears every floor passes", () => {
  assert.equal(passesDigestFloors(pool(), FLOORS), true);
});

test("a low-fee pool is dropped even with a huge fee/TVL ratio", () => {
  // The tier gate runs *before* the liquidity floors, so an eye-catching ratio
  // cannot rescue a 0.25 % / 0.10 % pool.
  assert.equal(passesDigestFloors(pool({ feePct: 0.25, feeTvlPct: 900 }), FLOORS), false);
  assert.equal(passesDigestFloors(pool({ feePct: 0.1, feeTvlPct: 900 }), FLOORS), false);
  assert.equal(passesDigestFloors(pool({ feePct: 0.05, feeTvlPct: 900 }), FLOORS), false);
});

test("out-of-band bin steps are dropped", () => {
  assert.equal(passesDigestFloors(pool({ binStep: 79 }), FLOORS), false);
  assert.equal(passesDigestFloors(pool({ binStep: 126 }), FLOORS), false);
  assert.equal(passesDigestFloors(pool({ binStep: 80 }), FLOORS), true);
  assert.equal(passesDigestFloors(pool({ binStep: 125 }), FLOORS), true);
});

test("the existing TVL / volume / fee / ratio floors still apply", () => {
  assert.equal(passesDigestFloors(pool({ tvl: 100, activeTvl: null }), FLOORS), false);
  assert.equal(passesDigestFloors(pool({ volumeWindowUsd: 10 }), FLOORS), false);
  assert.equal(passesDigestFloors(pool({ feeWindowUsd: 5 }), FLOORS), false);
  assert.equal(passesDigestFloors(pool({ feeTvlPct: 0.01 }), FLOORS), false);
});

test("active TVL is used when TVL is absent", () => {
  const noTvl = pool({ tvl: null, activeTvl: 61_968 });
  assert.equal(passesDigestFloors(noTvl, FLOORS), true);
  const noLiquidity = pool({ tvl: null, activeTvl: null });
  assert.equal(passesDigestFloors(noLiquidity, FLOORS), false);
});

test("max TVL still excludes an oversized pool", () => {
  assert.equal(passesDigestFloors(pool({ tvl: 5_000_000 }), { ...FLOORS, maxTvl: 1_000_000 }), false);
  assert.equal(passesDigestFloors(pool({ tvl: 900_000 }), { ...FLOORS, maxTvl: 1_000_000 }), true);
});

test("pools without an address never pass", () => {
  assert.equal(passesDigestFloors(pool({ pool: "" })), false);
  assert.equal(passesDigestFloors(null), false);
});

console.log("\n=== Server-side filter expression ===");

test("pushes the strict tier + bin-step gate into filter_by", () => {
  const filter = buildHotFeedFilter({
    minTvl: 20_000,
    minVolume24h: 25_000,
    minFee24hUsd: 100,
    minFeeTvlPct: 0.5,
  });
  assert.match(filter, /^pool_type=dlmm&&is_blacklisted=false/);
  assert.match(filter, /fee_pct>0\.25/, "the hard 0.25 % tier floor is pushed down");
  assert.match(filter, /bin_step>=80/);
  assert.match(filter, /bin_step<=125/);
});

test("uses the configured bin-step band", () => {
  const filter = buildHotFeedFilter({ minBinStep: 90, maxBinStep: 110 });
  assert.match(filter, /bin_step>=90/);
  assert.match(filter, /bin_step<=110/);
});

console.log("\n=== Settings resolution ===");

test("getScreenerSettings exposes the strict gate bounds", () => {
  const settings = getScreenerSettings();
  assert.equal(typeof settings.minBinStep, "number");
  assert.equal(typeof settings.maxBinStep, "number");
  assert.equal(typeof settings.minBaseFeePct, "number");
  assert.ok(settings.maxBinStep >= settings.minBinStep, "the band must not be inverted");
  assert.ok(settings.minBaseFeePct >= 0);
});

console.log(`\n✓ ${passed} screener tests passed\n`);
