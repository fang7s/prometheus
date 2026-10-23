import { getMyPositions, deployPosition } from "./dlmm.js";
import { getPoolDetail } from "./screening.js";
import { getTrackedPosition } from "../state.js";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Resolve a position's token-side weight (0..1).
 * getMyPositions does not report token_weight today, so an unknown weight is
 * returned as null and treated as "analysis allowed" rather than blocking
 * every position (the old gate made the engine unreachable).
 * @param {Object} position
 * @returns {number|null}
 */
export function resolveTokenWeight(position) {
  const raw = position?.token_weight
    ?? position?.tokenWeight
    ?? position?.token_weight_pct
    ?? position?.token_weight_percent;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value > 1 ? value / 100 : value;
}

/**
 * Check if a position qualifies for bid-ask flip analysis
 * @param {Object} position - The position to check
 * @returns {boolean} Whether this position should be analyzed for flipping
 */
export function shouldAnalyzeForFlip(position) {
  if (!position?.position || !position?.pool) return false;
  // Never act on an unpriceable tick — PnL gates cannot be trusted.
  if (position.pnl_pct == null || position.pnl_pct_suspicious) return false;

  const tokenWeight = resolveTokenWeight(position);
  if (tokenWeight == null) return true; // weight unknown — keep analyzable

  const minWeight = Number(config.flipper?.tokenWeightMin ?? 0.8);
  return tokenWeight >= minWeight && tokenWeight <= 1.0;
}

/**
 * Get volatility metrics for a pool
 * @param {string} poolAddress - Address of the pool
 * @param {string} timeframe - Timeframe for metrics
 * @returns {Promise<Object>} Pool metrics including volatility data
 */
export async function getPoolMetrics(poolAddress, timeframe = config.flipper?.timeframe ?? "1h") {
  if (!poolAddress) return null;
  try {
    const poolDetail = await getPoolDetail({ pool_address: poolAddress, timeframe });
    if (!poolDetail) throw new Error("empty pool detail");

    const volume = Number(poolDetail.volume ?? 0);
    const tvl = Number(poolDetail.active_tvl ?? poolDetail.tvl ?? 0);
    const volumeRatio = poolDetail.volume_tvl_ratio != null
      ? Number(poolDetail.volume_tvl_ratio)
      : (tvl > 0 ? volume / tvl : 0);

    return {
      volume,
      tvl,
      active_tvl: Number(poolDetail.active_tvl ?? poolDetail.tvl ?? 0),
      volume_tvl_ratio: Number.isFinite(volumeRatio) ? volumeRatio : 0,
      volatility: poolDetail.volatility != null ? Number(poolDetail.volatility) : null,
      stop_loss_limit: config.management.stopLossPct ?? -5,
      price: Number(poolDetail.pool_price ?? poolDetail.price ?? 0),
      price_change_pct: poolDetail.pool_price_change_pct != null ? Number(poolDetail.pool_price_change_pct) : null,
      min_price: poolDetail.min_price != null ? Number(poolDetail.min_price) : null,
      max_price: poolDetail.max_price != null ? Number(poolDetail.max_price) : null,
      bin_step: Number(poolDetail?.dlmm_params?.bin_step ?? poolDetail?.pool_config?.bin_step ?? 0),
      fee_tvl_ratio: Number(poolDetail.fee_active_tvl_ratio ?? poolDetail.fee_tvl_ratio ?? 0),
      swap_count: poolDetail.swap_count != null ? Number(poolDetail.swap_count) : null,
      timeframe,
    };
  } catch (error) {
    log("flipper_warn", `Failed to get pool metrics for ${poolAddress}: ${error.message}`);
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
  
  // Token-weight gate — only meaningful when the position reports a weight.
  const tokenWeight = resolveTokenWeight(position);
  const minWeight = Number(config.flipper?.tokenWeightMin ?? 0.8);
  if (tokenWeight != null && (tokenWeight < minWeight || tokenWeight > 1.0)) {
    return {
      action: "NONE",
      reason: `Position token weight ${tokenWeight.toFixed(2)} outside ${minWeight}-1.00 range`,
      success: true
    };
  }

  // Check if we've exceeded stop loss limit (this would be your dynamic stop loss from config)
  const pnlPct = Number(position.pnl_pct);
  if (Number.isFinite(pnlPct) && pnlPct <= metrics.stop_loss_limit) {
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
 * Check specific conditions that would indicate a flip opportunity.
 * A flip closes and redeploys, so it requires a live pool (volume / TVL) and
 * a position that is actually drifting: out of range, or losing beyond the
 * configured rebalance threshold.
 * @param {Object} position - The position to analyze
 * @param {Object} metrics - Pool metrics
 * @returns {Promise<boolean>} Whether conditions favor a flip
 */
async function checkFlipConditions(position, metrics) {
  const volume = Number(metrics?.volume ?? 0);
  const tvl = Number(metrics?.active_tvl ?? metrics?.tvl ?? 0);
  if (!(volume > 0) || !(tvl > 0)) return false;

  const minRatio = Number(config.flipper?.minVolumeToTvl ?? 0.01);
  const volumeRatio = metrics?.volume_tvl_ratio != null
    ? Number(metrics.volume_tvl_ratio)
    : volume / tvl;
  if (!Number.isFinite(volumeRatio) || volumeRatio < minRatio) return false;

  const outOfRange = position?.in_range === false;
  const pnlPct = Number(position?.pnl_pct);
  const minPnl = Number(config.flipper?.minPnlToRebalance ?? -8);
  const losing = Number.isFinite(pnlPct) && pnlPct <= minPnl;

  return outOfRange || losing;
}

/** Treat dry-run results and explicit success as executed. */
function isExecutionSuccess(result) {
  if (!result) return false;
  if (result.dry_run) return true;
  return result.success !== false && !result.error && !result.blocked;
}

/**
 * Close via the executor so post-effects run: Telegram notify, base→SOL
 * auto-swap, decision/action logging and safety checks.
 * The import is lazy so this module stays free of executor/telegram
 * module-load side effects for CLI and test processes.
 */
async function closeViaExecutor(position, reason) {
  try {
    const { executeTool } = await import("./executor.js");
    return await executeTool("close_position", {
      position_address: position.position,
      reason,
    });
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * A FLIP must be able to redeploy. deployPosition is read-only in LIVE mode,
 * so refuse to close unless the simulated path (DRY_RUN) or an explicit opt-in
 * for live redeploy is available — never strand capital in a bare close.
 */
function canExecuteFlip() {
  return process.env.DRY_RUN === "true" || config.flipper?.allowLiveRedeploy === true;
}

/**
 * Close the position and redeploy the same pool/strategy with the tracked
 * range. Returns a structured result for the flipper report.
 */
async function executeFlip(position, reason) {
  const tracked = getTrackedPosition(position.position);
  const binRange = tracked?.bin_range || {};

  const close = await closeViaExecutor(position, `Flipper flip: ${reason}`);

  if (!isExecutionSuccess(close)) {
    return {
      position: position.position,
      pool: position.pool,
      pair: position.pair,
      action: "FLIP",
      executed: false,
      stage: "close",
      reason: `Close failed: ${close?.error || close?.reason || "unknown"}`,
      close,
    };
  }

  const derivedBinsBelow = Number.isInteger(position.active_bin) && Number.isInteger(position.lower_bin)
    ? Math.max(1, position.active_bin - position.lower_bin)
    : undefined;
  const binsBelow = Number.isInteger(binRange.bins_below) ? binRange.bins_below : derivedBinsBelow;
  const binsAbove = Number.isInteger(binRange.bins_above) ? binRange.bins_above : 0;
  const amountSol = Number(tracked?.amount_sol ?? config.management.deployAmountSol);

  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    return {
      position: position.position,
      pool: position.pool,
      pair: position.pair,
      action: "FLIP",
      executed: false,
      stage: "redeploy",
      reason: `Invalid redeploy amount: ${tracked?.amount_sol ?? config.management.deployAmountSol}`,
      close,
    };
  }

  let deploy;
  try {
    deploy = await deployPosition({
      pool_address: position.pool,
      amount_sol: amountSol,
      amount_y: amountSol,
      amount_x: 0,
      strategy: tracked?.strategy || config.strategy.strategy,
      bins_below: binsBelow,
      bins_above: binsAbove,
      downside_pct: binRange.downside_pct,
      upside_pct: binRange.upside_pct,
      pool_name: tracked?.pool_name || position.pair,
      bin_step: tracked?.bin_step,
      volatility: tracked?.volatility,
      fee_tvl_ratio: tracked?.fee_tvl_ratio,
      organic_score: tracked?.organic_score,
    });
  } catch (error) {
    log("flipper_error", `Flip redeploy failed for ${position.pool}: ${error.message}`);
    return {
      position: position.position,
      pool: position.pool,
      pair: position.pair,
      action: "FLIP",
      executed: false,
      stage: "redeploy",
      reason: error.message,
      close,
    };
  }

  const executed = isExecutionSuccess(deploy);
  if (executed) {
    log("flipper_info", `Flipped ${position.pair || position.pool}: close + redeploy ${amountSol} SOL${deploy?.dry_run ? " (dry run)" : ""}`);
  } else {
    log("flipper_error", `Flip redeploy rejected for ${position.pool}: ${deploy?.error || "unknown"}`);
  }

  return {
    position: position.position,
    pool: position.pool,
    pair: position.pair,
    action: "FLIP",
    executed,
    stage: "complete",
    reason,
    amount_sol: amountSol,
    close,
    deploy,
  };
}

/**
 * Check all positions for flip/close opportunities and execute them.
 * @returns {Promise<Array<Object>>} Per-position decision/execution results
 */
export async function checkAllPositionsForFlip() {
  const results = [];
  if (!config.flipper?.enabled) return results;

  let positions;
  try {
    // Silent force-refresh so a flip never acts on a stale snapshot.
    positions = await getMyPositions({ force: true, silent: true });
  } catch (error) {
    log("flipper_error", `Could not load positions for flip analysis: ${error.message}`);
    return results;
  }

  const list = positions?.positions || [];
  if (list.length === 0) {
    log("flipper_info", "No positions found to analyze for flip opportunities");
    return results;
  }

  const eligible = list.filter((position) => shouldAnalyzeForFlip(position));
  log("flipper_info", `Analyzing ${eligible.length}/${list.length} position(s) for flip opportunities`);

  for (const position of eligible) {
    try {
      const metrics = await getPoolMetrics(position.pool, config.flipper?.timeframe);
      if (!metrics) {
        log("flipper_warn", `Could not get metrics for position ${position.position}`);
        results.push({
          position: position.position,
          pool: position.pool,
          pair: position.pair,
          action: "NONE",
          executed: false,
          reason: "metrics unavailable",
        });
        continue;
      }

      const decision = await evaluateFlipOpportunity(position, metrics);
      log("flipper_debug", `Flip evaluation for ${position.position}: ${decision.action} - ${decision.reason}`);

      const base = {
        position: position.position,
        pool: position.pool,
        pair: position.pair,
        action: decision.action,
        executed: false,
        reason: decision.reason,
      };

      if (!decision.success || decision.action === "NONE") {
        results.push(base);
        continue;
      }

      if (decision.action === "CLOSE") {
        const close = await closeViaExecutor(position, `Flipper close: ${decision.reason}`);
        const executed = isExecutionSuccess(close);
        results.push({ ...base, action: "CLOSE", executed, close });
        log(
          executed ? "flipper_info" : "flipper_error",
          `${executed ? "Closed" : "Close FAILED for"} ${position.pair || position.position}: ${decision.reason}`,
        );
        continue;
      }

      if (decision.action === "FLIP") {
        if (!canExecuteFlip()) {
          const reason = "flip skipped — redeploy unavailable (DRY_RUN!==true and flipperAllowLiveRedeploy=false)";
          log("flipper_warn", `${position.pair || position.position}: ${reason}`);
          results.push({ ...base, executed: false, reason });
          continue;
        }
        results.push(await executeFlip(position, decision.reason));
      }
    } catch (error) {
      log("flipper_error", `Error evaluating position ${position.position} for flip: ${error.message}`);
      results.push({
        position: position.position,
        pool: position.pool,
        pair: position.pair,
        action: "ERROR",
        executed: false,
        reason: error.message,
      });
    }
  }

  const executed = results.filter((entry) => entry.executed).length;
  log("flipper_info", `Flip analysis complete: ${results.length} evaluated, ${executed} executed`);
  return results;
}