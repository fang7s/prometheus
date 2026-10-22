import { getActiveBin, getMyPositions, closePosition, deployPosition } from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Check if a position qualifies for bid-ask flip analysis
 * @param {Object} position - The position to check
 * @returns {boolean} Whether this position should be analyzed for flipping
 */
export function shouldAnalyzeForFlip(position) {
  // Only analyze positions where token composition is 80%-100% Token-side
  if (!position?.token_weight || !position?.base_mint || !position?.quote_mint) {
    return false;
  }
  
  // Check if it's predominantly token-side (80%-100%)
  // This is a simplified check - actual implementation would need to calculate the weight properly
  return position.token_weight >= 0.8 && position.token_weight <= 1.0;
}

/**
 * Get volatility metrics for a pool 
 * @param {string} poolAddress - Address of the pool
 * @param {string} timeframe - Timeframe for metrics
 * @returns {Promise<Object>} Pool metrics including volatility data
 */
export async function getPoolMetrics(poolAddress, timeframe = "1h") {
  try {
    const poolDetail = await getPoolDetail({ 
      pool_address: poolAddress, 
      timeframe: timeframe 
    });
    
    // Extract required metrics for decision making
    return {
      volume: poolDetail?.volume_window || 0,
      tvl: poolDetail?.active_tvl || poolDetail?.tvl || 0,
      bb_width: poolDetail?.bb_width || 0,
      ohlcv: poolDetail?.ohlcv || null,
      stop_loss_limit: config.management.stopLossPct || -5, // Default stop loss from config
      price: poolDetail?.price || 0,
      active_bin: poolDetail?.active_bin || null,
      bin_step: poolDetail?.dlmm_params?.bin_step || poolDetail?.pool_config?.bin_step || 0,
      fee_tvl_ratio: poolDetail?.fee_active_tvl_ratio || poolDetail?.fee_tvl_ratio || 0
    };
  } catch (error) {
    log("flipper_error", `Failed to get pool metrics for ${poolAddress}: ${error.message}`);
    return null;
  }
}

/**
 * Determine whether to flip or close a position based on current metrics
 * @param {Object} position - The position to evaluate
 * @param {Object} metrics - Pool metrics
 * @returns {Promise<Object>} Decision with action and reasoning
 */
export async function evaluateFlipOpportunity(position, metrics) {
  // Basic validation
  if (!position || !metrics) {
    return {
      action: "NONE",
      reason: "Invalid position or metrics data",
      success: false
    };
  }
  
  // If position token weight is not in 80-100% range, don't flip
  if (position.token_weight < 0.8 || position.token_weight > 1.0) {
    return {
      action: "NONE",
      reason: "Position token weight not in 80%-100% range",
      success: true
    };
  }

  // Check if we've exceeded stop loss limit (this would be your dynamic stop loss from config)
  if (position.pnl_pct <= metrics.stop_loss_limit) {
    return {
      action: "CLOSE",
      reason: `Exceeded stop loss limit (${metrics.stop_loss_limit}%)`,
      success: true
    };
  }

  // Analyze price action - this is where you'd use more sophisticated time-series analysis
  // For now, simplified approach bases decision on volatility and price movement
  
  const shouldFlip = await checkFlipConditions(position, metrics);
  
  return {
    action: shouldFlip ? "FLIP" : "NONE",
    reason: shouldFlip ? "Price action and market conditions favor flip" : "Market conditions don't support flip",
    success: true
  };
}

/**
 * Check specific conditions that would indicate a flip opportunity
 * @param {Object} position - The position to analyze
 * @param {Object} metrics - Pool metrics
 * @returns {Promise<boolean>} Whether conditions favor a flip
 */
async function checkFlipConditions(position, metrics) {
  // Simplified approach for the example:
  // In a real implementation this would include:
  // - Price volatility analysis
  // - Volume trends  
  // - 15m OHLCV pattern recognition
  // - Comparative analysis with historical data
  // - Relative strength vs other pools
  // For now, using basic criteria

  // Need to check for 15m OHLCV data which is needed for when to flip
  if (!metrics?.ohlcv || !Array.isArray(metrics.ohlcv) || metrics.ohlcv.length < 5) {
    return false; // Not enough data to make decision
  }
  
  // Evaluate price movement and volume
  const currentVolume = metrics.volume;
  const currentTVL = metrics.tvl;
  const bbWidth = metrics.bb_width;
  
  // Simple weighted scoring (this would be more sophisticated in real implementation)
  // Criteria:
  // - Sufficient volume relative to TVL
  // - Liquidity pool is active (not stagnant)
  // - Volatility isn't too high (avoid whipsaw)
  
  if (currentVolume <= 0 || currentTVL <= 0) {
    return false;
  }
  
  // Strong liquidity with decent volume
  const volumeRatio = currentVolume / currentTVL;
  if (volumeRatio < 0.01) { // Less than 1% volume to TVL ratio
    return false;
  }
  
  return true;
}