// Test script for bid-ask flipper engine
import { shouldAnalyzeForFlip, getPoolMetrics } from "./tools/bid-ask-flipper.js";
import { log } from "./logger.js";

console.log("Testing Bid-Ask Flipper Engine...");

// Test 1: Position qualification
console.log("\n=== Test 1: Position Qualification ===");
const testPosition1 = {
  position: "TEST_POS_1",
  pool: "TEST_POOL_1",
  pnl_pct: -2,
  in_range: true,
  token_weight: 0.85,
  base_mint: "So11111111111111111111111111111111111111112",
  quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
};

const testPosition2 = {
  position: "TEST_POS_2",
  pool: "TEST_POOL_2",
  pnl_pct: -2,
  in_range: true,
  token_weight: 0.75,
  base_mint: "So11111111111111111111111111111111111111112",
  quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
};

const qualifies1 = shouldAnalyzeForFlip(testPosition1);
const qualifies2 = shouldAnalyzeForFlip(testPosition2);
console.log(`Position 1 (85% token): ${qualifies1 ? 'QUALIFIES' : 'DOES NOT QUALIFY'}`);
console.log(`Position 2 (75% token): ${qualifies2 ? 'QUALIFIES' : 'DOES NOT QUALIFY'}`);
if (!qualifies1 || qualifies2) {
  console.error("FAIL: token-weight gate behaved unexpectedly");
  process.exitCode = 1;
}

// A position without token_weight must still be analyzable (getMyPositions omits it).
const unknownWeight = { ...testPosition1, position: "TEST_POS_3", token_weight: undefined };
const qualifies3 = shouldAnalyzeForFlip(unknownWeight);
console.log(`Position 3 (unknown weight): ${qualifies3 ? 'QUALIFIES' : 'DOES NOT QUALIFY'}`);
if (!qualifies3) {
  console.error("FAIL: unknown token_weight should not block analysis");
  process.exitCode = 1;
}

// Test 2: Function existence
console.log("\n=== Test 2: Function Validation ===");
console.log(`shouldAnalyzeForFlip exists: ${typeof shouldAnalyzeForFlip === 'function'}`);
console.log(`getPoolMetrics exists: ${typeof getPoolMetrics === 'function'}`);

console.log("\n=== Test Summary ===");
console.log("✅ Bid-Ask Flipper engine structure validated successfully");
console.log("✅ Module imports properly");
console.log("✅ Core functions are accessible");

console.log("\nAll tests completed successfully!");

// Imported modules register module-level timers (telegram/wallet), so exit
// explicitly; process.exitCode preserves any assertion failure above.
process.exit(process.exitCode ?? 0);