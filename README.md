# Prometheus DLMM LP Agent 🚀

> **Acknowledgment & Attribution:**  
> This project is a specialized fork of [yunus-0x/meridian](https://github.com/yunus-0x/meridian). Special thanks to **yunus-0x** for laying the solid foundation and core architecture for Solana Meteora DLMM automated liquidity management.

**Prometheus** is an enhanced, autonomous liquidity provider (LP) agent built for Solana's Meteora DLMM ecosystem. It is optimized for high-volatility memecoin pools using a deterministic technical indicator engine, multi-layered price data pipelines, and intelligent position exit mechanics.

---

## 🌟 Key Features & Improvements Over Upstream

While keeping the strong core liquidity interaction logic of Meridian, **Prometheus** introduces several key architectural enhancements:

* **🛡️ Multi-Layer Price Pipeline (Bulletproof Fallback):**
  * **Primary:** GeckoTerminal API for standard historical OHLCV data.
  * **Secondary:** DexScreener Pair API for instant spot prices on newly launched tokens.
  * **Tertiary / Buffer:** In-memory sliding window buffer (capped at 50 price points) to compute indicators even during external API downtime.
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
[Multi-Layer Price Engine] ─── (GeckoTerminal -> DexScreener -> In-Memory Buffer)
             │
             ▼
[Indicator Pipeline] ───────── (RSI(2), Bollinger Bands, MACD / Supertrend)
             │
             ▼
[Evil Panda & Flipper Engine] ─ (3-Tick Confirmation Logic)
             │
             ▼
[Solana On-Chain Executor] ──── (Fee Claim / Auto-Close / Rebalance)
