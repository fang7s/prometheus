# Prometheus DLMM LP Agent 🚀

> **Acknowledgment & Attribution:**  
> This project is a specialized fork of [yunus-0x/meridian](https://github.com/yunus-0x/meridian). Special thanks to **yunus-0x** for laying the solid foundation and core architecture for Solana Meteora DLMM automated liquidity management.

**Prometheus** is an enhanced, autonomous liquidity provider (LP) agent built for Solana's Meteora DLMM ecosystem. It is optimized for high-volatility memecoin pools using a deterministic technical indicator engine, multi-layered price data pipelines, and intelligent position exit mechanics.

---

## 🌟 Key Features & Improvements Over Upstream

While keeping the strong core liquidity interaction logic of Meridian, **Prometheus** introduces several key architectural enhancements:

* **🛡️ Price Pipeline (on-chain only, no third-party rate limits):**
  * **Source:** the Meteora DLMM active bin (`getActiveBin`) — the same SDK that signs the deploys.
  * **Buffer:** in-memory sliding window (capped at 50 price points) that builds the pseudo-candles for the indicators, so no external market API (CoinGecko / GeckoTerminal / DexScreener) is ever needed — those answer HTTP 429 on their keyless tiers and have been removed.
* **🐼 Evil Panda Confluence Exit Engine:**
  * Strict multi-indicator exit validation combining **RSI(2) saturation ($\ge 70-80$)**, **Bollinger Bands Upper penetration**, and **MACD/Supertrend momentum shifts**.
  * Features a **3-tick confirmation poller** to completely eliminate loss from fakeout candles.
* **🔄 Bid-Ask Flipper:**
  * Automated position rebalancing logic for out-of-range LP bins to maximize fee generation.
* **⚡ Standalone & Resource Efficient:**
  * Built for high stability on minimal VPS specs with memory-leak protection and strict RPC cooldown management.

---

## 🏗️ Architecture Overview

```text
[Meteora DLMM / Jupiter Data]
             │
             ▼
[Multi-Layer Price Engine] ─── (Meteora DLMM active bin -> In-Memory Buffer)
             │
             ▼
[Indicator Pipeline] ───────── (RSI(2), Bollinger Bands, MACD / Supertrend)
             │
             ▼
[Evil Panda & Flipper Engine] ─ (3-Tick Confirmation Logic)
             │
             ▼
[Solana On-Chain Executor] ──── (Fee Claim / Auto-Close / Rebalance)
