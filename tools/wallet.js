import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { extractHeliusApiKey } from "../utils/rpc.js";
// Blockhash-expiry detection + the priority-fee settings shared with `utils/tx.js`.
import { isBlockhashExpiredError, resolveTxSettings } from "../utils/tx.js";

// SPL token programs (avoid pulling in @solana/spl-token just for the ids).
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const _connections = new Map();
let _wallet = null;

function getConnection(url = config.rpc.url) {
  if (!url) {
    throw new Error(
      "RPC_URL is not set — add it to .env (Helius: https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY)",
    );
  }
  if (!_connections.has(url)) _connections.set(url, new Connection(url, "confirmed"));
  return _connections.get(url);
}

/** Read-only fallback connection (RPC_FALLBACK_URL / public RPC), or null. */
function getFallbackConnection() {
  const url = config.rpc.fallbackUrl;
  if (!url) return null;
  try {
    return getConnection(url);
  } catch {
    return null;
  }
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

/**
 * Jupiter referral parameters for a Swap V2 `/order` request.
 *
 * Referral fees are **opt-in and disabled by default**: this returns `null`
 * (so NO `referralAccount` / `referralFee` query params are added at all)
 * unless a referral account is configured AND a positive fee is requested.
 * There is no built-in/hard-coded referral account any more.
 */
export function buildJupiterReferralParams({ account = null, feeBps = 0 } = {}) {
  const referralAccount = String(account ?? "").trim();
  // No account (the default) → feature off. No warning: this is the normal path.
  if (!referralAccount) return null;
  const referralFee = Number(feeBps ?? 0);
  // 0 bps / unset / garbage → off, again silently.
  if (!Number.isFinite(referralFee) || referralFee <= 0) return null;
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/** Configured referral params from `.env` — `null` when the feature is disabled. */
export function getJupiterReferralParams() {
  if (config.jupiter?.referralEnabled === false) return null;
  return buildJupiterReferralParams({
    account: config.jupiter?.referralAccount,
    feeBps: config.jupiter?.referralFeeBps,
  });
}

/**
 * Attach referral params to a Jupiter order query.
 * When `params` is `null` (0 bps / not configured) the query is returned
 * untouched — the request carries zero fee-account parameters.
 */
export function applyJupiterReferralParams(search, params = null) {
  if (!params) return search;
  search.set("referralAccount", params.referralAccount);
  search.set("referralFee", String(params.referralFee));
  return search;
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const heliusKey = extractHeliusApiKey(process.env.HELIUS_API_KEY || config.rpc.heliusApiKey);
  if (!heliusKey) {
    log("wallet_warn", "HELIUS_API_KEY not set in .env — attempting read-only RPC fallback");
    const fallback = await getRpcWalletBalances(walletAddress, { reason: "Helius API key missing" });
    if (fallback) return fallback;

    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${encodeURIComponent(heliusKey)}`;
    const res = await fetch(url);

    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403
        ? `Helius rejected the API key (HTTP ${res.status}) — HELIUS_API_KEY must be the bare key (uuid) from https://dashboard.helius.dev, not a URL or quoted string`
        : `Helius API error: ${res.status} ${res.statusText}`;
      throw Object.assign(new Error(hint), { httpStatus: res.status });
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
      source: "helius",
    };
  } catch (error) {
    log("wallet_error", error.message);

    // Helius down / key revoked → optional read-only fallback so sizing and
    // balance displays keep working instead of silently reporting 0 SOL.
    const fallback = await getRpcWalletBalances(walletAddress, { reason: error.message });
    if (fallback) return fallback;

    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/** Jupiter USD price for a mint (best-effort; 0 when unavailable). */
async function fetchSolPriceUsd() {
  try {
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${config.tokens.SOL}`);
    if (!res.ok) return 0;
    const data = await res.json();
    const entry = data?.[config.tokens.SOL] ?? data?.data?.[config.tokens.SOL];
    const price = Number(entry?.usdPrice ?? entry?.price ?? 0);
    return Number.isFinite(price) ? price : 0;
  } catch {
    return 0;
  }
}

/**
 * Read-only balance snapshot straight from an RPC endpoint
 * (`getBalance` + `getParsedTokenAccountsByOwner`).
 *
 * Only used when Helius is unavailable AND a fallback endpoint is configured
 * (`RPC_FALLBACK_URL` or `ENABLE_PUBLIC_RPC_FALLBACK=true`). Never used to send
 * transactions. Returns null when no fallback is configured or it also fails.
 */
async function getRpcWalletBalances(walletAddress, { reason } = {}) {
  const connection = getFallbackConnection();
  if (!connection) return null;

  try {
    log("wallet_warn", `Helius unavailable (${reason}) — using fallback RPC ${connection.rpcEndpoint}`);

    const owner = new PublicKey(walletAddress);
    const [lamports, legacyAccounts, token2022Accounts, solPrice] = await Promise.all([
      connection.getBalance(owner),
      connection
        .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM })
        .catch(() => ({ value: [] })),
      connection
        .getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM })
        .catch(() => ({ value: [] })),
      fetchSolPriceUsd(),
    ]);

    const tokens = [...(legacyAccounts.value || []), ...(token2022Accounts.value || [])]
      .map((entry) => entry?.account?.data?.parsed?.info)
      .filter(Boolean)
      .map((info) => ({
        mint: info.mint,
        symbol: info.mint.slice(0, 8),
        balance: Number(info.tokenAmount?.uiAmountString ?? info.tokenAmount?.uiAmount ?? 0),
        usd: null,
      }))
      .filter((token) => token.balance > 0);

    const solBalance = lamports / LAMPORTS_PER_SOL;
    const solUsd = solBalance * solPrice;
    const usdcBalance = tokens.find((token) => token.mint === config.tokens.USDC)?.balance || 0;

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens,
      total_usd: Math.round((solUsd + usdcBalance) * 100) / 100,
      source: "rpc-fallback",
      fallback_reason: reason,
    };
  } catch (error) {
    log("wallet_error", `RPC fallback failed: ${error.message}`);
    return null;
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

// ─── Jupiter Swap V2 landing with blockhash-expiry retries ────────
/** Hard cap for swap landing retries (mirrors `utils/tx.js`). */
const SWAP_MAX_RETRIES = 3;

/**
 * `GET /swap/v2/order` — quote + a ready-to-sign transaction + `requestId`.
 * Jupiter builds the message with a fresh recent blockhash and its own
 * managed-landing priority fee on every call.
 */
async function requestJupiterSwapOrder({ search, jupiterApiKey }) {
  const orderRes = await fetch(`${JUPITER_SWAP_V2_API}/order?${search.toString()}`, {
    headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
  });
  if (!orderRes.ok) {
    const body = await orderRes.text();
    throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
  }
  const order = await orderRes.json();
  if (order.errorCode || order.errorMessage) {
    throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
  }
  if (!order?.transaction || !order?.requestId) {
    throw new Error("Swap V2 order error: missing transaction/requestId");
  }
  return order;
}

/** Sign the order with the wallet and land it through `/execute`. */
async function postJupiterSwapExecute({ order, tx, wallet, jupiterApiKey }) {
  tx.sign([wallet]);
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
  const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
    },
    body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
  });
  if (!execRes.ok) {
    throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
  }
  const result = await execRes.json();
  if (result.status === "Failed") {
    throw new Error(`Swap failed on-chain: code=${result.code}${result.error ? ` (${result.error})` : ""}`);
  }
  return result;
}

/**
 * Quote → sign → execute, retrying up to `maxRetries` times when the signature
 * expires ("Signature expired: block height exceeded" / BlockheightExceeded).
 *
 * Recovery mirrors the local sender in `utils/tx.js`:
 *   1. re-quote (`/order`) — Jupiter returns a brand-new message carrying a
 *      FRESH recent blockhash — then re-sign and re-broadcast immediately;
 *   2. if the re-quote fails, fetch a fresh blockhash from our RPC, patch the
 *      existing message, re-sign and re-broadcast.
 *
 * Non-expiry errors (slippage, insufficient funds, on-chain failure) surface
 * immediately — retrying them only burns blockhash slots.
 */
export async function landJupiterSwap({ search, jupiterApiKey, wallet, connection, maxRetries = SWAP_MAX_RETRIES }) {
  let order = await requestJupiterSwapOrder({ search, jupiterApiKey });
  let tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      const result = await postJupiterSwapExecute({ order, tx, wallet, jupiterApiKey });
      return { order, result, attempts };
    } catch (error) {
      if (!isBlockhashExpiredError(error) || attempts > maxRetries) throw error;
      log(
        "swap_warn",
        `Swap signature expired (block height exceeded) — refreshing blockhash, re-signing and ` +
        `re-broadcasting (retry ${attempts}/${maxRetries})`,
      );
      try {
        order = await requestJupiterSwapOrder({ search, jupiterApiKey });
        tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
      } catch (requoteError) {
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.message.recentBlockhash = blockhash;
        log(
          "swap_warn",
          `Swap re-quote failed (${requoteError.message}) — refreshed blockhash locally (${String(blockhash).slice(0, 8)}…)`,
        );
      }
    }
  }
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    // Referral is disabled by default → `referralParams === null` and the order
    // request carries no fee account at all.
    const referralParams = getJupiterReferralParams();
    applyJupiterReferralParams(search, referralParams);
    const jupiterApiKey = getJupiterApiKey();
    const txSettings = resolveTxSettings();

    // ─── Quote → sign → execute, retried on an expired blockhash ──
    const { order, result, attempts } = await landJupiterSwap({
      search,
      jupiterApiKey,
      wallet,
      connection,
      maxRetries: Math.min(SWAP_MAX_RETRIES, txSettings.maxSendRetries),
    });

    // Jupiter's managed landing owns the swap's priority fee (the /order message
    // must not be modified). Surface it so a starved bid is visible in the logs.
    const appliedPriorityFee = Number(order.prioritizationFeeLamports ?? 0);
    if (txSettings.priorityFeeMicroLamports > 0 && appliedPriorityFee <= 0) {
      log(
        "swap_warn",
        `Jupiter attached no prioritization fee for this swap (config ${txSettings.priorityFeeMicroLamports} µL/CU) — inclusion may be slower`,
      );
    }

    log("swap", `SUCCESS tx: ${result.signature}${attempts > 1 ? ` (retry ${attempts - 1})` : ""}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      // Referral metadata only when a referral fee was actually requested
      // (never when the feature is disabled — the default).
      ...(referralParams
        ? {
            referral_account: referralParams.referralAccount,
            referral_fee_bps_requested: referralParams.referralFee,
          }
        : {}),
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
      // Landing telemetry: how many broadcasts it took and the priority fee
      // Jupiter attached through its managed landing.
      swap_attempts: attempts,
      priority_fee_lamports: Number.isFinite(appliedPriorityFee) ? appliedPriorityFee : null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
