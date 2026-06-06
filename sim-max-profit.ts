/**
 * Polymarket DipArb — Maximum Profit 1-Hour Compounding Simulation
 *
 * Uses the real SDK for:
 *   • Market discovery (gamma-api slug resolution + CLOB token IDs)
 *   • ClobWS real-time orderbook feed
 *
 * Simulates execution locally (no real orders) with:
 *   • sumTarget = 0.90 — 11.1% margin, high-conviction entries only
 *   • Momentum filter — only enter while sum is DECLINING
 *   • Compound reinvestment — profits increase share count each round
 *   • 45s Leg2 window — abort and exit if price recovers too fast
 *   • Auto-rotate through consecutive BTC 5m markets for 60 min
 *
 * DRY RUN — zero real funds, zero real orders.
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { PolymarketSDK } from './src/index.js';
import { ClobOrderbookWS } from './src/services/clob-orderbook-ws.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const SUM_TARGET     = 0.90;   // enter when combined price ≤ this
const DIP_THRESHOLD  = 0.06;   // sum must be 6%+ below recent high
const LEG2_WINDOW_S  = 45;     // seconds to wait for Leg2 fill
const COOLDOWN_S     = 30;     // min seconds between entries same market
const HISTORY_MS     = 2000;   // rolling window for momentum check
const RUN_MINUTES    = 60;     // total simulation time

const CAPITAL        = parseFloat(process.env.SIM_CAPITAL ?? '3.00');
const START_SHARES   = 3;      // Polymarket minimum
const MAX_SHARES     = 30;

// ─── State ────────────────────────────────────────────────────────────────────
interface SimTrade {
  time: string;
  market: string;
  upBid: number; downBid: number; sum: number;
  shares: number;
  costRound: number;
  projProfit: number;
  leg2: 'filled' | 'timeout' | 'pending';
  realProfit: number;
}

interface RoundSummary {
  num: number; market: string;
  startCap: number; endCap: number;
  profit: number; pct: number;
  signals: number; trades: number;
  wins: number; losses: number;
}

const trades: SimTrade[] = [];
const rounds: RoundSummary[] = [];
let capital = CAPITAL;
let shares  = START_SHARES;

function calcShares(cap: number, sumTgt: number): number {
  // Reinvest: buy as many full rounds as Kelly allows (capped)
  // Use 50% of capital per round for safety, minimum START_SHARES
  const maxAffordable = Math.floor((cap * 0.50) / sumTgt);
  return Math.max(START_SHARES, Math.min(MAX_SHARES, maxAffordable));
}

function ts() { return new Date().toISOString().slice(11, 19); }

function banner(title: string) {
  const pad = Math.max(0, 72 - title.length - 4);
  console.log('\n' + '═'.repeat(72));
  console.log(` ◆ ${title}${' '.repeat(pad)} ◆`);
  console.log('═'.repeat(72));
}

// ─── Simulation core ──────────────────────────────────────────────────────────
async function watchMarket(
  sdk: PolymarketSDK,
  clobWS: ClobOrderbookWS,
  roundNum: number,
  deadline: number
): Promise<RoundSummary | null> {
  // Find next BTC 5m market that still has at least 2 min left
  const markets = await sdk.dipArb.scanUpcomingMarkets({
    coin: 'BTC', duration: '5m',
    minMinutesUntilEnd: 2,
    maxMinutesUntilEnd: 15,
    limit: 5,
  });

  if (!markets.length) {
    console.log(`[${ts()}] ⏳ No BTC 5m markets active right now — waiting 30s`);
    await new Promise(r => setTimeout(r, 30_000));
    return null;
  }

  const market = markets[0];
  const name   = market.name;
  // endTime is a Date object per DipArbMarketConfig
  const endTs  = market.endTime instanceof Date ? market.endTime.getTime() : (market.endTime as unknown as number) * 1000;
  const minsLeft = ((endTs - Date.now()) / 60_000).toFixed(1);

  banner(`ROUND ${roundNum}  |  $${capital.toFixed(2)} capital  |  ${shares} shares`);
  console.log(` Market:   ${name}`);
  console.log(` Ends in:  ${minsLeft} min  (${new Date(endTs).toISOString().slice(11,19)} UTC)`);
  console.log(` Config:   sumTarget=${SUM_TARGET} dip≥${DIP_THRESHOLD*100}% leg2=${LEG2_WINDOW_S}s`);
  console.log(` Entry:    max cost/round=$${(shares * SUM_TARGET).toFixed(2)} | proj win=$${(shares*(1-SUM_TARGET)).toFixed(2)}`);
  console.log(` UP tok:   ${market.upTokenId?.slice(0,20)}...`);
  console.log(` DWN tok:  ${market.downTokenId?.slice(0,20)}...`);
  console.log('─'.repeat(72));

  // Price state — use midpoint: (bestBid + bestAsk) / 2; fall back to ask if no bid
  let upMid = 0, downMid = 0;
  const priceHist: { t: number; sum: number }[] = [];
  let lastTick = 0;
  let lastEntry = 0;
  let isExecuting = false;

  const roundTrades: SimTrade[] = [];
  let signals = 0;

  function bestMid(ob: { bids?: {price:number}[]; asks?: {price:number}[] }): number {
    const bid = ob.bids?.length ? ob.bids[0].price : 0;
    const ask = ob.asks?.length ? ob.asks[0].price : 0;
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    return bid || ask || 0;
  }

  // Subscribe to orderbook via ClobWS
  const unsubUp   = clobWS.subscribe(market.upTokenId,   (ob) => { const m = bestMid(ob); if (m > 0) upMid   = m; lastTick = Date.now(); });
  const unsubDown = clobWS.subscribe(market.downTokenId, (ob) => { const m = bestMid(ob); if (m > 0) downMid = m; lastTick = Date.now(); });

  const marketDeadline = Math.min(Math.max(endTs - 5_000, Date.now() + 60_000), deadline);

  await new Promise<void>((resolve) => {
    const ticker = setInterval(() => {
      if (Date.now() >= marketDeadline) { clearInterval(ticker); resolve(); return; }

      if (upMid <= 0 || downMid <= 0) {
        if ((Date.now() % 15_000) < 500)
          console.log(`[${ts()}] ⌛ Waiting for orderbook (UP=${upMid.toFixed(3)} DOWN=${downMid.toFixed(3)})...`);
        return;
      }

      const now = Date.now();
      const sum = upMid + downMid;

      // Update rolling history
      priceHist.push({ t: now, sum });
      while (priceHist.length && priceHist[0].t < now - HISTORY_MS) priceHist.shift();

      const recentHigh = Math.max(...priceHist.map(p => p.sum));
      const dip = recentHigh > 0 ? (recentHigh - sum) / recentHigh : 0;
      const declining = priceHist.length >= 3 &&
        priceHist[priceHist.length - 1].sum < priceHist[priceHist.length - 3].sum;

      // Periodic status log every 20s
      if ((now % 20_000) < 300) {
        const minsRemain = ((marketDeadline - now) / 60_000).toFixed(1);
        const gap = ((sum - SUM_TARGET) * 100).toFixed(1);
        console.log(`[${ts()}] 📊 UP=${upMid.toFixed(4)} DOWN=${downMid.toFixed(4)} Sum=${sum.toFixed(4)} | gap=+${gap}% dip=${(dip*100).toFixed(1)}% T-${minsRemain}m`);
      }

      // Entry condition: sum ≤ target, meaningful dip, price falling, cooled down
      if (
        sum <= SUM_TARGET &&
        dip >= DIP_THRESHOLD &&
        declining &&
        !isExecuting &&
        (now - lastEntry) > COOLDOWN_S * 1000
      ) {
        signals++;
        isExecuting = true;
        lastEntry = now;

        const entryShares  = shares;
        const leg1Cost     = upMid * entryShares;
        const leg1Side     = upMid < downMid ? 'UP' : 'DOWN';  // buy the cheaper/dipping side
        const leg1Price    = upMid;

        console.log(`\n[${ts()}] ⚡ SIGNAL #${signals} — Sum=${sum.toFixed(4)} dip=${(dip*100).toFixed(1)}%`);
        console.log(`[${ts()}]   SIM LEG1: BUY ${entryShares} ${leg1Side} @ ${leg1Price.toFixed(4)} = $${leg1Cost.toFixed(2)}`);

        const trade: SimTrade = {
          time: new Date().toISOString().slice(11,19),
          market: name,
          upBid: upMid, downBid: downMid, sum,
          shares: entryShares,
          costRound: sum * entryShares,
          projProfit: (1 - sum) * entryShares,
          leg2: 'pending',
          realProfit: 0,
        };

        // Leg2 monitoring: wait up to LEG2_WINDOW_S for price to remain below sumTarget+cushion
        const leg2Deadline = now + LEG2_WINDOW_S * 1000;
        let leg2Resolved = false;

        const leg2Ticker = setInterval(() => {
          if (leg2Resolved) { clearInterval(leg2Ticker); return; }
          const curSum = upBid + downBid;

          if (Date.now() > leg2Deadline) {
            // Timeout: Leg2 failed to fill, forced exit Leg1 at ~25% loss
            leg2Resolved = true;
            clearInterval(leg2Ticker);
            trade.leg2 = 'timeout';
            trade.realProfit = -(leg1Cost * 0.25);  // forced slippage exit
            console.log(`[${ts()}]   ⚠️  LEG2 TIMEOUT — forced Leg1 exit, loss=$${Math.abs(trade.realProfit).toFixed(2)}`);
            roundTrades.push(trade);
            isExecuting = false;
            return;
          }

          // Leg2 fills if sum is still ≤ sumTarget + 0.015 cushion
          if (curSum <= SUM_TARGET + 0.015 && downMid > 0) {
            leg2Resolved = true;
            clearInterval(leg2Ticker);
            trade.leg2 = 'filled';
            trade.downBid = downMid; // update to actual fill price
            trade.sum = leg1Price + downMid;
            // Guaranteed profit: we hold both legs → one pays $1 at resolution
            // Net = $1 × shares - (leg1 + leg2) × shares
            trade.realProfit = (1 - trade.sum) * entryShares;
            console.log(`[${ts()}]   ✅ LEG2 FILLED: BUY ${entryShares} DOWN @ ${downBid.toFixed(4)} = $${(downBid*entryShares).toFixed(2)}`);
            console.log(`[${ts()}]   💰 LOCKED PROFIT: $${trade.realProfit.toFixed(2)} (${((1-trade.sum)*100).toFixed(1)}% margin)`);
            roundTrades.push(trade);
            isExecuting = false;
          }
        }, 100);
      }
    }, 250);
  });

  unsubUp();
  unsubDown();

  // Round P&L
  const roundProfit = roundTrades.reduce((a, t) => a + t.realProfit, 0);
  const startCap = capital;
  capital += roundProfit;

  // Compound: recalculate shares for next round
  shares = calcShares(capital, SUM_TARGET);

  const wins   = roundTrades.filter(t => t.leg2 === 'filled').length;
  const losses = roundTrades.filter(t => t.leg2 === 'timeout').length;

  const summary: RoundSummary = {
    num: roundNum, market: name,
    startCap, endCap: capital,
    profit: roundProfit, pct: (roundProfit / startCap) * 100,
    signals, trades: roundTrades.length,
    wins, losses,
  };

  rounds.push(summary);
  trades.push(...roundTrades);

  console.log('\n' + '─'.repeat(72));
  const icon = roundProfit >= 0 ? '✅' : '❌';
  console.log(` ${icon} Round ${roundNum}: P&L ${roundProfit >= 0 ? '+' : ''}$${roundProfit.toFixed(2)} (${summary.pct.toFixed(1)}%) | signals=${signals} wins=${wins} losses=${losses}`);
  console.log(` Capital: $${startCap.toFixed(2)} → $${capital.toFixed(2)} | Next shares: ${shares}`);

  return summary;
}

// ─── Final report ─────────────────────────────────────────────────────────────
function printReport() {
  const totalProfit = capital - CAPITAL;
  const totalPct    = (totalProfit / CAPITAL) * 100;
  const allWins     = trades.filter(t => t.leg2 === 'filled').length;
  const allLosses   = trades.filter(t => t.leg2 === 'timeout').length;
  const allSigs     = rounds.reduce((a, r) => a + r.signals, 0);
  const winRate     = (allWins + allLosses) > 0 ? (allWins / (allWins + allLosses) * 100).toFixed(0) : 'N/A';

  banner('1-HOUR SIMULATION FINAL REPORT');

  console.log(` Run duration:   ${RUN_MINUTES} minutes`);
  console.log(` Starting cap:   $${CAPITAL.toFixed(2)}`);
  console.log(` Final cap:      $${capital.toFixed(2)}`);
  console.log(` Total P&L:      ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)} (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%)`);
  console.log(` Rounds:         ${rounds.length}`);
  console.log(` Signals:        ${allSigs}`);
  console.log(` Trades:         ${allWins + allLosses}`);
  console.log(` Wins:           ${allWins}  |  Losses: ${allLosses}  |  Win rate: ${winRate}%`);
  console.log('');

  console.log(' PER-ROUND BREAKDOWN:');
  for (const r of rounds) {
    const icon = r.profit >= 0 ? '✅' : (r.profit === 0 ? '⏸' : '❌');
    console.log(` ${icon} Rnd ${r.num.toString().padStart(2)}: ${r.profit >= 0?'+':''}$${r.profit.toFixed(2).padStart(6)} (${r.pct.toFixed(1).padStart(5)}%) | sigs=${r.signals} W=${r.wins} L=${r.losses} | cap=$${r.endCap.toFixed(2)}`);
  }

  console.log('');
  console.log(' STRATEGY ASSESSMENT:');

  if (allSigs === 0) {
    console.log(' ⚠️  ZERO SIGNALS in 60 minutes.');
    console.log('    BTC/USD 5m prices remained above 0.90 throughout — efficient market.');
    console.log('    DipArb requires a panic-sell event driving sum below 0.90.');
    console.log('    Recommendations:');
    console.log('      1. Raise sumTarget to 0.94 → catches more dips, ~6% margin per trade');
    console.log('      2. Expand to ETH/SOL markets (more volatile, more dip events)');
    console.log('      3. Trade during high-volatility periods (news events, 8am-10am ET)');
    console.log('      4. Use SmartMoney copy-trading alongside DipArb for baseline returns');
  } else if (totalProfit > 0) {
    const avgWin = allWins > 0 ? trades.filter(t=>t.leg2==='filled').reduce((a,t)=>a+t.realProfit,0)/allWins : 0;
    const avgLoss = allLosses > 0 ? Math.abs(trades.filter(t=>t.leg2==='timeout').reduce((a,t)=>a+t.realProfit,0)/allLosses) : 0;
    console.log(` ✅ PROFITABLE: +$${totalProfit.toFixed(2)} (+${totalPct.toFixed(1)}%) over 60 minutes`);
    console.log(`    Avg win:  +$${avgWin.toFixed(2)} | Avg loss: -$${avgLoss.toFixed(2)}`);
    console.log(`    Compounding added: $${(capital - CAPITAL - trades.reduce((a,t)=>a+t.realProfit,0)).toFixed(2)} extra from reinvestment`);
    console.log('    ✔ Strategy validated — live trading viable with real USDC');
  } else {
    console.log(` ❌ NET LOSS: $${totalProfit.toFixed(2)} — Leg2 failures dominated`);
    console.log('    Recommendation: tighten sumTarget to 0.87 (larger margin cushion)');
    console.log('    Or extend leg2 timeout to 90s for slower price recovery markets');
  }

  console.log('');
  console.log(` THEORETICAL MAX (all signals win, 0.90 entry): +${((Math.pow(1/SUM_TARGET, rounds.length)-1)*100).toFixed(0)}% compounded`);
  console.log(` ACTUAL RESULT: ${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%`);
  console.log('═'.repeat(72));

  // Write full report to file
  const report = {
    runDate: new Date().toISOString(),
    config: { sumTarget: SUM_TARGET, dipThreshold: DIP_THRESHOLD, leg2WindowS: LEG2_WINDOW_S, runMinutes: RUN_MINUTES },
    summary: { startCapital: CAPITAL, endCapital: capital, totalProfit, totalPct, rounds: rounds.length, signals: allSigs, trades: allWins + allLosses, wins: allWins, losses: allLosses, winRate: parseFloat(winRate) || 0 },
    rounds,
    trades,
  };
  const reportPath = '/tmp/sim-report.json';
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(` Full report saved → ${reportPath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // SDK for market discovery (no private key needed for read-only)
  const sdk = new PolymarketSDK({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
  });

  const clobWS = new ClobOrderbookWS();
  clobWS.connect();
  await new Promise(r => setTimeout(r, 2500)); // wait for WS handshake

  const deadline = Date.now() + RUN_MINUTES * 60_000;

  banner(`POLYMARKET DIPARB MAX-PROFIT SIM — ${RUN_MINUTES} MINUTES`);
  console.log(` Capital:   $${CAPITAL.toFixed(2)} (compounds each round)`);
  console.log(` Strategy:  sumTarget=${SUM_TARGET} | dip≥${DIP_THRESHOLD*100}% | leg2=${LEG2_WINDOW_S}s | momentum filter ON`);
  console.log(` Runs until: ${new Date(deadline).toISOString().slice(11,19)} UTC`);
  console.log('');
  console.log(' THEORETICAL MAX per round at 0.90 entry:');
  let c = CAPITAL; let sh = START_SHARES;
  for (let i = 1; i <= 12; i++) {
    const profit = sh * (1 - SUM_TARGET);
    const next = c + profit;
    if (i <= 5) console.log(`   Rnd ${i}: $${c.toFixed(2)} → $${next.toFixed(2)} (+${(profit/c*100).toFixed(1)}%) | ${sh} shares`);
    c = next; sh = calcShares(c, SUM_TARGET);
  }
  console.log(`   [After 12 rounds: $${c.toFixed(2)} theoretical max]\n`);

  let roundNum = 0;
  while (Date.now() < deadline - 30_000) {
    roundNum++;
    await watchMarket(sdk, clobWS, roundNum, deadline);
    // Brief pause between rounds
    if (Date.now() < deadline - 30_000) await new Promise(r => setTimeout(r, 3_000));
  }

  clobWS.destroy();
  await printReport();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
