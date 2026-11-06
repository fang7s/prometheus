/**
 * Shared per-position actions for the LP menu and the automatic exit path.
 *
 * Meteora DLMM positions cannot be re-binned in place, so ⚖️ **Rebalance** is a
 * close → redeploy around the live active bin that keeps the position's OWN
 * parameters:
 *
 *   - strategy / bin width come from the tracked deploy record,
 *   - the deposit size comes from `amount_sol` on that record,
 *   - slippage comes from the position config (`slippageBps / 100`),
 *   - the fresh position inherits the same TP/SL/slippage/auto-rebalance config,
 *     so a rebalanced pool keeps its independent settings.
 *
 * Everything here is lazy-imported by callers (LP menu button, auto-rebalance on
 * Priority 2 range-out) so rendering a Telegram card never pulls the SDK in.
 */

import { MIN_SAFE_BINS_BELOW, config } from "../config.js";
import { log } from "../logger.js";
import { getPositionConfig, getTrackedPosition, recordRebalance } from "../state.js";

const BIN_STEP_DENOMINATOR = 10_000;

/** Smallest bin width the deploy path accepts (bin-array safety floor). */
function minimumBinsBelow() {
  const configured = Number(config.strategy?.minBinsBelow ?? MIN_SAFE_BINS_BELOW);
  const floor = Number.isFinite(configured) ? configured : MIN_SAFE_BINS_BELOW;
  return Math.max(MIN_SAFE_BINS_BELOW, Math.round(floor));
}

/** Bin count → equivalent price delta % for a pool's bin step. */
export function binCountToPct(bins, binStep, direction = "down") {
  const count = Number(bins);
  const step = Number(binStep);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  const ratio = 1 + step / BIN_STEP_DENOMINATOR;
  const pct = direction === "up"
    ? (Math.pow(ratio, count) - 1) * 100
    : (1 - Math.pow(ratio, -count)) * 100;
  return Number(pct.toFixed(2));
}

/**
 * Range geometry of the position being rebalanced, expressed as the
 * `downsidePct` / `upsidePct` numbers `openDlmmPosition()` expects.
 *
 * The width is taken from the tracked deploy record (`bin_range.bins_below` /
 * `bin_range.bins_above`, falling back to the min/max bins around the deploy
 * active bin). Records that predate bin tracking fall back to the configured
 * default width, and a single-sided SOL position keeps `upsidePct = 0`.
 *
 * @param {object|null} tracked - state.json position record
 * @param {{activeBinId?: number|null}} [options]
 * @returns {{binsBelow:number, binsAbove:number, downsidePct:number|null,
 *            upsidePct:number|null, upperPct:number|null, belowOnly:boolean,
 *            binStep:number|null}}
 */
export function resolveRebalanceRange(tracked = null, { activeBinId = null } = {}) {
  const range = tracked?.bin_range && typeof tracked.bin_range === "object" ? tracked.bin_range : {};
  const binStepRaw = Number(tracked?.bin_step);
  const binStep = Number.isFinite(binStepRaw) && binStepRaw > 0 ? binStepRaw : null;
  const anchor = Number(tracked?.active_bin_at_deploy ?? range.active ?? activeBinId);

  let binsBelow = Number(range.bins_below);
  if (!Number.isFinite(binsBelow)) {
    const min = Number(range.min);
    binsBelow = Number.isFinite(min) && Number.isFinite(anchor) ? Math.abs(anchor - min) : NaN;
  }
  let binsAbove = Number(range.bins_above);
  if (!Number.isFinite(binsAbove)) {
    const max = Number(range.max);
    binsAbove = Number.isFinite(max) && Number.isFinite(anchor) ? Math.max(0, max - anchor) : 0;
  }

  const fallbackBins = minimumBinsBelow();
  const resolvedBelow = Number.isFinite(binsBelow) && binsBelow > 0 ? Math.round(binsBelow) : fallbackBins;
  const resolvedAbove = Number.isFinite(binsAbove) && binsAbove > 0 ? Math.round(binsAbove) : 0;
  const below = Math.max(resolvedBelow, fallbackBins);
  const above = Math.max(0, resolvedAbove);

  // A range whose upper bound sits BELOW the deploy active bin was a below-price
  // limit order ("-80 -20"). Keep that shape: express the upper bound as a
  // negative % so `computeBinRange()` stays in below-only mode.
  const maxBin = Number(range.max);
  const belowOnly = binStep != null
    && Number.isFinite(maxBin)
    && Number.isFinite(anchor)
    && maxBin < anchor;
  const upperPct = belowOnly ? -binCountToPct(anchor - maxBin, binStep, "down") : null;

  // Without a bin step the % deltas are unknown — the deploy path then resolves
  // the range from the explicit bin counts instead.
  if (!binStep) {
    return {
      binsBelow: below, binsAbove: above, downsidePct: null, upsidePct: null,
      upperPct: null, belowOnly: false, binStep: null,
    };
  }

  return {
    binsBelow: below,
    binsAbove: belowOnly ? 0 : above,
    downsidePct: binCountToPct(below, binStep, "down"),
    upsidePct: belowOnly ? 0 : binCountToPct(above, binStep, "up"),
    upperPct: upperPct == null ? null : Number(upperPct.toFixed(2)),
    belowOnly,
    binStep,
  };
}

/**
 * ⚖️ Rebalance ONE position: close it, swap the proceeds back to SOL (the
 * executor's close post-effect) and reopen the same size around the live active
 * bin with the position's own strategy, slippage and TP/SL config.
 *
 * In DRY_RUN nothing is signed: the close reports a dry run and the deploy
 * returns the simulated range, so the operator can preview the adjustment.
 *
 * @param {object} params
 * @param {string} params.position_address       position account to rebalance
 * @param {object} [params.position]             live `getMyPositions()` entry (optional)
 * @param {string} [params.reason]               human reason for the close/decision log
 * @param {boolean} [params.redeploy]            false = close only (no redeploy)
 * @returns {Promise<object>} summary; `success:false` carries `error`
 */
export async function rebalancePosition({
  position_address,
  position = null,
  reason = "Manual rebalance",
  redeploy = true,
} = {}) {
  const address = String(position_address || "").trim();
  if (!address) return { success: false, error: "rebalancePosition: position_address is required." };

  const tracked = getTrackedPosition(address);
  if (!tracked) return { success: false, error: "Position is not tracked — refresh the positions list." };
  if (tracked.closed) return { success: false, error: "Position is already closed." };

  const poolAddress = tracked.pool || position?.pool || null;
  if (!poolAddress) return { success: false, error: "Pool address is unknown for this position." };

  const amountSol = Number(tracked.amount_sol ?? 0);
  if (!(amountSol > 0)) return { success: false, error: "Tracked deposit amount is unknown — cannot redeploy." };

  const positionConfig = getPositionConfig(address);

  // Lazy imports: keeps this module out of the render path and avoids a heavy
  // SDK/Telegram graph for callers that only need the range helpers.
  const { executeTool } = await import("../tools/executor.js");
  const { getPoolSnapshot, openDlmmPosition } = await import("./meteoraService.js");

  let snapshot = null;
  try {
    snapshot = await getPoolSnapshot(poolAddress);
  } catch (error) {
    return { success: false, error: `Pool read failed: ${error.message}` };
  }

  const activeBinId = snapshot?.activeBinId ?? position?.active_bin ?? null;
  const range = resolveRebalanceRange(tracked, { activeBinId });
  log(
    "rebalance",
    `Rebalancing ${address} (${tracked.pool_name || poolAddress}): close then ${amountSol} SOL ` +
    `${tracked.strategy || "bid_ask"} around active bin ${activeBinId ?? "?"}`,
  );

  const closeResult = await executeTool("close_position", {
    position_address: address,
    reason: `Rebalance: ${reason}`,
  }).catch((error) => ({ error: error.message }));

  const closeOk = closeResult?.success !== false && !closeResult?.error && !closeResult?.blocked;
  if (!closeOk) {
    const error = closeResult?.error || closeResult?.reason || "Close failed";
    log("rebalance_warn", `Rebalance close failed for ${address}: ${error}`);
    return { success: false, error, close: closeResult, range };
  }

  const dryRun = closeResult?.dry_run === true;
  const closed = !dryRun;

  if (!redeploy) {
    recordRebalance(address, { reason, new_position: null });
    return { success: true, position: address, pool: poolAddress, closed, redeployed: false, close: closeResult, range };
  }

  let deployResult = null;
  try {
    // The deploy service is called directly (not through `executeTool`), exactly
    // like the LP menu's own deploy flow: the pool was validated when the
    // position first opened, and the "one position per token" guard would
    // otherwise reject the redeploy into the very same pool.
    deployResult = await openDlmmPosition({
      poolAddress,
      poolName: tracked.pool_name || null,
      strategy: tracked.strategy || config.strategy?.strategy || "bid_ask",
      amountSol,
      // Explicit bin counts keep the exact width of the original range (a % →
      // bin round-trip could shave a bin off the safety floor).
      downsidePct: 0,
      upsidePct: 0,
      upperPct: range.belowOnly ? range.upperPct : null,
      binsBelow: range.binsBelow,
      binsAbove: range.belowOnly ? null : range.binsAbove,
      slippagePct: positionConfig.slippageBps / 100,
      dryRun,
      track: closed,
      meta: {
        fee_tvl_ratio: tracked.fee_tvl_ratio ?? null,
        organic_score: tracked.organic_score ?? null,
        initial_value_usd: tracked.initial_value_usd ?? null,
        volatility: tracked.volatility ?? null,
      },
      // Inherit the position's independent settings so TP/SL, slippage and the
      // auto-rebalance flag survive the range adjustment.
      config: positionConfig,
      source: "REBALANCE",
    });
  } catch (error) {
    recordRebalance(address, { reason, new_position: null });
    log("rebalance_warn", `Rebalance redeploy failed for ${address}: ${error.message}`);
    return { success: false, error: `Redeploy failed: ${error.message}`, closed, close: closeResult, range };
  }

  const newPosition = deployResult?.positions?.[0]?.position
    ?? deployResult?.position
    ?? null;
  recordRebalance(address, { reason, new_position: newPosition });

  return {
    success: true,
    position: address,
    new_position: newPosition,
    pool: poolAddress,
    pool_name: tracked.pool_name || null,
    closed,
    redeployed: Boolean(newPosition),
    dry_run: deployResult?.dry_run === true,
    amount_sol: amountSol,
    range,
    close: closeResult,
    deploy: deployResult,
  };
}


