/**
 * Position monitor — per-tick range-entry bookkeeping for open positions.
 *
 * Why this exists:
 *   A limit order deployed *below the price* (both bounds under the active bin)
 *   is created fully out of range: 100 % SOL waiting for price to drop into the
 *   range. Priority 2 (`FAR_ABOVE_RANGE` / `FAR_BELOW_RANGE`) would otherwise
 *   close it on the very first tick, cancelling the order before it ever filled.
 *
 *   Every position therefore carries a persisted `hasEnteredRange` flag
 *   (`has_entered_range` in state.json, `false` on deploy). Each monitoring tick
 *   flips it to `true` the first time `activeBinId` sits inside
 *   `[minBinId, maxBinId]`. `exit-rules.js` refuses Priority 2 range exits while
 *   the flag is `false`.
 *
 * Layers:
 *   - Pure helpers (`resolveBinRange`, `isActiveBinInRange`, `getHasEnteredRange`,
 *     `evaluateRangeEntry`) — no I/O, safe to call from anywhere.
 *   - `monitorPosition` / `monitorOpenPositions` — the tick entry points; they
 *     persist the one-way `false → true` transition through state.js.
 */

import { log } from "../logger.js";
import { getTrackedPosition, markRangeEntered } from "../state.js";

/** The only two meaningful states of the range-entry flag. */
export const RANGE_ENTRY_STATE = Object.freeze({
  PENDING: false, // limit order has not filled yet — Priority 2 is bypassed
  ENTERED: true, // price has traded inside the range at least once
});

function toBin(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bin geometry of a `getMyPositions()` entry, falling back to the tracked state
 * record (`bin_range: { min, max, active }`) when the snapshot omits bins.
 *
 * @returns {{lowerBinId: number|null, upperBinId: number|null, activeBinId: number|null}}
 */
export function resolveBinRange(position = {}, tracked = null) {
  const range = tracked?.bin_range && typeof tracked.bin_range === "object" ? tracked.bin_range : {};
  return {
    lowerBinId: toBin(position?.lower_bin ?? position?.lowerBinId ?? range.min),
    upperBinId: toBin(position?.upper_bin ?? position?.upperBinId ?? range.max),
    activeBinId: toBin(position?.active_bin ?? position?.activeBinId ?? range.active),
  };
}

/**
 * True when the live active bin sits inside the position's bounds (inclusive).
 * Returns `null` when neither bin geometry nor the snapshot's `in_range` flag is
 * available, so the caller can leave the persisted flag untouched.
 */
export function isActiveBinInRange(position = {}, tracked = null) {
  const { lowerBinId, upperBinId, activeBinId } = resolveBinRange(position, tracked);
  if (lowerBinId == null || upperBinId == null || activeBinId == null) {
    // Data-gap fallback: some snapshots only report `in_range`.
    if (position?.in_range === true) return true;
    if (position?.in_range === false) return false;
    return null;
  }
  const min = Math.min(lowerBinId, upperBinId);
  const max = Math.max(lowerBinId, upperBinId);
  return activeBinId >= min && activeBinId <= max;
}

/**
 * Persisted `hasEnteredRange` value for a position.
 * Accepts the camelCase form (live payloads) and the snake_case form (state.json)
 * and defaults to `false` — a position that never proved it traded in range
 * keeps Priority 2 bypassed.
 */
export function getHasEnteredRange(position = {}, tracked = null) {
  const direct = position?.hasEnteredRange ?? position?.has_entered_range;
  if (typeof direct === "boolean") return direct;
  const persisted = tracked?.hasEnteredRange ?? tracked?.has_entered_range;
  if (typeof persisted === "boolean") return persisted;
  return false;
}

/**
 * Pure evaluation of one monitoring tick — never writes state.
 *
 * @returns {{inRange: boolean|null, hasEnteredRange: boolean, flipped: boolean}}
 *   `flipped` is true only on the `false → true` transition.
 */
export function evaluateRangeEntry(position = {}, tracked = null) {
  const inRange = isActiveBinInRange(position, tracked);
  const before = getHasEnteredRange(position, tracked);
  const hasEnteredRange = before || inRange === true;
  return { inRange, hasEnteredRange, flipped: hasEnteredRange && !before };
}

/**
 * Monitoring tick for a single position: flips + persists `hasEnteredRange`
 * once the price has traded inside the range at least once.
 *
 * One-way transition — a position that leaves the range keeps the flag. Safe to
 * call on every poll tick: state is only written on the transition itself.
 */
export function monitorPosition(position = {}, { tracked = null, persist = true, at = Date.now() } = {}) {
  const address = position?.position ?? tracked?.position ?? null;
  if (!address) {
    const entry = evaluateRangeEntry(position, tracked);
    return { ...entry, position: null, persisted: false };
  }
  const record = tracked ?? getTrackedPosition(address);
  const entry = evaluateRangeEntry(position, record);
  if (!entry.flipped || !persist) {
    return { ...entry, position: address, persisted: false };
  }
  const persisted = markRangeEntered(address, at);
  if (persisted) {
    log("state", `Position ${address} entered its range — Priority 2 range exits armed (hasEnteredRange=true)`);
  }
  return { ...entry, position: address, persisted };
}

/**
 * Monitoring tick for a whole positions snapshot (the fast PnL poller and the
 * management cycle both call this once per tick).
 *
 * @returns {{checked: number, flipped: number, armed: number, pending: number, results: object[]}}
 */
export function monitorOpenPositions(positions = [], options = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const results = list.map((position) => monitorPosition(position, options));
  return {
    checked: results.length,
    flipped: results.filter((result) => result.flipped).length,
    armed: results.filter((result) => result.hasEnteredRange).length,
    pending: results.filter((result) => !result.hasEnteredRange).length,
    results,
  };
}
