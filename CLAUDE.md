# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

> **Audience**: future agents/sessions that need to make non-trivial changes
> (add a tool, change a safety rule, fix a cron race, extend a state file)
> without re-reading the whole repo. The README stays user-facing; this
> file is the engineering manual.

---

## TL;DR (read this first)

- **What it is**: Node 22+ ESM service that runs an LLM-driven loop
  (OpenAI-compatible) to screen Meteora DLMM pools, deploy SOL into
  long/short positions, monitor them, and close them — all without a human
  in the loop. Telegram + Discord provide ops surface; HiveMind provides
  shared learning.
- **Entry points**: `node index.js` (full daemon — REPL + cron + Telegram),
  `node cli.js <cmd>` (one-shot CLI), `node setup.js` (first-run wizard).
- **Two agent roles run automatically**:
  - `SCREENER` — every `screeningIntervalMin` minutes, picks a pool,
    calls `deploy_position`.
  - `MANAGER` — every `managementIntervalMin` minutes, evaluates open
    positions, claims/closes them.
- **`GENERAL`** role handles ad-hoc chat (REPL, Telegram, Claude Code
  slash commands) and dispatches to a role-filtered tool subset based on
  intent-pattern matching of the user's goal.
- **All state lives in JSON files at the repo root** — see
  [§ Persistent files](#persistent-files) below. There is no DB.
- **"Always first read the rest of this file"** — there are real
  cross-cutting invariants (lazy SDK load, ONCE_PER_SESSION tool locks,
  position-cache TTL, trailing-TP 15s recheck) that are easy to break.

---

## Architecture

```
                ┌──────────────────────────────────────────────┐
                │              index.js  (daemon)              │
                │  REPL + cron + Telegram bot + PnL poller    │
                │  Health check + briefing + HiveMind HB      │
                └────────────┬─────────────────────────────────┘
                             │
            ┌────────────────┼────────────────────┐
            ▼                ▼                    ▼
       runScreeningCycle  runManagementCycle  cron (every N min)
            │                │                    │
            └────────┬───────┘                    │
                     ▼                            │
                 agentLoop() ◀────────────────────┘
                  (ReAct)               (telegram / REPL messages)
                     │
                     ▼
              buildSystemPrompt(role, …)  →  LLM  →  tool calls
                                                       │
                                                       ▼
                                                executeTool(name, args)
                                                       │
                                                       ▼
                                              PROTECTED_TOOLS →
                                              runSafetyChecks()
                                                       │
                                                       ▼
                                                toolMap[name](args)
                                                       │
                                  ┌────────────────────┴──────────┐
                                  ▼                                ▼
                       tools/dlmm.js (SDK)               tools/wallet.js (Jupiter)
                       tools/screening.js                tools/token.js (Jupiter)
                       tools/study.js (LPAgent)         tools/agent-meridian.js
                                                      tools/chart-indicators.js
                                  │                                │
                                  └──────── on-chain + 3rd-party APIs ─┘
```

### Module responsibilities (read me before editing)

| File | Lines | Purpose |
|---|---:|---|
| **Entry / orchestration** | | |
| `index.js` | ~2500 | Daemon. Cron, REPL, Telegram bot, briefing, HiveMind bootstrap, PnL poller, deterministic exit execution, single-candidate skip rule, settings menu. **All** automatic cycles start here. Cron is idempotent + minute-granular (`cronExprForInterval`, `_cronStarted`), every screening trigger goes through `requestScreeningCycle()` (single-flight `isScreeningRunning()` + dedupe window), `/pool` runs as an 8 s isolated task (`runIsolatedTask`, cancellable via `createAbortToken`), and every position read is bounded (`POSITIONS_READ_TIMEOUT_MS`). |
| `exit-rules.js` | ~420 | **The only exit engine — a strict 3-step hierarchy.** Priority 1 TP/SL (1 stop-loss, 2 take-profit, 3 trailing TP), Priority 2 range bounds (4 far above, 5 far below), Priority 3 Supertrend 15m 1-candle break (6). `detectExit()` runs the range-entry tick (`monitorPosition`) and evaluates 1–2 synchronously; `evaluateSupertrendExit()` is the priority-3 safety net. **Priority 2 is guarded by `hasEnteredRange`**: while the flag is `false` (position has never traded inside its bounds) `evaluateExitHierarchy()` returns `null` from the Priority 2 block, so a below-price limit order is never cancelled before it fills (only an explicit `false` blocks — legacy records without the field keep the old behaviour). `formatExitLog()` emits `[EXIT] Priority N: <reason> — <pair>`. RSI/MACD/Bollinger are **not** exit inputs. No LLM imports. |
| `agent.js` | 416 | `agentLoop(goal, maxSteps, history, agentType, model, maxOut, opts)`. The ReAct loop. Provider fallback, JSON repair, once-per-session tool locks, no-tool retries, `onToolStart`/`onToolFinish` callbacks for live Telegram messages. |
| `cli.js` | 676 | One-shot CLI; every tool exposed as a subcommand. Also writes a `~/.meridian/SKILL.md` at startup for agent discovery. Loads `.env`/`user-config.json` from `~/.meridian/` if present, else from cwd. |
| `setup.js` | ~750 | Interactive first-run wizard. Three presets (degen/moderate/safe) + custom. Covers strategy, screening filters, position sizing, trailing TP, per-role models. |
| **Config & state** | | |
| `config.js` | 278 | Loads `user-config.json` → live `config` object. Sections: `risk`, `screening`, `management`, `strategy`, `schedule`, `llm`, `darwin`, `tokens`, `hiveMind`, `api`, `jupiter`, `indicators`. Exposes `computeDeployAmount(walletSol)`, `reloadScreeningThresholds()`. `MIN_SAFE_BINS_BELOW = 35` (exported). |
| `prompt.js` | 176 | `buildSystemPrompt(agentType, …)`. Three role-specific prompts. SCREENER is screening-only and must answer with a JSON selection (no deploy). MANAGER/GENERAL are read/report-only — no close/entry tools. |
| **Tools layer** | | |
| `tools/definitions.js` | 1124 | OpenAI-format tool schemas. **Source of truth for what the LLM sees.** All 40+ tool names listed. |
| `tools/executor.js` | 844 | `executeTool(name, args)`. Pre-flight safety checks for `PROTECTED_TOOLS = {deploy, claim, close, swap, self_update}`. Validates pool thresholds via fresh pool discovery call before deploy. Post-tool side-effects: telegram notifications, pool-memory auto-annotation on `low yield` close, auto-swap base→SOL on close. |
| `tools/dlmm.js` | huge | Meteora DLMM SDK wrapper. **Lazy-loads** `@meteora-ag/dlmm` to avoid CJS-import-time crash in DRY_RUN/test. Pool cache (5 min), metadata cache (15 min), positions cache (5 min TTL + inflight dedup). `deployPosition`, `getMyPositions`, `getPositionPnl`, `getActiveBin`, `closePosition`, `claimFees`, `searchPools`, `getWalletPositions`, `addLiquidity`, `withdrawLiquidity`. Also has relay-mode (zap-in via LPAgent) and wide-range path (multi-tx `createExtendedEmptyPosition` + `addLiquidityByStrategyChunkable` for >69 bin ranges). Asserts Meteora bin-array initialization rent never charged. |
| `tools/screening.js` | 862 | `discoverPools`, `getTopCandidates` (hard filter + enrich + score), `getPoolDetail`. Scoring = `fee_tvl*1000 + organic*10 + vol/100 + holders/100`. Has Discord signal merge/only modes, PVP-rival detection. |
| `tools/wallet.js` | 251 | `getWalletBalances` (Helius), `swapToken` (Jupiter Swap V2). `normalizeMint` collapses "SOL"/"native"/any So1-prefixed token to wrapped-SOL. Built-in referral: 50 bps to a fixed address (configurable). |
| `tools/token.js` | 209 | `getTokenInfo` (Jupiter datapi), `getTokenHolders` (top 100 + filter pool-tagged), `getTokenNarrative` (Jupiter ChainInsight). Cross-references smart wallets from `smart-wallets.json`. |
| `tools/study.js` | 152 | `studyTopLPers` → Agent Meridian `/top-lp` + `/study-top-lp`. Returns ranked LPer patterns (avg hold, win rate, preferred strategy). |
| `tools/agent-meridian.js` | 110 | `agentMeridianJson(path, opts)` with retry/backoff. Default base = `https://api.agentmeridian.xyz/api`. |
| `tools/chart-indicators.js` | ~380 | `confirmIndicatorPreset({mint, side})` — entry gate. Eight presets: `supertrend_break`, `rsi_reversal`, `bollinger_reversion`, `rsi_plus_supertrend`, `supertrend_or_rsi`, `bb_plus_rsi`, `fibo_reclaim`, `fibo_reject`. `fetchSupertrend15m(mint)` — 15m Supertrend snapshot for exit priority 3 (60 s cache, Supertrend fields only). Fetches from Agent Meridian `/chart-indicators/{mint}`. |
| **Persistence (all `.json` at repo root)** | | |
| `state.js` | 560 | `trackPosition` (new positions start with `has_entered_range: false`), `markOutOfRange/InRange`, `markRangeEntered` (one-way Priority 2 arming used by `services/positionMonitor.js`), `hasEnteredRange`, `recordClaim`, `recordClose`, `setPositionInstruction`, `updatePnlAndCheckExits` (the deterministic rules: STOP_LOSS, TRAILING_TP, OUT_OF_RANGE, LOW_YIELD), `getStateSummary`. `syncOpenPositions` reconciles local state with on-chain after 5 min grace. |
| `pool-memory.js` | 405 | Per-pool deploy history + rolling 48-snapshot trend (5min × 4h). Computes `avg_pnl_pct`, `win_rate`, `adjusted_win_rate` (excludes OOR pumps). Cooldown logic: low yield → 4h pool cooldown, 3× OOR closes → 12h pool+token cooldown, optional repeat-deploy cooldown (configurable trigger count/hours/min fee yield/scope). `recordPositionSnapshot`, `recallForPool` for prompt injection. |
| `lessons.js` | 765 | `recordPerformance(perf)` called by executor after `close_position`. Builds lesson string (PREFER/AVOID/WORKED/FAILED). Pinned + role-tagged lesson injection (3-tier cap: PINNED, ROLE, RECENT) with `ROLE_TAGS` map. `evolveThresholds` adjusts `minOrganic` (auto), and writes `[AUTO-EVOLVED @ N]` lesson + applies to live `config`. **Known bug: also references `maxVolatility` and `minFeeTvlRatio` which don't exist in config — no-op for those keys.** `pushHiveLesson`/`pushHivePerformanceEvent` are fire-and-forget. |
| `decision-log.js` | 68 | Rolling 100-entry log. Types: `deploy` / `close` / `skip` / `no_deploy`. Each entry: actor, pool, summary, reason, risks[], metrics{}, rejected[]. Surfaced via `get_recent_decisions` tool and `getDecisionSummary()` in the prompt. |
| `signal-tracker.js` | 87 | In-memory 10-min staging for screening-time signals (`organic_score`, `fee_tvl_ratio`, …). Cleared on deploy or TTL. **Not persisted** — fine because the staged snapshot is also written to `state.json` via `trackPosition({ signal_snapshot })`. |
| `signal-weights.js` | 330 | Darwinian signal weighting. Recalculates every 5 closes (or 10-sample min). Splits signals into quartiles; top → `weight*1.05`, bottom → `weight*0.95`. Persists `signal-weights.json`. `getWeightsSummary()` injected into SCREENER prompt. |
| `strategy-library.js` | 227 | Saved LP strategies. Five defaults preloaded: `custom_ratio_spot`, `single_sided_reseed`, `fee_compounding`, `multi_layer`, `partial_harvest`. `getActiveStrategy()` → used in SCREENER prompt. |
| `smart-wallets.js` | 103 | Tracked KOL/alpha wallets. `type: "lp"` (default) checks positions; `type: "holder"` only checks token holdings. 5-min position cache. `check_smart_wallets_on_pool` is the deployment confidence signal. |
| `token-blacklist.js` | 103 | Mint → reason. Hard-filtered before LLM in `getTopCandidates`. |
| `dev-blocklist.js` | 66 | Deployer wallet → reason. Hard-filtered before LLM, fetched from Jupiter dev field. |
| `hivemind.js` | 346 | Agent Meridian shared learning. `bootstrapHiveMind` on startup, `startHiveMindBackgroundSync` every 15 min. Pushes lessons + performance events; pulls shared lessons + presets. `getSharedLessonsForPrompt` → injected under `── HIVEMIND ──` in prompt. Failures are non-blocking. |
| **Integrations** | | |
| `telegram.js` | ~700 | `startPolling(onMessage)`, `stopPolling()`. Long-poll (40 s socket abort) that **acks every callback query immediately** and **dispatches each update without awaiting it** (`dispatchUpdate`), so a slow `/pool` can never block `/start`. Failures retry with exponential backoff + jitter (`pollBackoffMs`, 1 s → 60 s) and the loop auto-restarts if it ever exits (`_pollLoopActive`). All Bot API calls go through `telegramFetch` (`AbortSignal.timeout`) so a stalled connection cannot wedge the bot. `createLiveMessage` returns a handle with `toolStart/toolFinish/note/finalize/fail` for live progress. Sends deploy/close/swap/OOR notifications. Auth: `isAuthorizedIncomingMessage` (chatId match + group→allowed user IDs). Registers `/help` `/status` `/positions` `/close` `/closeall` `/set` `/settings` `/setcfg` `/screen` `/candidates` `/lp` `/deploy` `/briefing` `/hive` `/pause` `/resume` `/stop` via `setMyCommands`. |
| `services/meteoraService.js` | 646 | **Manual DLMM path.** `openDlmmPosition({ poolAddress, amountSol, downsidePct, upsidePct, strategy })` → `DLMM.create` → `computeBinRange` (percent → `minBinId`/`maxBinId`) → strategy legs (`spot`/`bid_ask`/`curve`; composites split 50/50 across two positions) → bin-array rent guard → `initializePositionAndAddLiquidityByStrategy` (≤69 bins) or `createExtendedEmptyPosition` + `addLiquidityByStrategyChunkable` → `sendAndConfirmTransaction` → `trackPosition` + decision log. Read helpers: `getPoolSnapshot`, `getPoolMetadata`, `assertBinArraysCovered`. Upside ranges zap half the SOL into token X via Jupiter first. Gated by `DRY_RUN` / `ENABLE_LIVE_TRADING`. |
| `services/lp-menu.js` | ~2000 | **Interactive LP Telegram UI** (`/lp`). Screening view with inline pool buttons → pool dashboard (Quick Zap, liquidity amount, range, strategy) → Continue → Deploy. Holds per-chat sessions, routes `lp:*` callbacks, consumes custom text input (amount / range / pasted pool address), resolves `%` amounts against the live balance minus `gasReserve`, enforces `maxDeployAmount`, `minSolToOpen` and the gas reserve before calling `openDlmmPosition`. **Every RPC / Meteora / Jupiter / canvas call is bounded at 5 s** (`networkDeadline`); on a timeout the view degrades with `⚠️ Network timeout, please try again` instead of hanging. Open positions are **text-only**: `formatRangeStatus` (bold `🟢 IN RANGE` / `🔴 OUT OF RANGE`), `computeRangePositionPct` + `renderRangeBar` (`📍 Range Position: 65% [██████░░░░]`, single-sided SOL limit ranges clamp correctly) and `enrichPositionsWithMarketCap` (`🧢 MC: $1.25M`, Jupiter token stats, best-effort). |
| `services/positionMonitor.js` | ~150 | **Range-entry bookkeeping for Priority 2.** Every tracked position carries `has_entered_range` (`false` in `trackPosition`, one-way `true` via `markRangeEntered` + `range_entered_at` stamp). Per monitoring tick, `monitorPosition` / `monitorOpenPositions` flip it the first time `activeBinId ∈ [minBinId, maxBinId]` (inclusive, reversed bounds normalised, `in_range`/`bin_range` fallbacks for data-gap snapshots). Pure helpers (`resolveBinRange`, `isActiveBinInRange`, `getHasEnteredRange`, `evaluateRangeEntry`) never write state; the tick only writes on the transition. Called by the fast PnL poller, the management cycle and `detectExit()`. |
| `services/pnlCardGenerator.js` | ~680 | **Closed-position Zenith PnL card** (`PROMETHEUS LP` / `CLOSED • Meteora DLMM x.xx%` / hold duration, large signed USD PnL + %, TOP/BOTTOM/ENTRY/CLOSE price lines with the price-path curve, and an OPENED/CLOSED/DEPOSITED/RETURNED/FEES grid). Pure helpers (`priceAtBin`, `normalizePnlCardData`, `buildPricePath`, `buildClosedPositionCaption`), injected-canvas `drawPnlCard` for offline tests, lazy `@napi-rs/canvas` in `generatePnlCard`, and `sendClosedPositionPnlCard` (best-effort photo+caption, never throws). Used **only** for closed positions and PnL history — never for open positions. The price path is sampled in memory (`recordPriceSample`) by the PnL poller / management cycle and falls back to the entry → close segment. |
| `utils/timeout.js` | 70 | `withTimeout(promise, ms, label)` → rejects with `TimeoutError` (`code: "ETIMEDOUT"`), `isTimeoutError()`, `runWithTimeout()`. Shared by the Telegram poll loop, the LP menu and the interactive `/pool` screening reads. |
| `discord-listener/index.js` | 152 | Selfbot (uses `discord.js-selfbot-v13`). Listens to `DISCORD_CHANNEL_IDS` for `Metlex Pool Bot`, extracts Solana addresses, runs pre-check pipeline, appends to `discord-signals.json`. |
| `discord-listener/pre-checks.js` | 205 | Pipeline: dedup (10min) → blacklist → pool resolution (Meteora direct → DexScreener) → rugcheck.xyz (score>50000 OR top10>60% reject) → deployer blacklist → Jupiter global fees check (`minTokenFeesSol`). |
| `briefing.js` | 71 | HTML daily report. 24h activity, performance, lessons, current portfolio. Sent at 1:00 UTC. |
| `envcrypt.js` | 121 | XOR-cipher with a key from `.envrypt`/`ENVRYPT_KEY`. Encrypts anything matching `*_KEY`, `*SECRET*`, `*TOKEN*`, `*MNEMONIC*`, etc. The `# encrypted` marker in `.env` precedes encrypted lines. |
| `logger.js` | 75 | Daily-rotating `logs/agent-YYYY-MM-DD.log`. `logAction({tool, args, result, duration_ms, success})` writes JSONL `actions-YYYY-MM-DD.jsonl` audit trail. Level via `LOG_LEVEL` env. |
| **Other** | | |
| `discord-listener/`, `test/`, `scripts/`, `utils/` | | Discord listener (above), syntax-checked tests (`test-rpc-utils.js`), envcrypt CLI, `rpc-diagnostic.js` (Helius/RPC health), `check-syntax.js` (cross-platform `node --check`), `utils/rpc.js` (endpoint/key normalization + JSON-RPC probe), `safeNumber`. |
| `.claude/agents/{screener,manager}.md` | | Claude Code sub-agent configs — used when you run `claude` inside the repo. |
| `.claude/commands/*.md` | | Slash commands (`/screen`, `/manage`, `/balance`, `/candidates`, `/pool-ohlcv`, etc.) that wrap `cli.js`. |
| `.claude/settings.json` | | Denies `rm -rf`, `wget`, `Read(./.env*)`. **Forbids `run_in_background: true` via a PreToolUse hook.** |

---

## Agent roles & tool access

**AI scope boundary:** the LLM may only reason about *screening* (candidate ranking),
and screening via the LLM is opt-in through the Telegram `/pool` command. Everything
else — sizing, entry, management monitoring and exit execution — is deterministic code.
`DETERMINISTIC_ONLY_TOOLS = {close_position, deploy_position}` is filtered out of **every**
role's tool list in `agent.js#getToolsForRole`, and `agentLoop` rejects any tool call that
was not offered (hallucination guard).

Three roles (`agent.js:7-8`):

| Role | Tool set (filter on `MANAGER_TOOLS` / `SCREENER_TOOLS` / `INTENT_TOOLS`) | Prompt source |
|---|---|---|
| `SCREENER` | `get_active_bin, get_top_candidates, check_smart_wallets_on_pool, get_token_holders, get_token_narrative, get_token_info, search_pools, get_pool_memory, get_wallet_balance, get_my_positions` | `prompt.js` — screening only; must answer with a JSON `{action:"DEPLOY"|"NONE", candidate, reason}` selection. Cannot deploy. |
| `MANAGER` | `claim_fees, swap_token, get_position_pnl, get_my_positions, get_wallet_balance` | `prompt.js` — read/report only; `close_position` is unavailable. (No cron path invokes MANAGER any more.) |
| `GENERAL` | Intent-pattern matched (see `INTENT_PATTERNS` in `agent.js`). No `deploy_position` / `close_position` in any intent. | `prompt.js` — explains data; points users at `/pool`, `/close <n>`, `/closeall`, `/set`. |

Some tools are explicitly **never** sent to GENERAL unless the goal matches an intent: `self_update`, `update_config`, all `add/remove_*` and `pin_/unpin_` tools, `clear_lessons`, `set_active_strategy` (see `GENERAL_INTENT_ONLY_TOOLS`).

### Adding a new tool

1. **`tools/definitions.js`** — add the OpenAI-format schema to the `tools` array.
2. **`tools/executor.js`** — add `tool_name: functionImpl` to the `toolMap`. If it modifies on-chain state, also add it to `WRITE_TOOLS` + `PROTECTED_TOOLS` and add a `case` in `runSafetyChecks()`.
3. **`agent.js`** — add the tool name to `MANAGER_TOOLS` / `SCREENER_TOOLS` and/or to the relevant `INTENT_TOOLS[intent]` set.
4. If you want it in the Telegram `/settings` button menu, add it to `settingValue()` in `index.js` + the relevant `renderSettingsMenu` page.

---

## The ReAct loop (`agent.js:157`)

- **System prompt is built at the start of every cycle** with: portfolio, positions, state summary, lessons (3-tier cap — pinned / role / recent), performance summary, decision summary, optional signal weights summary (SCREENER only), `lessons_for_prompt`.
- **Messages get pushed in OpenAI format** unless the provider rejects the `system` role — then we switch to `providerMode = "user_embedded"` and embed the system prompt inside a user message.
- **Per-step retry**: 3 attempts on transient errors. If the response is 502/503/529 the second attempt swaps to fallback model `stepfun/step-3.5-flash:free`. If `tool_choice=required` is rejected or the provider is in thinking mode, retry with `tool_choice=auto` / omitted.
- **Tool args are JSON-validated** and run through `jsonrepair` if malformed; unrepairable args result in `blocked: true` returned to the LLM.
- **No-tool-loop guard**: if `mustUseRealTool` is true (action intents, `MUTATING_TOOL_INTENTS` regex) and the LLM responds with text only, we inject a reminder; second failure returns an error message.
- **Once-per-session tool locks**:
  - `ONCE_PER_SESSION = { swap_token, close_position }` — blocked on second call regardless of success.
  - `NO_RETRY_TOOLS = { deploy_position }` — locks on first attempt even if it failed.
  - `swap_token` locks only on `result.success === true` so a genuine failure can be retried.
  - `close_position` / `deploy_position` are in `DETERMINISTIC_ONLY_TOOLS`, so a model never receives them; the lock is a second line of defence.
- **On every tool call**: `logAction({tool, args, result, duration_ms, success})` writes the audit JSONL.

---

## Cron & cycle architecture (`index.js`)

Cron tasks created by `startCronJobs()`:

| Task | Cadence | Job |
|---|---|---|
| Management | `*/managementIntervalMin * * * *` | `runManagementCycle()` |
| Screening | `*/screeningIntervalMin * * * *` | `runScreeningCycle()` |
| Health check | `0 * * * *` | One-shot `agentLoop` as MANAGER with health summary goal |
| Briefing | `0 1 * * *` (UTC) | `runBriefing()` — 8 AM Jakarta |
| Briefing watchdog | `0 */6 * * *` (UTC) | `maybeRunMissedBriefing()` — fires on startup if missed |
| **PnL poller** | every 30s (`setInterval`) | Trailing-TP detection between management cycles (below) |

**Race condition guards** (all in `index.js`):
- `_managementBusy` / `_screeningBusy` flags prevent overlap.
- `_screeningLastTriggered` (epoch ms) prevents management from spamming screening.
- `_pollTriggeredAt` cooldown equal to `managementIntervalMin` to avoid PnL-poller double-triggering.
- `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh position count.

### The hybrid management cycle (deterministic + LLM)

The management cycle is **mostly deterministic in JS, LLM only for the hard cases**:

1. `getMyPositions({ force: true })` → snapshot.
2. `recordPositionSnapshot` per pool.
3. For every position: `confirmPeak(...)` then `detectExitWithSupertrend(p)` (`index.js`), which walks the strict hierarchy of `exit-rules.js`:
   - **Priority 1 — TP/SL:** `pnl_pct` vs `takeProfitPct` / `stopLossPct` (trailing TP is the same profit-taking family).
   - **Priority 2 — Range bounds:** active bin far above (`> upper + outOfRangeBinsToClose`) or far below (`< lower − outOfRangeBinsToClose`); a data-gap fallback keeps the `outOfRangeWaitMinutes` exit when bin geometry is missing. **Guarded by `hasEnteredRange`:** while the flag is `false` (deploy default — e.g. a below-price limit order still waiting) the whole of Priority 2 is bypassed and `evaluateExitHierarchy()` returns `null`. `monitorPosition()` flips it to `true` on the first tick with the active bin inside `[minBinId, maxBinId]` (one-way, persisted in state.json).
   - **Priority 3 — Supertrend 15m:** only when 1–2 returned nothing, `fetchSupertrend15m()` + `evaluateSupertrendExit()` close on a single closed 15m candle breaking the Supertrend line.
   - `refreshPositionState()` (state.js) only updates bookkeeping (trailing arm + `out_of_range_since`).
   - **RSI(2) / MACD / Bollinger never close a position** — the Evil Panda confluence was removed from the exit path.
4. Positions needing `CLAIM` if `unclaimed_fees_usd >= minClaimAmount`.
5. **No LLM is invoked in management.** Each close logs
   `[EXIT] Priority N: <reason> — <pair>` (e.g. `[EXIT] Priority 1: TP hit (+5.20%) — HYPE/USDC`) and then calls
   `executeTool("close_position", …)` directly. The hourly health check is a deterministic summary.

**Instruction notes** (`/set <n> <note>`) are parsed deterministically by
`parseInstructionOverrides()`: `tp <x>%`, `sl <x>%`, `close after <n>m|h`, `min yield <x>%`,
`hold until <x>% profit`. Only `tp` / `sl` change the exit hierarchy; the rest are
parsed for the report and are informational only — never sent to a model.

**Real-time exits** come from the 3s PnL poller: the same `detectExitWithSupertrend()` +
`registerExitSignal()` require `pnlConfirmTicks` consecutive confirming polls before the
close fires (`config.exitSafety.confirmTicks` for the Supertrend fallback).

### The screening cycle (multi-stage pipeline)

1. **Pre-checks**: `getMyPositions` + `getWalletBalances` in parallel. Skip if at `maxPositions` or `balance.sol < deployAmountSol + gasReserve`. Each skip writes a `decision-log` entry.
2. **Top candidates**: `getTopCandidates({limit: 10})` — applies ALL hard filters (TVL, fee/TVL, volatility, organic, holders, mcap, bin step, launchpad allow/block, token age, cooldowns, base mints already in use, dev blocklist), optional indicator confirmation, **and** PVP-rival detection (default: warn; `blockPvpSymbols: true` → hard filter).
3. **Sequential recon** with 150ms throttle (avoid 429s): `getActiveBin`, `checkSmartWalletsOnPool`, `getTokenNarrative`, `getTokenInfo` per candidate.
4. **Hard filters after recon**: launchpad allow/block, `bot_holders_pct > maxBotHoldersPct`.
5. **If 0 pass**: write `no_deploy` decision with `rejected[]` and return `⛔ NO DEPLOY` report.
6. **If 1 pass**: `getLoneCandidateSkipReason()` (smart-wallet absence, no narrative, PVP conflict, etc.) — if skipped, write `no_deploy` decision.
7. **Stage signals** for Darwinian attribution.
8. **Compact candidate blocks** built in `index.js:543`.
9. **LLM** gets the blocks + active strategy + balance + computed deploy amount + bins_below formula. The LLM is *forced* via `tool_choice: "required"` on step 0.
10. **Post-deploy**: `appendDecision` with full context. Darwinian signals (if enabled) get consumed via `getAndClearStagedSignals`.

---

## Position lifecycle

```
deployPosition()                   tools/dlmm.js
   ├─ safety: pool_detail fresh fetch, TVL, fee/TVL, volatility, bin_step
   ├─ safety: bin-array init rent check (refuses pools that need initialization)
   ├─ strategy: spot | curve | bid_ask (config.strategy.strategy)
   ├─ range: bins_below linear in volatility, totalBins >= 35 (MIN_SAFE_BINS_BELOW)
   ├─ wide path: totalBins > 69 → createExtendedEmptyPosition + addLiquidityByStrategyChunkable
   ├─ standard path: initializePositionAndAddLiquidityByStrategy
   └─ post: trackPosition({ signal_snapshot: getAndClearStagedSignals })
        appendDecision({ type: "deploy", actor: "SCREENER", metrics, risks, rejected })
        notifyDeploy (Telegram)   ── skip if live message active

manage cycle (every N min) — 100% deterministic, no LLM
   ├─ recordPositionSnapshot per pool
   ├─ detectExitWithSupertrend → P1 TP/SL → P2 range bounds → P3 Supertrend 15m
   │   (trailing arm/OOR state refreshed; RSI/MACD are NOT exit inputs)
   ├─ log `[EXIT] Priority N: <reason> — <pair>` → executeTool("close_position")
   └─ on close: recordClose() → recordPerformance() in lessons.js
                 ├─ recordPoolDeploy (pool-memory.json)
                 ├─ derive lesson (PREFER/AVOID/WORKED/FAILED)
                 ├─ if performance.length % 5 == 0 → evolveThresholds + recalculateWeights
                 └─ push HiveMind event (fire-and-forget)

auto-swap on close (executor.js:610)
   ├─ only if !skip_swap && result.base_mint
   ├─ get wallet balance, find base token
   ├─ if usd >= 0.10 → swapToken back to SOL
   └─ result.auto_swapped = true + auto_swap_note (so LLM doesn't double-swap)
```

**OOR detection**: `getMyPositions` calls `markOutOfRange` / `markInRange` for every position every cycle. The first time we see OOR, `out_of_range_since` is set; `minutesOutOfRange` is the diff.

**Position instruction** (`set_position_note`): `instruction` is sanitized (no newlines, max 280 chars, no `<>`). It is parsed **deterministically** by `parseInstructionOverrides()` into numeric rule overrides (`takeProfitPct`, `stopLossPct`, `closeAfterMinutes`, `minFeePerTvl24h`). Text the parser does not understand is informational only — it is never sent to a model and never influences an exit.

**Cooldown logic** (`pool-memory.js`):
- Single `low yield` close → 4h pool cooldown.
- `oorCooldownTriggerCount` (default 3) consecutive OOR closes → `oorCooldownHours` (default 12h) cooldown on **both pool and base mint**.
- Optional repeat-deploy cooldown: `repeatDeployCooldownTriggerCount` (default 3) fee-generating deploys in a row → pool+token cooldown (configurable scope).
- All checked by `isPoolOnCooldown` / `isBaseMintOnCooldown` in `getTopCandidates` and `deployPosition`.

---

## Persistent files (all JSON at repo root)

| File | Shape | Mutated by |
|---|---|---|
| `user-config.json` | Flat keys (e.g. `minTvl`, `deployAmountSol`); nested `chartIndicators`. | `config.js` (load), `update_config` tool, `evolveThresholds`, setup wizard. **NEVER gitignored but you must `.gitignore` it locally** — README says so. |
| `state.json` | `{ positions: { [address]: {position, pool, pool_name, strategy, bin_range, amount_sol, active_bin_at_deploy, deployed_at, out_of_range_since, last_claim_at, total_fees_claimed_usd, rebalance_count, closed, closed_at, notes, peak_pnl_pct, pending_*, trailing_active, instruction, _lastBriefingDate, recentEvents[]} }` | `state.js` |
| `lessons.json` | `{ lessons: [{id, rule, tags, outcome, sourceType, confidence, role, pinned, context, ...}], performance: [{position, pool, pnl_pct, pnl_usd, fees_earned_usd, range_efficiency, minutes_held, close_reason, signal_snapshot, ...}] }` | `lessons.js` |
| `pool-memory.json` | `{ [poolAddress]: { name, base_mint, deploys[], total_deploys, avg_pnl_pct, win_rate, adjusted_win_rate, cooldown_until, base_mint_cooldown_until, notes[], snapshots[] } }` | `pool-memory.js` |
| `decision-log.json` | `{ decisions: [{id, ts, type, actor, pool, summary, reason, risks[], metrics{}, rejected[]}] }` max 100 | `decision-log.js` (called from deploy/close/skip in `tools/dlmm.js`, `index.js`) |
| `signal-weights.json` | `{ weights: {signal: 0.3-2.5}, last_recalc, recalc_count, history[] }` | `signal-weights.js` |
| `strategy-library.json` | `{ active: <id>, strategies: { [id]: {id, name, author, lp_strategy, token_criteria, entry, range, exit, best_for, raw} } }` | `strategy-library.js` |
| `smart-wallets.json` | `{ wallets: [{name, address, category, type, addedAt}] }` | `smart-wallets.js` |
| `token-blacklist.json` | `{ [mint]: {symbol, reason, added_at, added_by} }` | `token-blacklist.js` |
| `dev-blocklist.json` | `{ [wallet]: {label, reason, added_at} }` | `dev-blocklist.js` |
| `deployer-blacklist.json` | `{ _note, addresses: [wallet, …] }` (legacy) | `discord-listener/pre-checks.js` |
| `discord-signals.json` | Array of signals with status pending/processed | `discord-listener` |
| `hivemind-cache.json` | `{ sharedLessons: [], presets: [], pulledAt }` | `hivemind.js` |
| `logs/agent-YYYY-MM-DD.log` | Plain text | `logger.js` |
| `logs/actions-YYYY-MM-DD.jsonl` | Audit JSONL | `logger.js logAction` |

All persistent files are loaded/saved on each call — no in-memory caching layer. Keep writes small and on the path of one position close, never inside a hot loop.

---

## Config system

`config.js` exports a single `config` object built once at module load, then mutated by `update_config` tool and `reloadScreeningThresholds()`. **Top-level keys** (all flat unless noted):

| Section | Keys | Default |
|---|---|---|
| `risk` | `maxPositions`, `maxDeployAmount` | 3, 50 |
| `screening` | `excludeHighSupplyConcentration`, `minFeeActiveTvlRatio`, `minTvl`, `maxTvl`, `minVolume`, `minOrganic`, `minQuoteOrganic`, `minHolders`, `minMcap`, `maxMcap`, `minBinStep`, `maxBinStep`, `timeframe`, `category`, `minTokenFeesSol`, `useDiscordSignals`, `discordSignalMode`, `avoidPvpSymbols`, `blockPvpSymbols`, `maxBotHoldersPct`, `maxTop10Pct`, `allowedLaunchpads`, `blockedLaunchpads`, `minTokenAgeHours`, `maxTokenAgeHours` | see `user-config.example.json` |
| `management` | `minClaimAmount`, `autoSwapAfterClaim`, `outOfRangeBinsToClose`, `outOfRangeWaitMinutes`, `oorCooldownTriggerCount`, `oorCooldownHours`, `repeatDeployCooldownEnabled`, `repeatDeployCooldownTriggerCount`, `repeatDeployCooldownHours`, `repeatDeployCooldownScope`, `repeatDeployCooldownMinFeeEarnedPct`, `minVolumeToRebalance`, `stopLossPct`, `takeProfitPct`, `minFeePerTvl24h`, `minAgeBeforeYieldCheck`, `minSolToOpen`, `deployAmountSol`, `gasReserve`, `positionSizePct`, `trailingTakeProfit`, `trailingTriggerPct`, `trailingDropPct`, `pnlSanityMaxDiffPct`, `solMode` | 5, false, 10, 30, 3, 12, true, 3, 12, "token", 0, 1000, -50, 5, 7, 60, 0.55, 0.5, 0.2, 0.35, true, 3, 1.5, 5, false |
| `strategy` | `strategy`, `minBinsBelow`, `maxBinsBelow`, `defaultBinsBelow` | bid_ask, 35, 69, 69 |
| `schedule` | `managementIntervalMin`, `screeningIntervalMin`, `healthCheckIntervalMin` | 10, 30, 60 |
| `llm` | `temperature`, `maxTokens`, `maxSteps`, `managementModel`, `screeningModel`, `generalModel` | 0.373, 4096, 20, healer-alpha, hunter-alpha, healer-alpha |
| `darwin` | `enabled`, `windowDays`, `recalcEvery`, `boostFactor`, `decayFactor`, `weightFloor`, `weightCeiling`, `minSamples` | true, 60, 5, 1.05, 0.95, 0.3, 2.5, 10 |
| `tokens` | `SOL`, `USDC`, `USDT` (mint addresses) | canonical |
| `hiveMind` | `url`, `apiKey`, `agentId`, `pullMode` | `https://api.agentmeridian.xyz`, built-in key, auto-generated, "auto" |
| `api` | `url`, `publicApiKey`, `lpAgentRelayEnabled` | `https://api.agentmeridian.xyz/api`, built-in key, false |
| `jupiter` | `apiKey`, `referralAccount`, `referralFeeBps` | env override, fixed referral, 50 bps |
| `indicators` | `enabled`, `entryPreset`, `exitPreset`, `rsiLength`, `intervals`, `candles`, `rsiOversold`, `rsiOverbought`, `requireAllIntervals` | false, supertrend_break, supertrend_break, 2, ["5_MINUTE"], 298, 30, 80, false |

`update_config` (executor.js:333) uses a flat-key `CONFIG_MAP` (50+ entries) that knows how to (a) coerce booleans/arrays/strings/numbers, (b) clamp `binsBelow*` to `MIN_SAFE_BINS_BELOW=35`, (c) restart cron if `managementIntervalMin` / `screeningIntervalMin` changed, (d) write a `[SELF-TUNED]` lesson.

`computeDeployAmount(walletSol) = clamp((walletSol - gasReserve) × positionSizePct, [deployAmountSol, maxDeployAmount])` → 2-decimal SOL.

`reloadScreeningThresholds()` (config.js:236) is called by `evolveThresholds` to re-apply changes to the in-memory `config` without process restart.

---

## Environment variables (`.env`)

| Var | Required | Purpose |
|---|---|---|
| `WALLET_PRIVATE_KEY` | yes | Base58 (or JSON array) |
| `RPC_URL` | yes | Solana RPC. Helius recommended: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`. Normalized at load (quotes/whitespace stripped, nested `api-key` repaired). |
| `OPENROUTER_API_KEY` (or `LLM_API_KEY`) | yes | LLM provider key. |
| `LLM_BASE_URL` | no | Override for any OpenAI-compatible endpoint (LM Studio: `http://localhost:1234/v1`). |
| `LLM_MODEL` | no | Default model. Per-role models in `user-config.json` override. |
| `HELIUS_API_KEY` | recommended | **Bare key only (uuid)** for wallet balance lookups. Pasting a full RPC URL here caused the historical HTTP 401 — `utils/rpc.js` now extracts the bare key defensively. |
| `RPC_FALLBACK_URL` | no | Read-only fallback endpoint used by health/balance reads when the primary RPC fails. |
| `ENABLE_PUBLIC_RPC_FALLBACK` | no | `true` → use `https://api.mainnet-beta.solana.com` as the read-only fallback when `RPC_FALLBACK_URL` is unset. |
| `LPAGENT_API_KEY` | optional | Direct LPAgent positions fetch fallback. |
| `JUPITER_API_KEY` | optional | Better rate limit on Jupiter Swap. Default key baked in. |
| `TELEGRAM_BOT_TOKEN` | no | Notifications + REPL. |
| `TELEGRAM_CHAT_ID` | no | Default chat (also persisted to `user-config.telegramChatId`). |
| `TELEGRAM_ALLOWED_USER_IDS` | no | Comma-separated Telegram user IDs allowed to control. Required if chat is a group. |
| `ALLOW_SELF_UPDATE` | no | Set `true` to allow the `self_update` tool (default false). |
| `DRY_RUN` | no | Skip all on-chain txs. `npm run dev` sets it. |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`. |
| `DISCORD_USER_TOKEN` | no | Selfbot for `discord-listener/`. |
| `DISCORD_GUILD_ID` / `DISCORD_CHANNEL_IDS` | no | Discord listener config. |
| `DISCORD_MIN_FEES_SOL` | no | Default 5. |
| `ENVRYPT_KEY` / `ENVCRYPT_KEY` | no | Key for `.env` XOR encryption (line-by-line marked with `# encrypted`). |
| `HIVE_MIND_URL` / `HIVE_MIND_API_KEY` | no | Override defaults. |

Encrypted env flow (optional, see `scripts/envrypt.js`):
1. Save plain values to `.env.raw`.
2. `printf "long-local-key\n" > .envrypt`.
3. `npm run env:encrypt` reads `.env.raw`, encrypts anything matching `*_KEY`/`*SECRET*`/`*TOKEN*`/`*MNEMONIC*`/etc., writes `.env`. Originals are XOR'd with a positional repeating key — **not** cryptographically secure, but obscures values in plaintext grep.

### RPC / Helius 401 troubleshooting

`HTTP 401 Unauthorized` from Helius means the **key**, not the network, is wrong. The two historical causes:

1. `HELIUS_API_KEY` held a full RPC URL (`https://mainnet.helius-rpc.com/?api-key=…`) instead of the bare uuid, producing `…/balances?api-key=https://…`.
2. The key was deleted/rotated in the Helius dashboard — every host returns 401, even `https://mainnet.helius-rpc.com/` without a key.

Diagnose (prints `getHealth`, `getBalance` for `11111111111111111111111111111111`, `getSlot` with raw HTTP status per endpoint):

```bash
npm run check:rpc              # live checks (exit 0 = read path verified)
npm run check:rpc -- --strict  # exit 1 unless the PRIMARY endpoint works
npm run check:rpc -- --json    # machine-readable report
npm run check                  # syntax + offline env audit + utils/rpc tests
```

`utils/rpc.js` normalizes endpoints (`sanitizeEnvValue`, `extractHeliusApiKey`, `normalizeRpcUrl`, `redactRpcUrl`) and wraps JSON-RPC calls (`rpcCall`, `describeHttpStatus`). `config.js` applies the normalization to `RPC_URL` / `HELIUS_API_KEY` at load, so tools always see a bare key. `tools/wallet.js` falls back to `getBalance` + `getParsedTokenAccountsByOwner` on `config.rpc.fallbackUrl` when Helius is down — **read-only**, signed transactions always use `RPC_URL`.

---

## Telegram ops surface

| Surface | Where handled | Notes |
|---|---|---|
| `/help` / `/status` / `/wallet` / `/config` | `index.js#telegramHandler` | Read-only. |
| `/positions` / `/pool <n>` / `/close <n>` / `/set <n> <note>` | `index.js#telegramHandler` | Bypass LLM — direct state mutation. `/close <n>` calls `closePosition` directly. |
| `/pool` (no argument) | `runScreeningCycle({ useLLM: true, silent: true, abortToken })` inside `runIsolatedTask` | **The only LLM-assisted workflow.** The model ranks candidates and returns a JSON selection; `deployCandidate()` sizes and deploys in code. **Hard 8 s deadline**: on timeout the handler replies `⚠️ Screening timed out (RPC/LLM slow). Showing basic pool metrics instead.` + `formatBasicPoolMetrics()` and the detached run is cancelled at the next checkpoint (so it can never deploy late). |
| `/pool <mint \| pool address>` | `services/lp-menu.js#openAddressQuery` (isolated) | Read-only pool/token lookup under the same 8 s deadline + metrics fallback. |
| `/closeall` | index.js | Closes all open positions in sequence. |
| `/screen` / `/candidates` / `/deploy <n>` | `runDeterministicScreen` + `deployLatestCandidate` | Deterministic — no LLM. The single-candidate skip rule applies. |
| `/briefing` | `generateBriefing` | On-demand daily report. |
| `/settings` / `/menu` / `/configmenu` | `renderSettingsMenu` + `applySettingsMenuCallback` | Inline-keyboard menu with toggle/step buttons. Updates flow through `update_config` tool. |
| `/lp` / `/zap` / `/newposition` / `/pools` | `services/lp-menu.js#showLpMainMenu` | Screening view + Quick-Zap dashboard with inline keyboards. Deploy goes through `openDlmmPosition` (manual path). |
| `/hive pull` | `pullHiveMindLessons` + `pullHiveMindPresets` | Manual HiveMind fetch. |
| `/pause` / `/resume` / `/stop` | index.js | Toggle cron jobs / graceful shutdown. |
| Free-form chat | `agentLoop` with `agentType=GENERAL` | Intent-matched tool subset. |
| `cfg:*` callback queries | `applySettingsMenuCallback` | Settings menu button presses. |
| `lp:*` callback queries | `handleLpCallback` | LP menu button presses (pool select, amount, range, strategy, continue, deploy). |
| LP custom text input | `handleLpText` | Amount (`0.5`, `50%`), range (`-30 +40`) and pasted pool addresses — consumed before the busy queue. |

**Auth** (`telegram.js#isAuthorizedIncomingMessage`):
- `chatId` must match incoming message's chat (env or persisted `user-config.telegramChatId`).
- If chat is a group/supergroup, `TELEGRAM_ALLOWED_USER_IDS` must be non-empty.
- Otherwise, all messages from the matching chat are accepted.
- Warns-once on missing config, then silently ignores inbound.

**Queueing**: while a management/screening cycle or free-form agentLoop is busy, inbound messages are queued (`_telegramQueue`, max 5). Overflow sends "Queue is full". The queue is drained when a cycle clears its busy flag (`drainTelegramQueue` is called from both cycle `finally` blocks and the explicit skip paths), so queued commands are never stranded in Telegram-only mode. Independent of that queue, `telegram.js` never awaits a handler: `/start`, `/pool` and `/lp` run concurrently.

**Responsiveness guarantees** (regression-tested in `test/test-lp-menu.js`): inline buttons are answered before any view work; a handler throw is logged and swallowed so the listener keeps serving later commands; polling failures back off 1 s → 2 s → … → 60 s and auto-reconnect; each LP-menu RPC/API/canvas read is capped at 5 s (`networkDeadline`) and answers `⚠️ Network timeout, please try again`; the whole `/pool` command is capped at 8 s (`POOL_TIMEOUT_MS`) with the metrics fallback.

**Network failure policy**: `tools/pnl.js#computePositions` bounds the public RPC (`pump.helius`) read and rethrows a tagged error; `tools/dlmm.js#getMyPositions` then falls back to the Meteora portfolio API, and if that also fails (`fetch failed`) it returns `{ positions: [], total_positions: 0, error }`. The PnL poller never throws and never stalls: the read is wrapped in `POSITIONS_READ_TIMEOUT_MS` and an `error` result simply skips the tick.

**Screening scheduler**: cron expressions are built by `cronExprForInterval()` (always 5-field, interval clamped to 1..59 minutes, so a bad config can never create a sub-minute timer) and `startCronJobs()` is idempotent (`_cronStarted` + `stopCronJobs()` first). Cron, the opportunity poller, post-management hand-off and startup all call `requestScreeningCycle()`, which refuses to spawn a cycle when `isScreeningRunning()` or when another trigger was accepted inside the dedupe window (`SCREENING_TRIGGER_DEDUPE_MS`, 30 s by default).

**Live messages**: `createLiveMessage` returns a handle. `toolStart`/`toolFinish` push per-tool lines (with `ℹ️`/`✅`/`❌` icons) into a single Telegram message that gets edited in place. While a live message is active, standalone notifications (`notifyDeploy`/`notifyClose`/`notifySwap`/`notifyOutOfRange`) are suppressed to avoid spam.

---

## Discord listener

Standalone process — `cd discord-listener && npm install && npm start`. Shares `../.env` for env vars.

- Uses `discord.js-selfbot-v13` (personal account, not bot). **Selfbot — use responsibly; against Discord TOS.**
- Filters: only `Metlex Pool Bot` author, only configured channels.
- Extracts Solana addresses (base58, 32-44 chars, must contain digit, not in `FALSE_POSITIVE_SKIP` set).
- For each address: runs `runPreChecks` (dedup → blacklist → pool resolve → rug → deployer → fees) and appends to `discord-signals.json` with `status: "pending"`.
- Screener picks up pending signals first (or only, if `discordSignalMode: "only"`).
- `DISCORD_MIN_FEES_SOL` defaults to 5; the screener's hard floor is `minTokenFeesSol` (default 30) — both apply.

---

## Strategy library (default strategies)

| id | name | lp_strategy | idea |
|---|---|---|---|
| `custom_ratio_spot` | Custom Ratio Spot | spot | Express directional bias via token:SOL ratio. |
| `single_sided_reseed` | Single-Sided Bid-Ask + Re-seed | bid_ask | Token-only redeploys on OOR downside. |
| `fee_compounding` | Fee Compounding | any | Claim + add back to same position. |
| `multi_layer` | Multi-Layer | mixed | One position, multiple add-liquidity layers with different shapes. |
| `partial_harvest` | Partial Harvest | any | Withdraw 50% at 10% return; rest keeps running. |

`set_active_strategy` swaps the active one. The screener prompt mentions the active strategy in the `ACTIVE STRATEGY` block.

---

## Known issues / tech debt (verified by reading the code)

- **`lessons.js evolveThresholds()`** evolves `minOrganic` and `minFeeActiveTvlRatio` only.
- **`get_wallet_positions` tool** is in `definitions.js` and wired in `executor.js`, but not in `MANAGER_TOOLS`/`SCREENER_TOOLS`. Only `INTENT_TOOLS.balance` / `INTENT_TOOLS.positions` expose it to GENERAL.
- **Lazy SDK load** (`tools/dlmm.js:33`) — `@meteora-ag/dlmm` is dynamic-imported on first on-chain call to avoid CJS-import crash on Node 24 (the `postinstall` `patch-anchor.js` handles another piece of this). Don't `import` it eagerly at top of file.
- **Position cache** (`_positionsCache` 5min TTL) — in single-process mode it's a perf win, but the cache is invalidated by `_positionsCacheAt = 0` after every deploy/close, and the executor's `deploy_position` safety check uses `force: true` for a fresh count.
- **PnL sanity check** (`pnlSanityMaxDiffPct`, default 5%) — if reported vs derived pnl_pct differ by more than this, the LLM is told not to trust that tick. Implemented in `dlmm.js` getMyPositions and `state.js` updatePnlAndCheckExits.
- **DRY_RUN auto-skip SOL balance check** — `runSafetyChecks` for `deploy_position` only checks `balance.sol < amountY + gasReserve` if `DRY_RUN !== "true"`.
- **HiveMind disable path is murky** — README says "there is currently no empty-string disable path" for HiveMind. `config.hiveMind.url/apiKey` fall back to defaults if blank. Set `pullMode: "manual"` to suppress auto-pull.
- **Selfbot in `discord-listener/`** is a ToS gray area. Make sure operators know.
- **`.claude/settings.json`** denies `rm -rf`, `wget`, and **reads of `.env*`**. It also blocks `run_in_background: true` via a PreToolUse hook. So in this repo, Claude Code can't background long-running commands — serial execution only.
- **Drift risk** — `user-config.json` keys must match the **flat** `update_config` CONFIG_MAP in executor.js. New keys: add to both, otherwise `update_config` returns `unknown: [...]` and skips the apply.
- **The Discord `useDiscordSignals` flag** lives in `screening`, not `discord`. Screener checks `config.screening.useDiscordSignals`, and `discordSignalMode: "merge" | "only"`.

---

## Patterns to copy

When adding a new tool that reads on-chain data, copy the **cache + inflight dedup + `force` flag** pattern from `getMyPositions` (`tools/dlmm.js:1154`). The `force: true` is what the deploy safety check relies on.

When adding a new persistent JSON store, copy the load/save pattern from `state.js` or `pool-memory.js`. **Always** run text through `sanitizeStoredText` (or write a domain-specific sanitizer that strips `<>` and newlines) before persisting — those values get echoed into the LLM prompt later.

When adding a new pre-LLM enrichment, follow the **3-strikes (Discord pre-checks)** model: cheap checks first (in-memory dedup, file lookup), then network (pool resolution, rugcheck), then more network (deployer, global fees). Log each pass/reject with the stage name.

When scheduling work, follow the **`_busy` flag + cooldown** pattern. `_managementBusy`, `_screeningBusy`, `_pnlPollBusy`, `_pollTriggeredAt`, `_screeningLastTriggered` are the canonical examples.

---

## What to read next

- Adding a new tool → `tools/definitions.js` + `tools/executor.js` + `agent.js` (see "Adding a new tool" above).
- Changing safety rules → `tools/executor.js#runSafetyChecks` and `exit-rules.js#evaluateNumericRules`.
- Adding a new persistent state file → copy `state.js` or `pool-memory.js`. Add a getter to `index.js` system-prompt section if the LLM needs to see it.
- Changing the LLM contract → `prompt.js` (buildSystemPrompt) and `agent.js` (INTENT_TOOLS + role sets + safety guards).
- Changing deploy/close behavior → `tools/dlmm.js` (the SDK wrapper) and `tools/executor.js` (the post-tool side effects + Telegram notify + auto-swap).
- Discord listener issues → `discord-listener/pre-checks.js`.
- HiveMind protocol issues → `hivemind.js` (push side) and `lessons.js#getLessonsForPrompt` (pull side injection).
