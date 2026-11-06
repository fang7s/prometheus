import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import { jsonrepair } from "jsonrepair";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, degenScore } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  sendHTMLWithButtons,
  editMessage,
  editMessageWithButtons,
  editHTMLWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPositions, getTrackedPosition, getPositionConfig, setPositionInstruction, confirmPeak, registerExitSignal } from "./state.js";
import { EXIT_PRIORITY, detectExit, formatExitLog, parseInstructionOverrides } from "./exit-rules.js";
// `withDeadline` rejects with TimeoutError; the local `withTimeout` below is the
// non-throwing shutdown helper and keeps its existing contract.
import { isTimeoutError, withTimeout as withDeadline } from "./utils/timeout.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import {
  showLpMainMenu,
  showNewPositionView,
  showPoolListView,
  showPositionsView,
  forgetLpMessageView,
  handleLpCallback,
  handleLpText,
  openAddressQuery as openLpAddressQuery,
  openPoolByAddress as openLpPoolByAddress,
} from "./services/lp-menu.js";
// Hot Fees Opportunity digest — read-only ranking broadcast (/hot, /screener)
// plus its inline keyboard. The service owns fetch + cache + rendering; this
// module only schedules it and routes the button callbacks.
import {
  SCREENER_CALLBACK_PREFIX,
  buildHotDigestMessage,
  clearDigestSuppression,
  getScreenerSettings,
  getSuppressionState,
  invalidateHotDigest,
  isDigestSuppressed,
  parseScreenerCallback,
  resolveHotPool,
  suppressDigest,
} from "./services/screenerService.js";
// Pure, synchronous Telegram layout helpers (tree branches, dividers, progress
// bars, monospace blocks). Zero I/O — they only format the in-memory snapshot.
import {
  SECTION_DIVIDER,
  computeRangePositionPct,
  formatMoney,
  formatProgressBar,
  formatSignedPct,
  formatTreeRows,
  rangeStatusText,
} from "./services/telegramFormat.js";
import { recordPriceSample, queueClosedPositionPnlCard } from "./services/pnlCardGenerator.js";
import { monitorPosition } from "./services/positionMonitor.js";
import {
  POOL_TIMEOUT_MESSAGE,
  POOL_TIMEOUT_MS,
  createAbortToken,
  formatBasicPoolMetrics,
  runIsolatedTask,
} from "./services/poolScreening.js";
import {
  SCREENING_TRIGGER_DEDUPE_MS,
  clampIntervalMin,
  cronExprForHours,
  cronExprForInterval,
  normalizeScreenerIntervalHours,
  shouldAcceptScreeningTrigger,
} from "./utils/schedule.js";
// Import only what we actually need for the new functionality
import { evaluateEvilPandaCandidate, getEvilPandaRecommendedParams } from "./tools/evil-panda-enhanced.js";
import { checkAllPositionsForFlip } from "./tools/bid-ask-flipper.js";

import { REPO_ROOT, repoPath } from "./repo-root.js";

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const indexPath = fileURLToPath(import.meta.url);
const isMain = process.env.pm_id != null
  || (entrypointPath ? path.resolve(entrypointPath) === indexPath : false);

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);
  if (path.resolve(process.cwd()) !== path.resolve(REPO_ROOT)) {
    log("startup_warn", `process.cwd() differs from repo root — use "npm run pm2:start" (not "pm2 start index.js" from another directory)`);
  }
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
// ─── Interactive network guards ──────────────────────────────────
// Telegram commands must never wait on a stalled RPC/API call. Every interactive
// read is bounded by this deadline (autonomous cycles keep their own budgets).
const NETWORK_TIMEOUT_MS = 5_000;
const TIMEOUT_MESSAGE = "⚠️ Network timeout, please try again";
// Position reads hit Solana RPC (pump.helius) + the Meteora API. Bounded so a
// dead endpoint can never pin the PnL poller (`_pnlPollBusy` stuck) or a cycle.
const POSITIONS_READ_TIMEOUT_MS = 8_000;

let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastAcceptedAt = 0; // epoch ms — dedupe window for screening triggers
let _cronStarted = false;    // idempotent-ish scheduler guard (no duplicate timer sets)
let _flipperBusy = false;    // prevents overlapping bid-ask flipper cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
// Hot Fees digest: single-flight guard only. The screener's network calls are
// fire-and-forget from the cron tick — nothing here ever awaits them on the
// fast 3 s PnL path or on the Telegram poll loop.
let _hotDigestBusy = false;
let _hotDigestLastSentAt = 0;
// Exit/peak confirmation is now done by consecutive-tick counting in state.js
// (registerExitSignal / confirmPeak), driven by the 3s RPC poller — no setTimeout rechecks.

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._opportunityPollInterval) clearInterval(_cronTasks._opportunityPollInterval);
  _cronTasks = [];
  _cronStarted = false;
}

// ─── Hot Fees Opportunity digest ─────────────────────────────────
/**
 * Broadcast the "Hot Fees Right Now" digest to the operator's chat.
 *
 * Non-blocking contract: this function *is* the background job. The cron tick
 * calls it and returns immediately; nothing on the 3 s PnL poller, the
 * management/screening cycles or the Telegram poll loop ever awaits it. Inside,
 * every network call is deadline-bounded by the screener service.
 *
 * Suppression: when the operator tapped 😴 Snooze or 🔕 Mute, the *automatic*
 * broadcast is skipped (the manual /hot command still works — see
 * `handleHotDigestCommand`).
 *
 * @param {{ reason?: string, force?: boolean, silent?: boolean, editMessageId?: number|null }} [options]
 * @returns {Promise<object|null>} the built message, or null when skipped/failed
 */
async function runHotDigestBroadcast({ reason = "cron", force = false, silent = false, editMessageId = null } = {}) {
  if (!telegramEnabled()) {
    log("screener", "Hot Fees digest skipped — Telegram not configured");
    return null;
  }
  if (_hotDigestBusy) {
    log("screener", `Hot Fees digest skipped — previous run still in flight (${reason})`);
    return null;
  }
  _hotDigestBusy = true;
  const startedAt = Date.now();
  try {
    const message = await buildHotDigestMessage({
      force,
      intervalHours: config.screener?.intervalHours,
    });
    if (editMessageId) {
      const edited = await editHTMLWithButtons(message.html, editMessageId, message.keyboard);
      // "message is not modified" / a deleted message → fall back to a fresh send.
      if (!edited) await sendHTMLWithButtons(message.html, message.keyboard);
    } else {
      await sendHTMLWithButtons(message.html, message.keyboard);
    }
    _hotDigestLastSentAt = Date.now();
    log(
      "screener",
      `Hot Fees digest sent (${message.snapshot?.pools?.length ?? 0} pool(s), ` +
        `${_hotDigestLastSentAt - startedAt}ms, reason=${reason}${message.snapshot?.stale ? ", stale" : ""})`,
    );
    return message;
  } catch (error) {
    log("screener_warn", `Hot Fees digest failed (${reason}): ${error?.message || error}`);
    if (!silent) {
      await sendMessage(`⚠️ Hot Fees digest unavailable: ${error?.message || error}`).catch(() => {});
    }
    return null;
  } finally {
    _hotDigestBusy = false;
  }
}

/**
 * Execute the decisions produced by the deterministic rule engine. CLOSE/CLAIM
 * run directly via executeTool (no LLM) — preserving all post-effects (notify,
 * auto-swap, recordPerformance, decision-log). There is no LLM path here: rule
 * decisions are final.
 */
async function executeManagementActions(actionPositions, actionMap, { liveMessage = null } = {}) {
  const lines = [];

  for (const p of actionPositions) {
    const act = actionMap.get(p.position);
    if (!act) continue;

    if (act.action === "CLOSE") {
      lines.push(await executeRuleClose(p, act, { liveMessage }));
    } else if (act.action === "CLAIM") {
      await liveMessage?.toolStart("claim_fees");
      const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("claim_fees", res, ok);
      lines.push(`${p.pair}: ${ok ? "fees claimed" : `claim FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
  }

  return lines.join("\n");
}

/**
 * Detached closed-position PnL card dispatch.
 *
 * The text-only closing summary has already been sent by the caller; this helper
 * only *schedules* the Zenith card. Rendering + photo upload happen on a later
 * event-loop turn (`setImmediate` inside the generator) under a hard 5 s
 * deadline, so neither the Telegram poll loop nor the position-monitoring tick
 * ever waits for the canvas — `/start`, `/positions` and the next command stay
 * responsive even if the render or Telegram upload stalls.
 */
function dispatchClosedPositionPnlCard(pos, result) {
  try {
    queueClosedPositionPnlCard(
      { ...result, pair: pos.pair },
      { tracked: getTrackedPosition(pos.position) },
    );
  } catch (error) {
    log("pnl_card_warn", `Closed PnL card dispatch failed: ${error?.message || error}`);
  }
}

/**
 * Deterministic close execution: log the exact rule, then call the close tool
 * directly. The LLM is never consulted and receives no position evaluation data.
 */
async function executeRuleClose(position, decision, { liveMessage = null } = {}) {
  // Exact priority reason, e.g. `[EXIT] Priority 1: TP hit (+5.00%) — HYPE/USDC`
  log("rule_engine", formatExitLog(position.pair, decision));

  // Priority 2 (range out) honours the position's OWN `autoRebalance` flag: when
  // it is enabled the position is closed and redeployed around the live active
  // bin with the same strategy / size / TP-SL config instead of simply closing.
  // Priority 1 (hard TP/SL) always closes — rebalancing a hit TP/SL would defeat
  // the risk rule. The flag is per position and defaults to false.
  if (decision?.priority === EXIT_PRIORITY.RANGE) {
    const positionConfig = getPositionConfig(position.position);
    if (positionConfig.autoRebalance === true) {
      const { rebalancePosition } = await import("./services/positionActions.js");
      const result = await rebalancePosition({
        position_address: position.position,
        position,
        reason: `${decision.headline || decision.name}: ${decision.reason}`,
      }).catch((error) => ({ success: false, error: error.message }));
      if (result?.success) {
        log(
          "rule_engine",
          `[REBALANCE] ${position.pair} auto-rebalanced around the active bin` +
          `${result.new_position ? ` → ${result.new_position}` : ""}`,
        );
        return `${position.pair}: auto-rebalanced — ${decision.headline || decision.name}`;
      }
      if (result?.closed) {
        // The close went through but the redeploy did not — the position is flat,
        // so the normal close path below must not run again.
        return `${position.pair}: closed — ${decision.headline || decision.name} ` +
          `(auto-rebalance redeploy failed: ${result.error})`;
      }
      log(
        "rule_engine_warn",
        `[REBALANCE] ${position.pair} auto-rebalance failed (${result?.error}) — closing instead`,
      );
    }
  }

  await liveMessage?.toolStart("close_position");
  const res = await executeTool("close_position", {
    position_address: position.position,
    reason: `${decision.headline || decision.name}: ${decision.reason}`,
  }).catch(e => ({ error: e.message }));
  const ok = res?.success !== false && !res?.error && !res?.blocked;
  await liveMessage?.toolFinish("close_position", res, ok);
  return `${position.pair}: ${ok ? `closed — ${decision.headline || decision.name}` : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`;
}

/**
 * Simplified 2-priority exit evaluation: Priority 1 hard TP/SL on total PnL →
 * Priority 2 range out (only once `hasEnteredRange === true`).
 *
 * Both priorities are pure numeric checks over the local position snapshot, so
 * this is synchronous and never touches the network — no candle/Supertrend fetch,
 * no indicator call, no added exit latency.
 */
function evaluatePositionExit(position) {
  return detectExit(position, config.management);
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await withDeadline(
      getMyPositions({ force: true }),
      POSITIONS_READ_TIMEOUT_MS,
      "management positions",
    ).catch((error) => {
      log("cron_warn", `Management position read failed (${error.message}) — skipping this cycle`);
      return null;
    });
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      requestScreeningCycle({ reason: "no-positions", dedupeMs: screeningCooldownMs })
        .catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const trackedByPosition = new Map(getTrackedPositions(true).map((t) => [t.position, t]));
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      const tracked = trackedByPosition.get(p.position) ?? null;
      // Feed the closed-position PnL card with the real bin → price path.
      recordPriceSample(p.position, p.active_bin, tracked?.bin_step);
      // Monitoring tick: arm Priority 2 (hasEnteredRange) once price is in range.
      monitorPosition(p, { tracked });
      return { ...p, recall: recallForPool(p.pool) };
    });

    // Simplified 2-priority exit hierarchy — Priority 1 hard TP/SL (total PnL:
    // unrealized + claimable/claimed fees vs deposit) → Priority 2 range out.
    // Pure local snapshot math: no candle/indicator fetch, no LLM, no position
    // data to a model. Management is the slow cron backstop: raise peak
    // immediately (confirmTicks=1) and act on detected exits directly. Real-time
    // 2-tick confirmation lives in the fast poller below.
    const exitMap = new Map();
    for (const p of positionData) {
      confirmPeak(p.position, p.pnl_pct, 1);
      const decision = evaluatePositionExit(p);
      if (decision) {
        exitMap.set(p.position, decision);
        log(
          "rule_engine",
          `${formatExitLog(p.pair, decision)} — ${decision.reason}`,
        );
      }
    }

    // ── Deterministic action map (no LLM) ───────────────────────────
    // action: CLOSE (rule engine) | CLAIM | STAY
    const actionMap = new Map();
    for (const p of positionData) {
      const decision = exitMap.get(p.position);
      if (decision) {
        actionMap.set(p.position, decision);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report (pure local snapshot → ASCII tree, no I/O) ───
    // Plain text: this report is delivered through `sendMessage`/`editMessage`
    // (the live message), which does not parse markup — so no HTML tags here,
    // just the same tree branches / dividers / progress bars as `/positions`.
    const totalValue = positionData.reduce((s, p) => s + (Number(p.total_value_usd) || 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (Number(p.unclaimed_fees_usd) || 0), 0);
    const moneyMode = config.management.solMode ? "SOL" : "USD";

    const reportLines = positionData.map((p, index) => {
      const act = actionMap.get(p.position) ?? { action: "STAY" };
      const statusLabel = act.action === "CLOSE" ? `CLOSE (${act.headline || act.name})` : act.action;
      const rangePct = computeRangePositionPct({
        lowerBinId: p.lower_bin,
        upperBinId: p.upper_bin,
        activeBinId: p.active_bin,
      });
      let instructionRow = null;
      if (p.instruction) {
        const overrides = parseInstructionOverrides(p.instruction);
        const parsed = Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(", ");
        instructionRow = {
          label: "📝 Note",
          value: `"${p.instruction}"${parsed ? ` (rules: ${parsed})` : " (info only)"}`,
        };
      }
      const rows = [
        { label: "⏱ Age", value: `${p.age_minutes ?? "?"}m` },
        { label: "💵 Value", value: formatMoney(p.total_value_usd, moneyMode) },
        { label: "🎁 Unclaimed", value: formatMoney(p.unclaimed_fees_usd, moneyMode) },
        { label: "📈 PnL", value: formatSignedPct(p.pnl_pct) },
        { label: "🌾 Yield", value: `${p.fee_per_tvl_24h ?? "?"}%` },
        rangePct != null ? { label: "📍 Range", value: formatProgressBar(rangePct) } : null,
        { label: "🎯 Action", value: statusLabel },
        act.action === "CLOSE" ? { label: "↳ Why", value: `${act.headline || act.name}: ${act.reason}` } : null,
        act.action === "CLAIM" ? { label: "↳", value: "Claiming fees" } : null,
        instructionRow,
      ];
      const header = `${index + 1} · ${p.pair} · ${rangeStatusText(p.in_range, p.minutes_out_of_range)}`;
      return `${header}\n${formatTreeRows(rows)}`;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "CLOSE"
        ? `CLOSE ${a.headline || a.name}${a.reason ? ` — ${a.reason}` : ""}`
        : a.action).join(", ")
      : "no action";

    const summaryBlock = [
      "📊 Summary",
      formatTreeRows([
        { label: "💼 Positions", value: String(positions.length) },
        { label: "💵 Value", value: formatMoney(totalValue, moneyMode) },
        { label: "🎁 Unclaimed", value: formatMoney(totalUnclaimed, moneyMode) },
        { label: "🎯 Actions", value: actionSummary },
      ]),
    ].join("\n");
    mgmtReport = [SECTION_DIVIDER, reportLines.join("\n\n"), SECTION_DIVIDER, summaryBlock].join("\n\n");

    // ── Execute rule decisions directly (no LLM) ────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      const execReport = await executeManagementActions(actionPositions, actionMap, { liveMessage });
      if (execReport) mgmtReport += `\n\n${execReport}`;
    } else {
      log("cron", "Management: all positions STAY — skipping");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      requestScreeningCycle({ reason: "post-management", dedupeMs: screeningCooldownMs })
        .catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          // The alert is rendered from this in-memory snapshot only — no extra
          // RPC/API read is triggered just to describe the position.
          notifyOutOfRange({
            pair: p.pair,
            minutesOOR: p.minutes_out_of_range,
            position: p,
            mode: config.management.solMode ? "SOL" : "USD",
            waitMinutes: config.management.outOfRangeWaitMinutes,
          }).catch(() => { });
        }
      }
    }
    // Busy flags are clear again — replay commands the user sent mid-cycle so
    // /start and friends are never stranded in the queue.
    drainTelegramQueue().catch(() => {});
  }
  return mgmtReport;
}

/**
 * True while a screening cycle (or an accepted trigger that is about to start
 * one) is active. Cron ticks, the opportunity poller, management hand-off and
 * `/pool` all consult this so a cycle can never be spawned twice.
 */
export function isScreeningRunning() {
  return _screeningBusy;
}

/**
 * Single entry point for *automatic* screening triggers.
 *
 * Applies the two scheduler guards before touching `runScreeningCycle`:
 *   1. `isScreeningRunning()` — never spawn a second cycle, and
 *   2. a dedupe window — overlapping triggers (cron tick + opportunity poll +
 *      management hand-off) collapse into one cycle instead of queueing up.
 *
 * @param {object} [options]
 * @param {string} [options.reason] - trigger name for logs (`cron`, `opportunity`, …)
 * @param {number} [options.dedupeMs] - override the dedupe window
 * @returns {Promise<string|null>} the cycle report, or null when skipped
 */
export async function requestScreeningCycle({
  reason = "trigger",
  silent = false,
  useLLM = false,
  ioTimeoutMs = 0,
  dedupeMs = SCREENING_TRIGGER_DEDUPE_MS,
} = {}) {
  const verdict = shouldAcceptScreeningTrigger({
    isRunning: isScreeningRunning(),
    lastAcceptedAt: _screeningLastAcceptedAt,
    dedupeMs,
  });
  if (!verdict.accept) {
    log("cron", `Screening trigger (${reason}) skipped — ${verdict.reason}`);
    return null;
  }
  // Stamp before awaiting so concurrent triggers see it immediately.
  _screeningLastAcceptedAt = Date.now();
  return runScreeningCycle({ silent, useLLM, ioTimeoutMs });
}

/**
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {boolean} [options.useLLM]
 * @param {number} [options.ioTimeoutMs] - hard deadline for each network read.
 *   The interactive `/pool` command passes {@link NETWORK_TIMEOUT_MS} so a stalled
 *   RPC/API can never keep the user waiting; autonomous cycles pass 0 (unbounded).
 * @param {{aborted: boolean, throwIfAborted: (label?: string) => void}|null} [options.abortToken]
 *   Cooperative cancellation. Checked before the discovery call, before the LLM
 *   and immediately before the deploy, so a `/pool` run that blew its deadline
 *   can never place a position afterwards.
 */
export async function runScreeningCycle({
  silent = false,
  useLLM = false,
  ioTimeoutMs = 0,
  abortToken = null,
} = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  /** Apply the interactive deadline (when configured) to one network read. */
  const io = (promise, label) => (ioTimeoutMs > 0 ? withDeadline(promise, ioTimeoutMs, label) : promise);

  /** Clear the busy flag and let queued user commands through before returning. */
  const finish = (report) => {
    _screeningBusy = false;
    drainTelegramQueue().catch(() => {});
    return report;
  };

  /**
   * Cooperative cancellation for the interactive `/pool` run: once its 8 s
   * deadline fires the token flips and the cycle stops at the next checkpoint
   * (discovery → LLM → deploy), so it can never act after the user was told it
   * timed out.
   */
  const abortIfCancelled = (phase) => {
    if (!abortToken?.aborted) return false;
    screenReport = `Screening aborted (${phase}) — exceeded the interactive deadline.`;
    log("cron_warn", screenReport);
    return true;
  };

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([
      io(getMyPositions({ force: true }), "positions read"),
      io(getWalletBalances(), "wallet read"),
    ]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      return finish(screenReport);
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      return finish(screenReport);
    }
  } catch (e) {
    const timedOut = isTimeoutError(e);
    log(timedOut ? "cron_warn" : "cron_error",
      timedOut
        ? `Screening pre-check timed out after ${ioTimeoutMs}ms — releasing the command`
        : `Screening pre-check failed: ${e.message}`);
    screenReport = timedOut ? TIMEOUT_MESSAGE : `Screening pre-check failed: ${e.message}`;
    return finish(screenReport);
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [${useLLM ? `LLM selection — model: ${config.llm.screeningModel}` : "deterministic selection (no LLM)"}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const deployStrategy = config.strategy.strategy;
    const strategyBlock = `DEPLOY STRATEGY: ${deployStrategy} (from config) | bins_above: 0 (FIXED — never change) | deposit: SOL only (amount_y, amount_x=0)`
      + (activeStrategy ? `\nSTRATEGY CONTEXT: ${activeStrategy.name} — entry: ${activeStrategy.entry?.condition || "n/a"} | exit: ${activeStrategy.exit?.notes || "n/a"} | best for: ${activeStrategy.best_for}` : "");

    if (abortIfCancelled("before discovery")) return screenReport;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    let scanTimedOut = false;
    const topCandidates = await io(getTopCandidates({ limit: 10 }), "candidate scan").catch((error) => {
      if (isTimeoutError(error)) scanTimedOut = true;
      return null;
    });
    if (scanTimedOut) {
      // Interactive /pool: give up cleanly instead of leaving the user waiting.
      screenReport = TIMEOUT_MESSAGE;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Candidate scan timed out",
        reason: `No response from the screening API within ${ioTimeoutMs}ms`,
      });
      return screenReport;
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        io(checkSmartWalletsOnPool({ pool_address: pool.pool }), "smart wallet check"),
        mint ? io(getTokenNarrative({ mint }), "token narrative") : Promise.resolve(null),
        mint ? io(getTokenInfo({ query: mint }), "token info") : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates in parallel (bounded in /pool)
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => io(getActiveBin({ pool_address: pool.pool }), "active bin"))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    // ── Candidate selection → deterministic execution ───────────────
    // LLM screening is ONLY used when explicitly requested via the `/pool`
    // command (useLLM=true). Automatic cycles (cron / startup / opportunity poll)
    // use the deterministic scorer below — no model is consulted anywhere else.
    // In both cases the entry itself is executed 100% in code by deployCandidate().
    let selection;
    if (useLLM) {
      if (abortIfCancelled("before LLM selection")) return screenReport;
      const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;
      const candidateMenu = passing
        .map((_, i) => `#${i + 1}\n${candidateBlocks[i]}`)
        .join("\n\n");

      const { content } = await agentLoop(`
SCREENING ONLY — you do NOT execute trades.

${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy budget: ${deployAmount} SOL
${weightsSummary ? `\n${weightsSummary}\n` : ""}
PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateMenu}

TASK:
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick at most ONE best candidate based on narrative quality, smart wallets, and pool metrics.
3. Reply with ONLY a JSON object (no prose, no markdown fences):
   {"action":"DEPLOY","candidate":<number 1-${passing.length}>,"reason":"<2-4 concise sentences why this pool won and key risks>"}
   or
   {"action":"NONE","reason":"<2-4 concise sentences explaining why nothing was good enough>"}

Execution is handled deterministically by code after your choice: size, bins, slippage and
the transaction are NOT yours to decide. Never invent tool output.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 1024, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      selection = parseScreeningDecision(content, passing.length);
    } else {
      selection = selectCandidateDeterministically(passing);
    }
    log("screening", `Decision (${useLLM ? "LLM" : "deterministic"}): ${selection.action}${selection.index != null ? ` candidate #${selection.index + 1}` : ""} — ${selection.reason}`);

    if (selection.action !== "DEPLOY") {
      screenReport = [
        "⛔ NO DEPLOY",
        "",
        "Cycle finished with no valid entry.",
        "",
        "BEST LOOKING CANDIDATE",
        passing[0]?.pool?.name || "none",
        "",
        "WHY SKIPPED",
        selection.reason || "Screening selected no candidate.",
        "",
        "REJECTED",
        passing.map(({ pool }) => `- ${pool.name}`).join("\n"),
      ].join("\n");
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Screening selected no deploy",
        reason: stripThink(selection.reason || "").slice(0, 500),
        rejected: passing.slice(0, 5).map(({ pool }) => pool.name),
      });
    } else {
      // Last checkpoint: never place a position for a run the user already saw
      // time out (the token is flipped by the isolated task's deadline).
      if (abortIfCancelled("before deploy")) return screenReport;
      const candidate = passing[selection.index].pool;
      await liveMessage?.toolStart("deploy_position");
      try {
        const outcome = await deployCandidate(candidate, { walletBalanceSol: currentBalance.sol });
        await liveMessage?.toolFinish("deploy_position", outcome.result, true);
        screenReport = formatDeployReport(outcome, selection.reason);
        log("screening", `Deterministic deploy complete: ${candidate.name} (${outcome.deployAmount} SOL, ${outcome.binsBelow} bins below)`);
      } catch (error) {
        await liveMessage?.toolFinish("deploy_position", { error: error.message }, false);
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Deploy attempt did not succeed",
          reason: error.message,
          pool: candidate.pool,
          pool_name: candidate.name,
        });
        screenReport = `⛔ DEPLOY FAILED\n\n${candidate.name}\n${candidate.pool}\n\n${error.message}`;
      }
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
    // Queued user commands (/start, /status, …) must not be stranded after a cycle.
    drainTelegramQueue().catch(() => {});
  }
  return screenReport;
}

/**
 * Hourly health check — deterministic summary only. No LLM, no recommendations:
 * it reports portfolio numbers, the rule status of each open position and the
 * aggregate performance history.
 */
export async function runDeterministicHealthCheck({ silent = false } = {}) {
  const [positionResult, perf] = await Promise.all([
    getMyPositions({ force: true }).catch(() => null),
    Promise.resolve(getPerformanceSummary()),
  ]);
  const list = positionResult?.positions || [];
  const cur = config.management.solMode ? "◎" : "$";
  const totalValue = list.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
  const totalUnclaimed = list.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);
  const totalPnl = list.reduce((s, p) => s + (p.pnl_usd ?? 0), 0);

  const ruleLines = list.map((p) => {
    const decision = detectExit(p, config.management);
    const status = decision ? decision.headline || decision.name : "STAY";
    const range = p.in_range ? "IN" : `OOR ${p.minutes_out_of_range ?? 0}m`;
    return `- ${p.pair}: ${status} | PnL ${p.pnl_pct ?? "?"}% | ${range} | fees ${cur}${p.unclaimed_fees_usd ?? "?"}`;
  });

  const report = [
    "🩺 HEALTH CHECK (deterministic — no LLM)",
    `Positions: ${list.length}/${config.risk.maxPositions} | value ${cur}${totalValue.toFixed(4)} | unclaimed ${cur}${totalUnclaimed.toFixed(4)} | open PnL ${cur}${totalPnl.toFixed(4)}`,
    perf
      ? `Closed: ${perf.total_positions_closed} | win rate ${perf.win_rate_pct}% | avg PnL ${perf.avg_pnl_pct}% | total PnL $${perf.total_pnl_usd}`
      : "Closed: 0 (no performance history yet)",
    ...ruleLines,
  ].join("\n");

  log("cron", `Health check complete (deterministic): ${list.length} position(s)`);
  if (!silent && telegramEnabled()) await sendMessage(report).catch(() => {});
  return report;
}

export function startCronJobs() {
  // Idempotent: always tear down the previous timer set first. Combined with the
  // `_cronStarted` flag this guarantees that repeated calls (config reloads,
  // /resume, TTY + non-TTY boot paths) cannot leave several schedules running
  // in parallel — which is what made cycles appear to fire every few seconds.
  if (_cronStarted) log("cron", "Cron already running — restarting with the current schedule");
  stopCronJobs(); // stop any running tasks before (re)starting

  // Interval expressions are clamped to >= 1 minute and always 5-field, so a bad
  // config value can never produce a sub-minute (seconds) timer.
  const mgmtExpr = cronExprForInterval(config.schedule.managementIntervalMin, 10);
  const screenExpr = cronExprForInterval(config.schedule.screeningIntervalMin, 30);

  const mgmtTask = cron.schedule(mgmtExpr, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  // Bid-Ask Flipper — range rebalance / close engine, every 10m by default.
  // Holds the management lock so a flip can't overlap a management/poller close.
  let flipperTask = null;
  if (config.flipper?.enabled) {
    const flipIntervalMin = clampIntervalMin(config.flipper.intervalMin ?? 10, 10);
    flipperTask = cron.schedule(cronExprForInterval(flipIntervalMin, 10), async () => {
      if (_flipperBusy || _managementBusy) return;
      _flipperBusy = true;
      _managementBusy = true;
      try {
        const results = await checkAllPositionsForFlip();
        const executed = (results || []).filter((entry) => entry.executed);
        if (executed.length) {
          log("flipper_info", `Executed: ${executed.map((entry) => `${entry.pair || entry.pool || entry.position} ${entry.action}`).join(" | ")}`);
        }
      } catch (error) {
        log("flipper_error", `Flip cycle failed: ${error.message}`);
      } finally {
        _flipperBusy = false;
        _managementBusy = false;
      }
    });
  }

  // Screening cron — guarded by `isScreeningRunning()` + the dedupe window inside
  // `requestScreeningCycle`, so a tick that lands while a cycle is still active is
  // dropped instead of spawning a duplicate run.
  const screenTask = cron.schedule(screenExpr, () => {
    requestScreeningCycle({ reason: "cron" })
      .catch((error) => log("cron_error", `Cron screening failed: ${error.message}`));
  });

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check (deterministic)");
    try {
      await runDeterministicHealthCheck({ silent: true });
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // ── Hot Fees Opportunity digest — every 3h or 6h (config.screener.intervalHours) ──
  // The tick itself is *fire-and-forget*: `runHotDigestBroadcast()` is started and
  // the cron callback returns at once, so the 3 s PnL poller, the management
  // cycle and the Telegram poll loop never wait on the screener's network calls.
  // Snooze/Mute only silence this automatic path; /hot always runs on demand.
  let hotDigestTask = null;
  if (config.screener?.enabled !== false) {
    const hotIntervalHours = normalizeScreenerIntervalHours(config.screener?.intervalHours, 6);
    const hotExpr = cronExprForHours(hotIntervalHours, 6);
    hotDigestTask = cron.schedule(hotExpr, () => {
      if (isDigestSuppressed()) {
        const state = getSuppressionState();
        log("screener", `Hot Fees digest skipped — ${state.mode} for ${state.minutesLeft} more min`);
        return;
      }
      runHotDigestBroadcast({ reason: "cron" })
        .catch((error) => log("screener_warn", `Hot Fees digest tick failed: ${error?.message || error}`));
    }, { timezone: 'UTC' });
    log("cron", `Hot Fees digest scheduled — "${hotExpr}" (every ${hotIntervalHours}h)`);
  } else {
    log("cron", "Hot Fees digest disabled (screenerEnabled=false) — /hot still works on demand");
  }

  // Fast PnL poller — the real-time exit path between management cycles.
  // 100% deterministic 2-priority hierarchy: Priority 1 hard TP/SL (total PnL:
  // unrealized + claimable/claimed fees vs deposit) → Priority 2 range out (only
  // once hasEnteredRange is true). RSI/MACD/BB/Supertrend never close a position
  // and no candle data is fetched. Exits require `confirmTicks` consecutive
  // confirming polls (registerExitSignal) so a single noisy tick can't close a
  // position; a confirmed rule fires the close directly in code — no LLM, no
  // position data to a model.
  const pnlPollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    const trackedOpen = getTrackedPositions(true);
    if (trackedOpen.length === 0) return;
    const trackedByPosition = new Map(trackedOpen.map((t) => [t.position, t]));
    _pnlPollBusy = true;
    try {
      // Bounded read: if the RPC (pump.helius) and the Meteora API both fail — or
      // simply hang — the tick returns empty-handed instead of stalling the loop.
      const result = await withDeadline(
        getMyPositions({ force: true, silent: true }),
        POSITIONS_READ_TIMEOUT_MS,
        "pnl poll positions",
      ).catch((error) => {
        log("pnl_poll_warn", `Positions read failed (${error.message}) — keeping the loop alive`);
        return null;
      });
      if (result?.error) {
        log("pnl_poll_warn", `Positions unavailable: ${result.error}`);
        return;
      }
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        confirmPeak(p.position, p.pnl_pct, confirmTicks);
        const tracked = trackedByPosition.get(p.position) ?? null;
        // Sample the bin → price path for the closed-position PnL card.
        recordPriceSample(p.position, p.active_bin, tracked?.bin_step);
        // Monitoring tick: a position only earns Priority 2 once it traded in range.
        monitorPosition(p, { tracked });

        // Simplified 2-priority hierarchy — Priority 1 hard TP/SL (total PnL:
        // unrealized + claimable/claimed fees vs deposit) → Priority 2 range out
        // (only once hasEnteredRange is true). Synchronous local snapshot math:
        // no candle/Supertrend fetch, no indicators, no LLM.
        const decision = evaluatePositionExit(p);
        const signal = decision?.rule_key ?? null;

        // Require N consecutive confirming ticks before acting — a single noisy
        // tick can never close a position.
        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
        if (!decision || !fire) continue;

        log("rule_engine", `${formatExitLog(p.pair, decision)} — confirmed after ${confirmTicks} ticks`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        _managementBusy = true;
        try {
          const rpt = await executeRuleClose(p, decision);
          log("state", `[PnL poll] ${p.pair}: ${rpt || "closed"}`);
        } catch (e) {
          log("cron_error", `Poll-triggered close failed: ${e.message}`);
        } finally {
          _managementBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, pnlPollMs);

  // Opportunity poller — catches strong pools between the (slow) screening cycles.
  // Reuses the getTopCandidates pipeline (discovery + holder audit + filters + score);
  // when the best candidate clears the score pre-gate it triggers the deterministic
  // screening deploy path (runScreeningCycle), which re-checks guards and sizes in code.
  let opportunityPollInterval = null;
  if (config.opportunity.enabled) {
    const oppMs = Math.max(15, Number(config.opportunity.pollIntervalSec ?? 45)) * 1000;
    const oppCooldownMs = 5 * 60 * 1000; // don't re-trigger the deploy LLM more than every 5m
    let _opportunityPollBusy = false;
    opportunityPollInterval = setInterval(async () => {
      if (_screeningBusy || _managementBusy || _opportunityPollBusy) return;
      if (Date.now() - _screeningLastTriggered < oppCooldownMs) return;
      _opportunityPollBusy = true;
      try {
        const [positions, balance] = await Promise.all([
          getMyPositions({ force: true, silent: true }).catch(() => null),
          getWalletBalances().catch(() => null),
        ]);
        if (!positions || (positions.total_positions ?? 0) >= config.risk.maxPositions) return;
        const minRequired = config.management.deployAmountSol + config.management.gasReserve;
        if (process.env.DRY_RUN !== "true" && (!balance || balance.sol < minRequired)) return;

        const top = await getTopCandidates({ limit: config.opportunity.limit }).catch(() => null);
        const candidates = (top?.candidates || []).slice().sort((a, b) => degenScore(b, config.opportunity) - degenScore(a, config.opportunity));
        if (!candidates.length) return;

        const minScore = config.opportunity.minScore;
        const bonus = Number(config.opportunity.smartWalletScoreBonus ?? 0);
        const floor = minScore - bonus; // lowest degen that could qualify, only WITH a smart wallet

        // A pool qualifies if degen >= minScore, OR it's borderline (floor..minScore) AND a
        // tracked smart wallet sits on it (checkSmartWalletsOnPool, on-chain positions of our
        // tracked KOL list). The smart-wallet lookup runs only for borderline pools to keep
        // the 45s poll cheap.
        let trigger = null;
        for (const c of candidates) {
          const s = degenScore(c, config.opportunity);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
          if (bonus <= 0) continue; // borderline but smart-wallet rescue disabled
          const smart = (await checkSmartWalletsOnPool({ pool_address: c.pool }).catch(() => null))?.in_pool || [];
          if (smart.length > 0) { trigger = { c, s, smart }; break; }
        }
        if (!trigger) return;

        const smartTag = trigger.smart.length
          ? ` + smart wallet [${trigger.smart.map((w) => w.name || w.address?.slice(0, 4)).join(", ")}] (bar lowered ${minScore}→${floor})`
          : "";
        log("cron", `[Opportunity] ${trigger.c.name} degen ${trigger.s.toFixed(1)} >= ${trigger.smart.length ? floor : minScore}${smartTag} — triggering screening deploy decision`);
        // Single-flight + dedupe: never stacks on top of a cron/management cycle.
        requestScreeningCycle({ reason: "opportunity", silent: true, dedupeMs: oppCooldownMs })
          .catch((e) => log("cron_error", `Opportunity-triggered screening failed: ${e.message}`));
      } catch (e) {
        log("cron_error", `Opportunity poll failed: ${e.message}`);
      } finally {
        _opportunityPollBusy = false;
      }
    }, oppMs);
  }

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog, flipperTask, hotDigestTask].filter(Boolean);
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._opportunityPollInterval = opportunityPollInterval;
  _cronStarted = true;
  log("cron", `Cycles started — management "${mgmtExpr}", screening "${screenExpr}"${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}${config.screener?.enabled !== false ? `, hot digest every ${normalizeScreenerIntervalHours(config.screener?.intervalHours, 6)}h` : ""}`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

/**
 * `/pool` timeout fallback: the exact timeout notice plus a cheap metrics block
 * built from the last screening snapshot (no network calls, so it is always
 * available immediately after the deadline fires).
 */
async function sendPoolTimeoutFallback(reason = null) {
  await sendMessage(POOL_TIMEOUT_MESSAGE).catch(() => {});
  const { candidates, updatedAt } = getLatestCandidatesMeta();
  const fallback = formatBasicPoolMetrics(candidates, { updatedAt, reason });
  await sendMessage(fallback).catch(() => {});
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Strategy: ${config.strategy.strategy} | binsBelow: ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | default ${config.strategy.defaultBinsBelow}`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Strategy: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
    [settingButton("🏠 Main Menu", "cfg:main")],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";
  // The settings menu edits the same Telegram message the LP dashboard may own.
  forgetLpMessageView(msg.messageId);

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "main") {
    await answerCallbackQuery(msg.callbackQueryId);
    await showLpMainMenu({ msg, messageId: msg.messageId });
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/start — main dashboard (wallet, balances, LP shortcuts)",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — manage open positions (same card as /start → 📊 My Positions)",
    "/pool — run AI screening (LLM picks a candidate, code executes the entry)",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "   deterministic forms: \"tp 8%\", \"sl -20%\", \"close after 90m\", \"min yield 4%\"",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/hot — 🔥 Hot Fees digest (top fee-generating pools right now)",
    "/hot fresh — force a fresh Meteora ranking (ignores the cache)",
    "/hot <n> — digest with n pools (1-6)",
    "/screener — alias of /hot",
    "/lp — LP dashboard (positions, balances, trending, settings)",
    "/lp <token mint | pool address> — list every DLMM pool for a token CA, then deploy",
    "/deploy <n> — deploy candidate by cached index (deterministic)",
    "/deploy <pool address> — open the deploy menu pre-filled for that pool",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
    "",
    "Exits are 100% deterministic rule-engine driven — the LLM never closes positions.",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

/**
 * Deterministic candidate selector used by automatic screening cycles (no LLM).
 * Ranks every screened candidate by Degen Score (+ smart-wallet bonus) and only
 * deploys when the winner clears the configured auto-deploy floor.
 */
function selectCandidateDeterministically(passing) {
  if (!Array.isArray(passing) || passing.length === 0) {
    return { action: "NONE", reason: "No candidates passed filtering." };
  }

  const bonus = Number(config.opportunity?.smartWalletScoreBonus ?? 0);
  const minScore = Number(config.screening?.autoMinDegen ?? 0);
  let best = null;

  passing.forEach((entry, index) => {
    const rawDegen = Number(degenScore(entry.pool, config.opportunity));
    const degen = Number.isFinite(rawDegen) ? rawDegen : 0;
    const smartWallets = entry.sw?.in_pool?.length ?? 0;
    const score = degen + (smartWallets > 0 ? bonus : 0);
    if (!best || score > best.score) {
      best = { index, score, degen, smartWallets, name: entry.pool?.name || entry.pool?.pool || "candidate" };
    }
  });

  if (!best || best.score < minScore) {
    return {
      action: "NONE",
      reason: `Deterministic best score ${best ? best.score.toFixed(1) : "?"} < auto-deploy floor ${minScore}.`,
    };
  }

  return {
    action: "DEPLOY",
    index: best.index,
    reason: `Deterministic selection: ${best.name} scored highest (degen ${best.degen.toFixed(1)}${best.smartWallets ? `, ${best.smartWallets} smart wallet(s)` : ""}, score ${best.score.toFixed(1)} >= ${minScore}).`,
  };
}

/**
 * Extract the first balanced JSON object from a model response (ignores prose
 * before/after it and braces inside strings).
 */
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the screening LLM's JSON selection. The model only chooses a candidate
 * index — anything unparseable or out of range resolves to NONE (fail safe).
 * @param {string} content - raw model output
 * @param {number} candidateCount - number of candidates offered
 * @returns {{action: "DEPLOY"|"NONE", index?: number, reason: string}}
 */
function parseScreeningDecision(content, candidateCount) {
  const text = stripThink(content || "");

  const jsonText = extractFirstJsonObject(text);
  if (jsonText) {
    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(jsonText));
      } catch {
        parsed = null;
      }
    }
    if (parsed && typeof parsed === "object") {
      const action = String(parsed.action || "").toUpperCase();
      const reason = String(parsed.reason || "").slice(0, 600);
      const rawIndex = Number(parsed.candidate ?? parsed.index ?? parsed.pool_index);
      if (action === "DEPLOY" && Number.isFinite(rawIndex) && rawIndex >= 1 && rawIndex <= candidateCount) {
        return { action: "DEPLOY", index: Math.trunc(rawIndex) - 1, reason };
      }
      if (action === "NONE") return { action: "NONE", reason };
    }
  }

  // Fallback for models that ignore the JSON instruction.
  if (/⛔\s*NO DEPLOY/i.test(text)) return { action: "NONE", reason: text.slice(0, 600) };

  return {
    action: "NONE",
    reason: `Screening decision was not valid JSON — no deploy. Output: ${text.slice(0, 300) || "(empty)"}`,
  };
}

/**
 * Deterministic entry: size, bin width and every deploy parameter are computed
 * here. The screening LLM supplies only the candidate choice and its rationale.
 */
async function deployCandidate(candidate, { walletBalanceSol = null } = {}) {
  if (!candidate?.pool) throw new Error("deployCandidate: candidate is missing a pool address");

  const balanceSol = walletBalanceSol ?? (await getWalletBalances()).sol;
  const deployAmount = computeDeployAmount(balanceSol);
  const binsBelow = computeBinsBelow(candidate.volatility);

  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

/**
 * Deterministic Telegram-friendly report for a deploy. Range numbers come from
 * the deploy tool result — never from the LLM.
 */
function formatDeployReport({ candidate, result, deployAmount, binsBelow }, screeningReason = "") {
  const strategy = result?.strategy || config.strategy.strategy;
  const activeBin = result?.bin_range?.active ?? "?";
  const coverage = result?.range_coverage;

  if (result?.dry_run) {
    return [
      "🚀 DEPLOYED (DRY RUN)",
      "",
      candidate.name || "unknown",
      candidate.pool,
      "",
      `◎ ${deployAmount} SOL | ${strategy} | bins_below ${binsBelow}`,
      "No transaction sent (DRY_RUN=true).",
      screeningReason ? `\nWHY THIS WON (screening)\n${screeningReason}` : null,
    ].filter(Boolean).join("\n");
  }

  return [
    "🚀 DEPLOYED",
    "",
    candidate.name || "unknown",
    candidate.pool,
    "",
    `◎ ${deployAmount} SOL | ${strategy} | bin ${activeBin}`,
    result?.price_range ? `Range: ${result.price_range.min} → ${result.price_range.max}` : null,
    coverage
      ? `Range cover: ${fmtPct(coverage.downside_pct)} downside | ${fmtPct(coverage.upside_pct)} upside | ${fmtPct(coverage.width_pct)} total`
      : null,
    `Position: ${result?.position || "n/a"}`,
    result?.txs?.length ? `Tx: ${result.txs[0]}` : null,
    screeningReason ? `\nWHY THIS WON (screening)\n${screeningReason}` : null,
  ].filter(Boolean).join("\n");
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  return deployCandidate(candidate);
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

/**
 * Replay commands that arrived while a cycle was running.
 * Each item is isolated: one failing command can never block the rest of the
 * queue (and the queue is always bounded by `telegramHandler`).
 */
async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    try {
      await telegramHandler(queued);
    } catch (error) {
      log("telegram_error", `Queued command failed: ${error.message}`);
    }
  }
}

/**
 * Route one `scr:*` inline-button callback from the digest.
 *
 *   open:<n>    → open the existing deploy menu pre-filled with that pool address
 *   refresh     → force a fresh ranking and edit the message in place
 *   snooze:<h>  → silence automatic digests for h hours (/hot still works)
 *   mute:<h>    → same, longer default
 *   resume      → clear the suppression immediately
 *   help        → explain the digest
 */
async function handleScreenerCallback(msg) {
  const parsed = parseScreenerCallback(msg?.callbackData ?? msg?.text);
  if (!parsed) {
    await answerCallbackQuery(msg?.callbackQueryId, "Unknown Hot Fees action").catch(() => {});
    return;
  }
  const { action, index, hours } = parsed;
  const settings = getScreenerSettings();

  if (action === "open") {
    const pool = resolveHotPool(index);
    if (!pool) {
      await answerCallbackQuery(msg?.callbackQueryId, "Pool left the digest — tap 🔄 Refresh").catch(() => {});
      return;
    }
    await answerCallbackQuery(msg?.callbackQueryId, `Opening ${pool.pair}`).catch(() => {});
    // Hand-off into the existing deploy menu, pre-filled with this pool address:
    // `openPoolByAddress` presents the pool dashboard (Quick Zap / amount / range /
    // strategy → Deploy) exactly as `/lp <pool address>` would. Nothing is signed
    // until the operator confirms in that menu.
    const opened = await openLpPoolByAddress(msg, pool.pool, { quiet: true }).catch((error) => {
      log("screener_warn", `Open digest pool failed (${pool.pool.slice(0, 8)}): ${error?.message || error}`);
      return false;
    });
    if (!opened) await openLpAddressQuery(msg, pool.pool).catch(() => {});
    return;
  }

  if (action === "refresh") {
    await answerCallbackQuery(msg?.callbackQueryId, "Refreshing…").catch(() => {});
    invalidateHotDigest();
    await handleHotDigestCommand(msg, { editMessageId: msg?.messageId ?? null, force: true });
    return;
  }

  if (action === "snooze" || action === "mute") {
    const fallbackHours = action === "mute" ? settings.muteHours : settings.snoozeHours;
    const state = suppressDigest(hours ?? fallbackHours, action);
    const label = action === "mute" ? "Muted" : "Snoozed";
    await answerCallbackQuery(msg?.callbackQueryId, `${label} for ${state.hours}h`).catch(() => {});
    // Re-render from the cache (no network): the header gains the suppression
    // note and the keyboard swaps Snooze/Mute for 🔔 Resume. Uses the
    // lock-free re-render so a background digest in flight can't swallow the tap.
    await reRenderHotDigest(msg);
    return;
  }

  if (action === "resume") {
    clearDigestSuppression();
    await answerCallbackQuery(msg?.callbackQueryId, "Automatic digests resumed").catch(() => {});
    await reRenderHotDigest(msg);
    return;
  }

  if (action === "help") {
    await answerCallbackQuery(msg?.callbackQueryId).catch(() => {});
    await sendMessage([
      "🔥 Hot Fees digest",
      "",
      "Open n — load that pool in the deploy menu (nothing is signed until you confirm).",
      "🔄 Refresh — force a fresh Meteora ranking now.",
      "😴 Snooze / 🔕 Mute — pause the automatic digest (on-demand /hot still works).",
      "🔔 Resume — turn the automatic digest back on.",
      "",
      "Manual: /hot · /hot fresh · /hot <n> · /screener",
    ].join("\n")).catch(() => {});
    return;
  }

  await answerCallbackQuery(msg?.callbackQueryId, "Unsupported action").catch(() => {});
}

/**
 * Manual Hot Fees digest — `/hot` and `/screener` (aliases).
 *
 *   /hot             cache-first (instant when the snapshot is younger than the TTL)
 *   /hot fresh       force a network refresh
 *   /hot 5           top 5 pools (clamped 1..6 by the service)
 *   /hot fresh 2     forced refresh, 2 pools
 *
 * Callback re-renders pass explicit `force`/`limit` options so digits inside
 * callback data (`scr:snooze:6`) can never be mistaken for a pool count.
 *
 * Runs on the Telegram dispatch path, which `telegram.js` already executes
 * without awaiting the poll loop — a slow Meteora response can never block the
 * next command or the 3 s PnL poller.
 */
async function handleHotDigestCommand(msg, { editMessageId = null, force = null, limit = null } = {}) {
  const text = String(msg?.text ?? "").trim();
  const isCallback = msg?.isCallback === true;
  const resolvedForce = force ?? (!isCallback && /\b(fresh|force)\b/i.test(text));
  const limitArg = isCallback
    ? null
    : text
        .split(/\s+/)
        .slice(1)
        .find((token) => /^\d+$/.test(token));
  const resolvedLimit = limit ?? (limitArg ? Number(limitArg) : undefined);

  if (_hotDigestBusy) {
    await answerCallbackQuery(msg?.callbackQueryId, "Digest already building — one moment").catch(() => {});
    return null;
  }

  _hotDigestBusy = true;
  try {
    const message = await buildHotDigestMessage({
      force: resolvedForce,
      limit: resolvedLimit,
      intervalHours: config.screener?.intervalHours,
    });
    const targetId = editMessageId ?? null;
    if (targetId) {
      const edited = await editHTMLWithButtons(message.html, targetId, message.keyboard);
      if (!edited) await sendHTMLWithButtons(message.html, message.keyboard);
    } else {
      await sendHTMLWithButtons(message.html, message.keyboard);
    }
    _hotDigestLastSentAt = Date.now();
    return message;
  } catch (error) {
    log("screener_warn", `Hot Fees digest (manual) failed: ${error?.message || error}`);
    await sendMessage(`⚠️ Hot Fees digest unavailable: ${error?.message || error}`).catch(() => {});
    return null;
  } finally {
    _hotDigestBusy = false;
  }
}

/**
 * Re-render the digest in place after a Snooze/Mute/Resume tap.
 *
 * Deliberately bypasses the `_hotDigestBusy` lock: these callbacks must always
 * refresh the keyboard (Snooze/Mute → 🔔 Resume), and the underlying
 * `buildHotDigestMessage({ force: false })` is cache-first, so a fresh snapshot
 * costs zero network calls and a stale one is de-duplicated by the service's
 * single-flight guard.
 *
 * @returns {Promise<object|null>} the rebuilt message, or null on failure
 */
async function reRenderHotDigest(msg) {
  try {
    const message = await buildHotDigestMessage({
      force: false,
      intervalHours: config.screener?.intervalHours,
    });
    const targetId = msg?.messageId ?? null;
    if (targetId) {
      const edited = await editHTMLWithButtons(message.html, targetId, message.keyboard);
      if (!edited) await sendHTMLWithButtons(message.html, message.keyboard);
    } else {
      await sendHTMLWithButtons(message.html, message.keyboard);
    }
    return message;
  } catch (error) {
    log("screener_warn", `Hot Fees digest re-render failed: ${error?.message || error}`);
    return null;
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (msg?.isCallback && text.startsWith(SCREENER_CALLBACK_PREFIX)) {
    // 🔥 Hot Fees digest buttons (`scr:open:1`, `scr:refresh`, `scr:snooze:6`,
    // `scr:mute:24`, `scr:resume`). Routed before lp:/cfg: so the digest never
    // depends on the LP menu's in-memory session state.
    try {
      await handleScreenerCallback(msg);
    } catch (e) {
      log("screener_warn", `Hot Fees callback failed: ${e?.message || e}`);
      await answerCallbackQuery(msg.callbackQueryId, String(e?.message || "Hot Fees error").slice(0, 180)).catch(() => {});
    }
    return;
  }
  if (msg?.isCallback && text.startsWith("lp:")) {
    // Dashboard hub + every sub-view (`lp:main`, `lp:positions`, `lp:balance`,
    // `lp:new_position`, `lp:trending`, `lp:calendar`, `lp:chain`, `lp:wallet`,
    // `lp:damm`, `lp:referrals`, `lp:donate`, `lp:help`, …) is routed here.
    try {
      await handleLpCallback(msg);
    } catch (e) {
      log("telegram_error", `LP callback failed: ${e.message}`);
      await answerCallbackQuery(msg.callbackQueryId, String(e.message || "LP menu error").slice(0, 180)).catch(() => {});
    }
    return;
  }
  if (!msg?.isCallback) {
    try {
      if (await handleLpText(msg)) return;
    } catch (e) {
      log("telegram_error", `LP text input failed: ${e.message}`);
      await sendMessage(`LP menu error: ${e.message}`).catch(() => {});
      return;
    }
  }
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (text === "/start" || text === "/dashboard" || text === "/lp") {
    try {
      await showLpMainMenu({ msg });
    } catch (e) {
      log("telegram_error", `LP dashboard failed: ${e.message}`);
      await sendMessage(`LP menu error: ${e.message}`).catch(() => {});
    }
    return;
  }
  if (text === "/zap" || text === "/newposition") {
    try {
      await showNewPositionView({ msg });
    } catch (e) {
      log("telegram_error", `LP new-position view failed: ${e.message}`);
      await sendMessage(`LP menu error: ${e.message}`).catch(() => {});
    }
    return;
  }
  if (text === "/pools") {
    try {
      await showPoolListView({ msg });
    } catch (e) {
      log("telegram_error", `LP menu failed: ${e.message}`);
      await sendMessage(`LP menu error: ${e.message}`).catch(() => {});
    }
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the position management view (TP/SL · slippage · claim · rebalance · close).`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/positions") {
    // Unified with `/start` → 📊 My Positions: the SAME position-management
    // card (per-position TP/SL · slippage · collect fees · rebalance · close)
    // and the same `buildPositionsKeyboard()` inline controls. The legacy
    // tree/ASCII layout is no longer reachable from this command.
    try {
      await showPositionsView(msg, { force: true });
    } catch (e) {
      await sendMessage(isTimeoutError(e) ? TIMEOUT_MESSAGE : `Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  // /pool (no argument) — the ONLY LLM-assisted workflow: candidate screening.
  //
  // The ENTIRE run (LLM selection, token recon, smart-wallet lookups, deploy
  // sizing) executes as an isolated task raced against an absolute 8 s deadline.
  // If it is not done by then the handler aborts the wait, answers the user with
  // the timeout notice + cached metrics, and lets the detached task finish in the
  // background — so `/start` and every other command stay responsive.
  if (text === "/pool" || text.toLowerCase() === "/pool screen") {
    await sendMessage("🔍 Screening started — LLM selects a candidate, code executes the entry.").catch(() => {});
    // Cancellation token: when the 8 s budget expires the cycle is told to stop,
    // so the detached run can never deploy after the user was told it timed out.
    const abortToken = createAbortToken();
    const outcome = await runIsolatedTask(
      // `silent` keeps the detached cycle from posting its own report later; this
      // handler owns the single, deadline-bounded reply.
      () => runScreeningCycle({
        useLLM: true,
        silent: true,
        ioTimeoutMs: NETWORK_TIMEOUT_MS,
        abortToken,
      }),
      { timeoutMs: POOL_TIMEOUT_MS, label: "pool screening", onDeadline: () => abortToken.abort() },
    );

    if (outcome.timedOut) {
      await sendPoolTimeoutFallback("LLM/RPC slow");
      return;
    }
    if (!outcome.ok) {
      const e = outcome.error;
      await sendMessage(isTimeoutError(e) ? TIMEOUT_MESSAGE : `Error: ${e?.message || e}`).catch(() => {});
      return;
    }
    const report = typeof outcome.value === "string" ? outcome.value.trim() : "";
    if (report) {
      await sendMessage(`🔍 Screening Cycle\n\n${stripThink(report)}`).catch(() => {});
    }
    return;
  }

  // /pool <mint | pool address> — read-only pool lookup (no LLM). Same 8 s
  // isolation so a slow RPC/Meteora call degrades to the metrics fallback.
  const poolAddressMatch = text.match(/^\/pool\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (poolAddressMatch) {
    const outcome = await runIsolatedTask(
      () => openLpAddressQuery(msg, poolAddressMatch[1]),
      { timeoutMs: POOL_TIMEOUT_MS, label: "pool lookup" },
    );
    if (outcome.timedOut) {
      await sendPoolTimeoutFallback("pool lookup slow");
      return;
    }
    if (!outcome.ok) {
      await sendMessage(isTimeoutError(outcome.error) ? TIMEOUT_MESSAGE : `Error: ${outcome.error?.message}`).catch(() => {});
    }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await withDeadline(
        getMyPositions({ force: true }),
        NETWORK_TIMEOUT_MS,
        "positions read",
      );
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(isTimeoutError(e) ? TIMEOUT_MESSAGE : `Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
        // Closed positions get the Zenith-style PnL card (open ones stay text-only).
        // Detached: the summary above is already on the wire, the PNG renders and
        // uploads in the background under a 5 s deadline.
        dispatchClosedPositionPnlCard(pos, result);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
          if (result.success) {
            // Per-position card, detached — the loop never waits for the canvas.
            dispatchClosedPositionPnlCard(pos, result);
          }
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  // 🔥 Hot Fees digest — manual/on-demand execution. `/screener` is an alias.
  // `/hot fresh` forces a network refresh; `/hot 5` selects the pool count.
  if (/^\/(?:hot|screener)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
    await handleHotDigestCommand(msg);
    return;
  }

  // `/deploy <pool address>` — pre-fill the deployment menu for one specific
  // pool. This is what the Hot Fees digest's `Open n` buttons ultimately call:
  // the digest only resolves index → address and hands it over here. Nothing is
  // signed by this command; it opens the pool dashboard (Quick Zap / amount /
  // range / strategy → Deploy) exactly like `/lp <pool address>`.
  const deployAddressMatch = text.match(/^\/deploy\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/i);
  if (deployAddressMatch) {
    const address = deployAddressMatch[1];
    try {
      const opened = await openLpPoolByAddress(msg, address, { quiet: true }).catch((error) => {
        log("screener_warn", `Deploy address open failed (${address.slice(0, 8)}): ${error?.message || error}`);
        return false;
      });
      if (!opened) await openLpAddressQuery(msg, address);
    } catch (e) {
      log("telegram_error", `Deploy address failed: ${e.message}`);
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  // ── Deterministic execution boundary ─────────────────────────────
  // Free-form chat may explain data, but it can never execute an entry or exit.
  // Those are rule-engine / deterministic-command only (no LLM in the loop).
  const isQuestion = /^\s*(why|what|how|when|which|did|does|is|are|can|could|should|explain|show|list|tell)\b/i.test(text);
  if (!isQuestion && /\b(close|sell|exit|withdraw)\b/i.test(text)) {
    await sendMessage("Exits are executed by the deterministic rule engine only. Use /positions then /close <n>, or /closeall.").catch(() => {});
    return;
  }
  if (!isQuestion && /\b(deploy|open position|lp into|add liquidity)\b/i.test(text)) {
    await sendMessage("Entries are deterministic. Use /pool to run screening (LLM picks the candidate, code executes the deploy) or /deploy <n>.").catch(() => {});
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const agentRole = "GENERAL";
    const agentModel = config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  // Degen Score is the conviction signal for a solo deploy. Smart wallet is NO LONGER a
  // gate here — it's a confidence boost surfaced to the LLM, not a requirement.
  const degen = degenScore(pool, config.opportunity);
  const degenStrong = degen >= (config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);

  // Hard fundamental gates — no override.
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }

  // PVP conflict needs strong conviction (degen) to deploy solo.
  if (pool.is_pvp && !degenStrong) {
    return `PVP symbol conflict without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  // Conviction: a solo deploy needs a narrative OR a strong degen score.
  if (!hasNarrative && !degenStrong) {
    return `only candidate has no narrative and weak degen score (${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${DEPLOY}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync(repoPath("lessons.json"), "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      // Goes through the same single-flight guard as every other trigger.
      await requestScreeningCycle({ reason: "startup", dedupeMs: 0 });
    } catch (e) {
      log("startup_error", e.message);
    }
  })(); 
}

/**
 * Enhanced pool command handler with Evil Panda analysis.
 *
 * Reporting only — the screening criteria and recommended DLMM parameters are
 * informational. RSI/MACD confluence no longer closes positions (see exit-rules.js).
 * @param {Object} pool - Pool data
 */
async function sendEvilPandaPoolAnalysis(pool) {
  try {
    if (!pool) return;

    // Evaluate pool against Evil Panda criteria
    const pandaResult = evaluateEvilPandaCandidate(pool);
    const reasons = Array.isArray(pandaResult.reasons) ? pandaResult.reasons : [];
    const recommendedParams = getEvilPandaRecommendedParams(pool);
    const poolLabel = pool.name || `${String(pool.pool_address || "").slice(0, 8)}...`;

    // Format the analysis results
    let analysis = `🐼 Evil Panda Analysis for ${poolLabel}\n`;

    // Screening criteria results
    analysis += `\n🎯 Screening Criteria:\n`;
    for (const reason of reasons) {
      analysis += `  • ${reason}\n`;
    }

    // Overall pass/fail
    analysis += `\n📌 Overall: ${pandaResult.passed ? "✅ PASS" : "❌ FAIL"}\n`;

    // Recommended parameters
    analysis += `\n🎯 Recommended DLMM Parameters:\n`;
    analysis += `  • Strategy: ${recommendedParams.strategy}\n`;
    analysis += `  • Range: ${recommendedParams.rangeMinPercent}% to ${recommendedParams.rangeMaxPercent}%\n`;
    analysis += `  • Bin Steps: ${(recommendedParams.bins || []).join(", ")}\n`;

    // Send analysis to Telegram
    await sendMessage(analysis).catch((error) => {
      log("telegram_error", `Failed to send Evil Panda analysis: ${error.message}`);
    });
  } catch (error) {
    log("error", `Error sending Evil Panda pool analysis: ${error.message}`);
  }
}
