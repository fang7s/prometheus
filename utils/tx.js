/**
 * Solana transaction sending: blockhash-expiry retries + priority fees.
 *
 * Why this module exists
 * ----------------------
 * A transaction signed against a stale blockhash dies with
 * `TransactionExpiredBlockheightExceededError` / "Signature … expired: block
 * height exceeded" (or the RPC's `Blockhash not found` / `-32002`). Before this
 * helper every caller used the SDK's `sendAndConfirmTransaction`, so a single
 * slow second cost the whole operation — most visibly the SOL → token zap right
 * before a DLMM deploy and the claim/close legs of an exit.
 *
 * {@link sendAndConfirmWithRetry} wraps the whole cycle:
 *
 *   1. fetch a FRESH recent blockhash (`getLatestBlockhash`),
 *   2. attach the configured ComputeBudget priority fee (micro-lamports/CU),
 *   3. sign, broadcast (`sendRawTransaction`) and confirm,
 *   4. on an expired blockhash/blockheight → go back to 1 and retry, up to
 *      `config.tx.maxSendRetries` (hard-capped at {@link MAX_SEND_RETRIES} = 3).
 *
 * Every retry re-signs, so the signature always matches the new message.
 * Non-expiry failures (bad simulation, insufficient funds, slippage) are thrown
 * immediately — retrying those only wastes blockhash slots.
 */

import {
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";

/** Automatic retries after BlockheightExceeded / expired signature. */
export const MAX_SEND_RETRIES = 3;

/** ComputeBudget instruction discriminators (u8 prefix). */
const COMPUTE_BUDGET_UNIT_LIMIT = 2;
const COMPUTE_BUDGET_UNIT_PRICE = 3;

/**
 * Fragments Solana uses for an expired signature: web3.js error names, RPC
 * messages, the JSON-RPC `-32002` code and the plain "block height exceeded".
 */
const EXPIRED_BLOCKHASH_PATTERN =
  /block\s?height\s+(?:exceeded|not\s?found)|block\s?hash\s+not\s?found|blockhash\s+not\s?found|signature\s+(?:has\s+)?expired|TransactionExpiredBlockheightExceeded|BlockheightExceeded|-32002/i;

/**
 * True for `BlockheightExceededError`, `TransactionExpiredBlockheightExceededError`,
 * "signature expired: block height exceeded" and `Blockhash not found` (-32002),
 * including errors that arrive wrapped (`error.error`, `error.cause`, `error.logs`).
 */
export function isBlockhashExpiredError(error) {
  if (!error) return false;
  const seen = new Set();
  const stack = [error];

  while (stack.length > 0) {
    const value = stack.pop();
    if (value == null || seen.has(value)) continue;

    if (typeof value === "string") {
      if (EXPIRED_BLOCKHASH_PATTERN.test(value)) return true;
      continue;
    }
    if (typeof value !== "object") continue;
    seen.add(value);

    const name = String(value.name || "");
    if (/BlockheightExceeded|TransactionExpiredBlockheightExceeded/i.test(name)) return true;
    if (Number(value.code) === -32002) return true;
    if (typeof value.code === "string" && /BLOCKHEIGHT_EXCEEDED|BLOCKHASH_NOT_FOUND/i.test(value.code)) {
      return true;
    }

    for (const key of ["message", "errorMessage", "reason", "details", "signature"]) {
      if (typeof value[key] === "string" && EXPIRED_BLOCKHASH_PATTERN.test(value[key])) return true;
    }
    if (Array.isArray(value.logs)) {
      if (value.logs.some((line) => typeof line === "string" && EXPIRED_BLOCKHASH_PATTERN.test(line))) {
        return true;
      }
    }
    // Wrapped errors: `{ error: { code, message } }` (RPC), `cause`, `data`.
    for (const key of ["error", "cause", "data"]) {
      if (value[key] && typeof value[key] === "object") stack.push(value[key]);
    }
  }

  return false;
}

/** Truncate a number into an integer range, falling back when it is not finite. */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Effective sending settings: `config.tx` with optional per-call overrides.
 * Pure — safe to call on every send, never touches the network.
 */
export function resolveTxSettings(overrides = {}) {
  const tx = config.tx ?? {};
  const pick = (key, fallback) => overrides[key] ?? tx[key] ?? fallback;
  return {
    priorityFeeMicroLamports: clampInt(pick("priorityFeeMicroLamports", 0), 0, 0, 10_000_000),
    computeUnitLimit: clampInt(pick("computeUnitLimit", 0), 0, 0, 1_400_000),
    maxSendRetries: clampInt(pick("maxSendRetries", MAX_SEND_RETRIES), MAX_SEND_RETRIES, 0, MAX_SEND_RETRIES),
    retryDelayMs: clampInt(pick("retryDelayMs", 400), 400, 0, 5_000),
    commitment: overrides.commitment ?? tx.commitment ?? "confirmed",
    skipPreflight: overrides.skipPreflight ?? tx.skipPreflight ?? false,
  };
}

// ─── Priority fees ────────────────────────────────────────────────
/**
 * ComputeBudget instructions for the configured priority fee.
 * `priorityFeeMicroLamports` is micro-lamports per compute unit (Solana/Jupiter
 * convention); `0` disables the instruction so the runtime default applies.
 */
export function buildPriorityFeeInstructions({ priorityFeeMicroLamports = 0, computeUnitLimit = 0 } = {}) {
  const instructions = [];
  const limit = clampInt(computeUnitLimit, 0, 0, 1_400_000);
  const price = clampInt(priorityFeeMicroLamports, 0, 0, 10_000_000);
  if (limit > 0) instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: limit }));
  if (price > 0) instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  return instructions;
}

/** Discriminators of the ComputeBudget instructions already present in `instructions`. */
function existingComputeBudgetKinds(instructions = []) {
  const kinds = new Set();
  for (const instruction of instructions) {
    if (!instruction?.programId?.equals?.(ComputeBudgetProgram.programId)) continue;
    const data = instruction.data;
    if (data?.length) kinds.add(Number(data[0]));
  }
  return kinds;
}

/**
 * Prepend the priority-fee instructions, skipping any ComputeBudget kind the
 * transaction already carries (a duplicate instruction is a runtime error).
 */
export function withPriorityFeeInstructions(instructions = [], settings = {}) {
  const existing = existingComputeBudgetKinds(instructions);
  const additions = buildPriorityFeeInstructions(settings)
    .filter((instruction) => !existing.has(Number(instruction.data[0])));
  return additions.length > 0 ? [...additions, ...instructions] : [...instructions];
}

/**
 * Rebuild a legacy `Transaction` around a fresh blockhash plus the priority-fee
 * instructions. The caller's transaction is never mutated, so it can be reused
 * for the next attempt.
 */
export function prepareLegacyTransaction(tx, {
  blockhash,
  lastValidBlockHeight = null,
  priorityFeeMicroLamports = 0,
  computeUnitLimit = 0,
  feePayer = null,
} = {}) {
  const next = new Transaction();
  next.feePayer = tx.feePayer ?? feePayer ?? undefined;
  next.recentBlockhash = blockhash;
  if (lastValidBlockHeight != null) next.lastValidBlockHeight = lastValidBlockHeight;
  next.instructions = withPriorityFeeInstructions(tx.instructions, {
    priorityFeeMicroLamports,
    computeUnitLimit,
  });

  // Size guard: a wide DLMM transaction can already sit at the 1232-byte packet
  // limit, where two extra ComputeBudget instructions make it unlandable.
  // Dropping the priority fee is always better than dropping the transaction.
  try {
    const signatures = requiredSignatureCount(next);
    const size = next.serializeMessage().length + 3 + signatures * 64;
    if (size > PACKET_DATA_SIZE) next.instructions = [...tx.instructions];
  } catch {
    next.instructions = [...tx.instructions];
  }

  return next;
}

/** Distinct signer keys a compiled transaction will carry (fee payer included). */
function requiredSignatureCount(tx) {
  const signers = new Set();
  if (tx.feePayer) signers.add(tx.feePayer.toBase58());
  for (const instruction of tx.instructions) {
    for (const key of instruction.keys || []) {
      if (key?.isSigner && key.pubkey) signers.add(key.pubkey.toBase58());
    }
  }
  return Math.max(1, signers.size);
}


// ─── Send + confirm with retries ──────────────────────────────────
function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** One broadcast attempt: sign against the supplied blockhash, send, confirm. */
async function sendOnce(connection, tx, signers, blockhashInfo, settings) {
  const { blockhash, lastValidBlockHeight } = blockhashInfo;
  let serialized;

  if (tx instanceof VersionedTransaction) {
    // Externally-built v0 message (e.g. a Jupiter order): only the blockhash can
    // be refreshed — inserting instructions would invalidate the builder's
    // last-look checks. Every signature is recomputed for the new message.
    tx.message.recentBlockhash = blockhash;
    tx.sign(signers);
    serialized = tx.serialize();
  } else {
    const prepared = prepareLegacyTransaction(tx, {
      blockhash,
      lastValidBlockHeight,
      priorityFeeMicroLamports: settings.priorityFeeMicroLamports,
      computeUnitLimit: settings.computeUnitLimit,
      feePayer: signers[0]?.publicKey ?? null,
    });
    prepared.sign(...signers);
    serialized = prepared.serialize();
  }

  const signature = await connection.sendRawTransaction(serialized, {
    skipPreflight: settings.skipPreflight,
    preflightCommitment: settings.commitment,
    // We own the retry policy; the RPC must not re-broadcast a stale blockhash.
    maxRetries: 0,
  });

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    settings.commitment,
  );

  return signature;
}

/**
 * `sendAndConfirmTransaction` with blockhash-expiry recovery.
 *
 * On `BlockheightExceededError` / "signature expired: block height exceeded" /
 * `Blockhash not found` it fetches a FRESH recent blockhash, re-signs the
 * transaction and re-broadcasts immediately — up to
 * `config.tx.maxSendRetries` times (hard cap {@link MAX_SEND_RETRIES} = 3).
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").Transaction|import("@solana/web3.js").VersionedTransaction} tx
 * @param {Array<import("@solana/web3.js").Signer>} signers
 * @param {object} [options] - `label`, plus {@link resolveTxSettings} overrides.
 * @returns {Promise<string>} the confirmed transaction signature.
 */
export async function sendAndConfirmWithRetry(connection, tx, signers = [], options = {}) {
  const settings = resolveTxSettings(options);
  const label = options.label || "transaction";
  const memberSigners = Array.isArray(signers) ? signers.filter(Boolean) : [];
  if (memberSigners.length === 0) throw new Error(`${label}: at least one signer is required`);

  const attempts = 1 + settings.maxSendRetries;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let blockhashInfo;
    try {
      // Always a fresh blockhash — on the first broadcast as well, so a slow
      // caller can never sign against a blockhash the cluster already dropped.
      blockhashInfo = await connection.getLatestBlockhash(settings.commitment);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      log(
        "tx_warn",
        `${label}: blockhash fetch failed (${error?.message || error}) — retry ${attempt}/${settings.maxSendRetries}`,
      );
      await sleep(settings.retryDelayMs * attempt);
      continue;
    }

    try {
      const signature = await sendOnce(connection, tx, memberSigners, blockhashInfo, settings);
      if (attempt > 1) log("tx", `${label}: confirmed on retry ${attempt - 1} — ${signature}`);
      return signature;
    } catch (error) {
      lastError = error;
      if (!isBlockhashExpiredError(error) || attempt === attempts) break;
      log(
        "tx_warn",
        `${label}: signature expired (block height exceeded) — refreshing blockhash, re-signing ` +
        `and re-broadcasting (retry ${attempt}/${settings.maxSendRetries})`,
      );
      await sleep(settings.retryDelayMs);
    }
  }

  throw lastError ?? new Error(`${label}: failed to send transaction`);
}

