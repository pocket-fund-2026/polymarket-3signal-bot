/**
 * Polymarket 120-Minute Maximum Profit Simulation — v2
 *
 * THREE-SIGNAL FUSION:
 *  1. Binance momentum  — 2-minute BTC price change (40% weight)
 *  2. Groq sentiment    — LLM analysis of live news headlines (40% weight)
 *  3. Fear & Greed      — Alternative.me index 0–100 (20% weight)
 *
 * Entry fires when weighted score exceeds ±0.15 threshold.
 * Position sized via Kelly fraction (30% of capital per trade).
 * Compounds wins into larger share counts each round.
 *
 * DRY RUN — zero real orders, 100% simulation.
 */

import 'dotenv/config';
import { writeFileSync, appendFileSync } from 'fs';
import { PolymarketSDK } from './src/index.js';
import type { DipArbMarketConfig } from './src/services/dip-arb-types.js';
import { SentimentService } from './src/services/sentiment-service.js';
import type { SentimentResult, CombinedSignal } from './src/services/sentiment-service.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';

// Force real-time logging to file
const LOG_FILE = '/tmp/sim-120.log';
writeFileSync(LOG_FILE, '');
const origLog = console.log.bind(console);
console.log = (...args: any[]) => {
  const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  origLog(line);
  appendFileSync(LOG_FILE, line + '\n');
};

// ─── Configuration ────────────────────────────────────────────────────────────
const CFG = {
  RUN_MINUTES:      120,
  INITIAL_CAPITAL:  3.00,

  DIR_FRACTION:     0.30,   // 30% of capital per trade (Kelly-based)
  DIR_MIN_SHARES:   1,
  DIR_MAX_ASK:      0.75,

  ARB_SUM_TARGET:   0.99,   // buy BOTH legs when ask(UP)+ask(DOWN) < 0.99
  ARB_FRACTION:     0.50,

  POLL_INTERVAL_MS: 3000,
  COOLDOWN_MS:      25000,

  // Signal fusion weights (must sum to 1.0)
  W_MOMENTUM:       0.40,
  W_SENTIMENT:      0.40,
  W_FEAR_GREED:     0.20,
  ENTRY_THRESHOLD:  0.15,   // min |weighted score| to enter a trade
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface Book { bestBid: number; bestAsk: number; }

interface PendingTrade {
  id: string; type: 'directional' | 'arb';
  market: string; side: 'UP' | 'DOWN' | 'BOTH';
  entryUpAsk: number; entryDownAsk: number;
  shares: number; costPerShare: number; totalCost: number;
  entryTs: number; marketStartTs: number; marketEndTs: number;
  btcPriceAtEntry: number;
  signal?: { momentum: number; sentiment: number; fearGreed: number; total: number; };
}

interface CompletedTrade extends PendingTrade {
  resolution: 'WIN' | 'LOSS' | 'ARB_WIN';
  exitPrice: number; realProfit: number; btcPriceAtEnd: number;
}

// ─── State ────────────────────────────────────────────────────────────────────
let capital      = CFG.INITIAL_CAPITAL;
const pending:   PendingTrade[]   = [];
const completed: CompletedTrade[] = [];
const arbLog:    CompletedTrade[] = [];
const priceLog:  { ts: number; market: string; upAsk: number; downAsk: number; sum: number }[] = [];
const sentimentLog: { ts: number; direction: string; confidence: number; fearGreed: number; reasoning: string }[] = [];
const marketCooldowns = new Map<string, number>();

let _simStartTime = Date.now();
let _peakCapital  = CFG.INITIAL_CAPITAL;
let _btcTrend: 'up' | 'down' | 'neutral' = 'neutral';

function emitSimState() {
  _peakCapital = Math.max(_peakCapital, capital);
  const wins   = completed.filter(t => t.resolution === 'WIN' || t.resolution === 'ARB_WIN').length;
  const losses = completed.filter(t => t.resolution === 'LOSS').length;
  const pnl    = capital - CFG.INITIAL_CAPITAL;
  dashboardEmitter.updateState({
    startTime:          _simStartTime,
    dailyPnL:           pnl,
    totalPnL:           pnl,
    tradesExecuted:     completed.length,
    consecutiveLosses:  0,
    consecutiveWins:    0,
    monthlyPnL:         pnl,
    monthStartTime:     _simStartTime,
    peakCapital:        _peakCapital,
    currentCapital:     capital,
    currentDrawdown:    capital < _peakCapital ? (_peakCapital - capital) / _peakCapital : 0,
    permanentlyHalted:  false,
    isPaused:           false,
    pauseUntil:         0,
    lastDailyReset:     _simStartTime,
    smartMoneyTrades:   0,
    arbTrades:          arbLog.length,
    dipArbTrades:       completed.filter(t => t.type === 'directional').length,
    directTrades:       0,
    arbProfit:          arbLog.reduce((s, t) => s + t.realProfit, 0),
    followedWallets:    [],
    positions:          pending.map(t => ({ market: t.market, side: t.side, shares: t.shares, cost: t.totalCost })),
    activeArbMarket:    null,
    activeDipArbMarket: pending[0]?.market ?? null,
    splits: 0, merges: 0, redeems: 0, swaps: 0,
    usdcBalance:        capital,
    usdcEBalance:       0,
    maticBalance:       0,
    unrealizedPnL:      0,
    btcTrend:           _btcTrend,
    ethTrend:           'neutral',
    solTrend:           'neutral',
    dipArb: {
      marketName:   pending[0]?.market ?? null,
      underlying:   'BTC/ETH',
      duration:     '5m',
      endTime:      pending[0]?.marketEndTs ?? null,
      upPrice:      pending[0]?.entryUpAsk ?? 0,
      downPrice:    pending[0]?.entryDownAsk ?? 0,
      sum:          (pending[0]?.entryUpAsk ?? 0) + (pending[0]?.entryDownAsk ?? 0),
      status:       pending.length > 0 ? 'active' : 'scanning',
      lastSignal:   null,
      signals:      [],
    },
    arbitrage: {
      status:              'idle',
      marketsScanned:      priceLog.length,
      opportunitiesFound:  arbLog.length,
      currentMarket:       null,
      lastOpportunity:     null,
    },
    smartMoneySignals: [],
    paper: {
      balance:        capital,
      initialBalance: CFG.INITIAL_CAPITAL,
      pnl,
      trades:         completed.length,
      totalVolume:    completed.reduce((s, t) => s + t.totalCost, 0),
    },
  } as any);
}

function ts() { return new Date().toISOString().slice(11, 19); }
function banner(t: string) {
  const pad = Math.max(0, 72 - t.length - 4);
  console.log('\n' + '═'.repeat(72));
  console.log(` ◆ ${t}${' '.repeat(pad)} ◆`);
  console.log('═'.repeat(72));
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function getBook(tokenId: string): Promise<Book> {
  try {
    const r = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, { signal: AbortSignal.timeout(4000) });
    const d: any = await r.json();
    const bids = (d.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (d.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    return {
      bestBid: bids.length ? parseFloat(bids[0].price) : 0,
      bestAsk: asks.length ? parseFloat(asks[0].price) : 1,
    };
  } catch { return { bestBid: 0, bestAsk: 1 }; }
}

async function getBtcCandles(limit = 4): Promise<number[][]> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
    return await r.json() as number[][];
  } catch { return []; }
}

async function getBtcPriceAt(unixMs: number): Promise<number> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${unixMs - 60000}&endTime=${unixMs + 60000}&limit=3`, { signal: AbortSignal.timeout(5000) });
    const candles: number[][] = await r.json();
    if (!candles.length) return 0;
    return parseFloat(candles[candles.length - 1][4] as any);
  } catch { return 0; }
}

async function getBtcMomentum(): Promise<{ dir: 'UP' | 'DOWN' | 'NEUTRAL'; changePct: number; price: number }> {
  const candles = await getBtcCandles(4);
  if (candles.length < 3) return { dir: 'NEUTRAL', changePct: 0, price: 0 };
  const price2mAgo = parseFloat(candles[candles.length - 3][4] as any);
  const priceNow   = parseFloat(candles[candles.length - 1][4] as any);
  const changePct  = ((priceNow - price2mAgo) / price2mAgo) * 100;
  return {
    dir: changePct >= 0.01 ? 'UP' : changePct <= -0.01 ? 'DOWN' : 'NEUTRAL',
    changePct,
    price: priceNow,
  };
}

function getEndTs(m: DipArbMarketConfig): number {
  return m.endTime instanceof Date ? m.endTime.getTime() : (m.endTime as unknown as number) * 1000;
}
function getStartTs(m: DipArbMarketConfig): number {
  return getEndTs(m) - (m.durationMinutes ?? 5) * 60_000;
}

// ─── Resolution checker ───────────────────────────────────────────────────────
async function checkResolutions(): Promise<void> {
  const toResolve = pending.filter(t => Date.now() > t.marketEndTs + 5000);
  for (const trade of toResolve) {
    pending.splice(pending.indexOf(trade), 1);
    if (trade.type === 'arb') {
      const arbProfit = (1 - (trade.entryUpAsk + trade.entryDownAsk)) * trade.shares;
      const result: CompletedTrade = { ...trade, resolution: 'ARB_WIN', exitPrice: 1.0, realProfit: arbProfit, btcPriceAtEnd: 0 };
      capital += arbProfit;
      arbLog.push(result); completed.push(result);
      console.log(`[${ts()}] 💎 ARB SETTLED: +$${arbProfit.toFixed(3)} | cap=$${capital.toFixed(2)}`);
      dashboardEmitter.log('ARB', `ARB WIN +$${arbProfit.toFixed(3)} | cap=$${capital.toFixed(2)}`, { profit: arbProfit, capital });
      emitSimState();
      continue;
    }
    const btcEnd   = await getBtcPriceAt(trade.marketEndTs);
    const btcStart = trade.btcPriceAtEntry;
    let resolution: 'WIN' | 'LOSS';
    let realProfit: number;
    if (btcEnd === 0 || btcStart === 0) {
      realProfit = 0; resolution = 'WIN';
    } else {
      const btcWentUp = btcEnd >= btcStart;
      const weWon = trade.side === 'UP' ? btcWentUp : !btcWentUp;
      if (weWon) {
        resolution = 'WIN';
        realProfit = (1 - trade.costPerShare) * trade.shares;
      } else {
        resolution = 'LOSS';
        realProfit = -trade.costPerShare * trade.shares;
      }
    }
    capital += realProfit;
    const result: CompletedTrade = { ...trade, resolution, exitPrice: btcEnd, realProfit, btcPriceAtEnd: btcEnd };
    completed.push(result);
    const icon     = resolution === 'WIN' ? '✅' : '❌';
    const btcChg   = btcStart > 0 ? ((btcEnd - btcStart) / btcStart * 100).toFixed(3) : '?';
    console.log(
      `[${ts()}] ${icon} RESOLVED: ${trade.side} @ ${trade.costPerShare.toFixed(3)} | ` +
      `BTC ${btcStart.toFixed(0)}→${btcEnd.toFixed(0)} (${btcChg}%) | ` +
      `P&L ${realProfit >= 0 ? '+' : ''}$${realProfit.toFixed(3)} | cap=$${capital.toFixed(2)}`
    );
    dashboardEmitter.log(resolution === 'WIN' ? 'TRADE' : 'WARN',
      `${icon} ${resolution}: ${trade.side} ${trade.shares}sh @ ${trade.costPerShare.toFixed(3)} | P&L ${realProfit >= 0 ? '+' : ''}$${realProfit.toFixed(3)} | cap=$${capital.toFixed(2)}`,
      { resolution, side: trade.side, shares: trade.shares, profit: realProfit, capital }
    );
    emitSimState();
  }
}

// ─── Directional entry with 3-signal fusion ───────────────────────────────────
async function tryDirectionalEntry(
  market:    DipArbMarketConfig,
  sentiment: SentimentResult | null,
  lastDirEntry: Record<string, number>,
): Promise<void> {
  const mId     = market.upTokenId;
  const endTs   = getEndTs(market);
  const startTs = getStartTs(market);
  const now     = Date.now();

  const afterStart    = now >= startTs;
  const inEntryWindow = afterStart && (now - startTs) < 180_000;
  const lastDir       = lastDirEntry[mId] ?? 0;
  const notYetEntered = (now - lastDir) > 280_000;
  const minsLeft      = (endTs - now) / 60_000;

  if (!inEntryWindow || !notYetEntered || minsLeft < 2.0) return;
  const lastCool = marketCooldowns.get(mId) ?? 0;
  if (now - lastCool < CFG.COOLDOWN_MS) return;

  // ── Signal 1: Binance momentum ──────────────────────────────────────────────
  const momentum = await getBtcMomentum();
  _btcTrend = momentum.dir === 'UP' ? 'up' : momentum.dir === 'DOWN' ? 'down' : 'neutral';

  // ── Signal 2: Groq sentiment (cached, passed in from main loop) ─────────────
  const sentimentDir = sentiment?.direction ?? 'NEUTRAL';
  const sentimentConf = sentiment?.confidence ?? 0;

  // ── Signal 3: Fear & Greed ───────────────────────────────────────────────────
  const fgVal = sentiment?.fearGreed?.value ?? 50;

  // ── Weighted fusion ──────────────────────────────────────────────────────────
  const momentumScore =
    momentum.dir === 'UP'   ?  1 :
    momentum.dir === 'DOWN' ? -1 : 0;

  const sentimentScore =
    sentimentDir === 'BULLISH' ?  sentimentConf :
    sentimentDir === 'BEARISH' ? -sentimentConf : 0;

  const fearGreedScore =
    fgVal >= 70 ?  0.8 :
    fgVal >= 55 ?  0.4 :
    fgVal <= 25 ? -0.8 :
    fgVal <= 40 ? -0.4 : 0;

  const weightedTotal =
    momentumScore  * CFG.W_MOMENTUM  +
    sentimentScore * CFG.W_SENTIMENT +
    fearGreedScore * CFG.W_FEAR_GREED;

  // Require minimum conviction
  if (Math.abs(weightedTotal) < CFG.ENTRY_THRESHOLD) {
    const name = market.name.slice(-25);
    console.log(
      `[${ts()}] ⏸  ${name} — weak signal (M:${momentumScore>=0?'+':''}${momentumScore.toFixed(2)} ` +
      `S:${sentimentScore>=0?'+':''}${sentimentScore.toFixed(2)} ` +
      `FG:${fearGreedScore>=0?'+':''}${fearGreedScore.toFixed(2)} → ${weightedTotal.toFixed(3)}), skip`
    );
    return;
  }

  const direction: 'UP' | 'DOWN' = weightedTotal > 0 ? 'UP' : 'DOWN';

  // ── Book prices ──────────────────────────────────────────────────────────────
  const [upBook, downBook] = await Promise.all([getBook(mId), getBook(market.downTokenId)]);
  const askPrice = direction === 'UP' ? upBook.bestAsk : downBook.bestAsk;

  if (askPrice <= 0 || askPrice > CFG.DIR_MAX_ASK) {
    console.log(`[${ts()}] ⚠️  ask ${askPrice.toFixed(3)} out of range, skip`);
    return;
  }

  const tradeCapital = capital * CFG.DIR_FRACTION;
  const shares = Math.max(CFG.DIR_MIN_SHARES, Math.floor(tradeCapital / askPrice));
  const totalCost = shares * askPrice;
  if (totalCost > capital * 0.95) return;

  const btcAtStart = await getBtcPriceAt(startTs);

  const trade: PendingTrade = {
    id: `dir-${Date.now()}`, type: 'directional',
    market: market.name, side: direction,
    entryUpAsk: upBook.bestAsk, entryDownAsk: downBook.bestAsk,
    shares, costPerShare: askPrice, totalCost,
    entryTs: now, marketStartTs: startTs, marketEndTs: endTs,
    btcPriceAtEntry: btcAtStart || momentum.price,
    signal: { momentum: momentumScore, sentiment: sentimentScore, fearGreed: fearGreedScore, total: weightedTotal },
  };

  pending.push(trade);
  marketCooldowns.set(mId, now);
  lastDirEntry[mId] = now;

  dashboardEmitter.log('TRADE', `⚡ ENTRY: BUY ${shares} ${direction} @ ${askPrice.toFixed(3)} = $${totalCost.toFixed(2)} | ${market.name.slice(-30)}`,
    { side: direction, shares, askPrice, totalCost, market: market.name, weightedTotal, sentimentDir }
  );
  emitSimState();
  console.log(`\n[${ts()}] ⚡ ENTRY — BUY ${shares} ${direction} @ ${askPrice.toFixed(3)} = $${totalCost.toFixed(2)}`);
  console.log(`[${ts()}]   Market:   ${market.name.slice(-35)} | T-${minsLeft.toFixed(1)}m`);
  console.log(
    `[${ts()}]   Signals:  Momentum ${momentumScore>=0?'+':''}${momentumScore.toFixed(2)}(${momentum.changePct.toFixed(3)}%)` +
    ` | Sentiment ${sentimentScore>=0?'+':''}${sentimentScore.toFixed(2)}(${sentimentDir})` +
    ` | F&G ${fearGreedScore>=0?'+':''}${fearGreedScore.toFixed(2)}(${fgVal})`
  );
  console.log(
    `[${ts()}]   Fusion:   weighted=${weightedTotal>=0?'+':''}${weightedTotal.toFixed(3)} → ${direction} (conf=${(Math.abs(weightedTotal)*100).toFixed(0)}%)`
  );
  if (sentiment?.reasoning) {
    const xPosts = sentiment.xPostsFound > 0 ? ` [${sentiment.xPostsFound} X posts]` : '';
    console.log(`[${ts()}]   Grok/X:   "${sentiment.reasoning.slice(0, 90)}"${xPosts}`);
  }
  console.log(
    `[${ts()}]   BTC @ $${momentum.price.toFixed(2)} | Win: +$${((1-askPrice)*shares).toFixed(2)} | Loss: -$${totalCost.toFixed(2)}`
  );
}

// ─── Arb scanner ─────────────────────────────────────────────────────────────
async function scanForArb(markets: DipArbMarketConfig[]): Promise<void> {
  for (const m of markets) {
    const endTs = getEndTs(m);
    if (endTs - Date.now() < 90_000) continue;
    const lastEntry = marketCooldowns.get(m.upTokenId + '_arb') ?? 0;
    if (Date.now() - lastEntry < CFG.COOLDOWN_MS) continue;
    const [upBook, downBook] = await Promise.all([getBook(m.upTokenId), getBook(m.downTokenId)]);
    const askSum = upBook.bestAsk + downBook.bestAsk;
    priceLog.push({ ts: Date.now(), market: m.name, upAsk: upBook.bestAsk, downAsk: downBook.bestAsk, sum: askSum });
    if (askSum < CFG.ARB_SUM_TARGET && upBook.bestAsk > 0 && downBook.bestAsk > 0) {
      const shares = Math.max(1, Math.floor(capital * CFG.ARB_FRACTION / askSum));
      if (shares * askSum > capital * 0.90) return;
      const trade: PendingTrade = {
        id: `arb-${Date.now()}`, type: 'arb', market: m.name, side: 'BOTH',
        entryUpAsk: upBook.bestAsk, entryDownAsk: downBook.bestAsk,
        shares, costPerShare: askSum, totalCost: shares * askSum,
        entryTs: Date.now(), marketStartTs: getStartTs(m), marketEndTs: endTs,
        btcPriceAtEntry: 0,
      };
      pending.push(trade);
      marketCooldowns.set(m.upTokenId + '_arb', Date.now());
      console.log(`\n[${ts()}] 💎 ARB — ${m.name.slice(-30)} | ask-sum=${askSum.toFixed(4)} | ${shares}sh | $${(shares*askSum).toFixed(2)}`);
    }
  }
}

// ─── Final report ─────────────────────────────────────────────────────────────
function printReport() {
  const totalProfit  = capital - CFG.INITIAL_CAPITAL;
  const totalPct     = (totalProfit / CFG.INITIAL_CAPITAL) * 100;
  const wins         = completed.filter(t => t.resolution === 'WIN' || t.resolution === 'ARB_WIN');
  const losses       = completed.filter(t => t.resolution === 'LOSS');
  const winRate      = completed.length > 0 ? (wins.length / completed.length * 100).toFixed(0) : 'N/A';
  const dirTrades    = completed.filter(t => t.type === 'directional');

  banner('120-MINUTE SIMULATION FINAL REPORT — v2 (3-Signal Fusion)');
  console.log(` Run duration:    ${CFG.RUN_MINUTES} minutes`);
  console.log(` Starting cap:    $${CFG.INITIAL_CAPITAL.toFixed(2)}`);
  console.log(` Final cap:       $${capital.toFixed(2)}`);
  console.log(` Total P&L:       ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)} (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%)`);
  console.log(` Total trades:    ${completed.length} (${dirTrades.length} directional + ${arbLog.length} arb)`);
  console.log(` Wins:            ${wins.length}  |  Losses: ${losses.length}  |  Win rate: ${winRate}%`);
  console.log(` Price samples:   ${priceLog.length}`);
  console.log(` Sentiment scans: ${sentimentLog.length}`);
  console.log('');

  if (sentimentLog.length > 0) {
    console.log(' SENTIMENT HISTORY:');
    for (const s of sentimentLog) {
      console.log(` [${new Date(s.ts).toISOString().slice(11,16)}] ${s.direction.padEnd(8)} conf=${(s.confidence*100).toFixed(0).padStart(3)}% F&G=${s.fearGreed} — ${s.reasoning.slice(0,70)}`);
    }
    console.log('');
  }

  if (completed.length > 0) {
    console.log(' TRADE LOG:');
    for (const t of completed) {
      const icon = t.resolution === 'WIN' || t.resolution === 'ARB_WIN' ? '✅' : '❌';
      const sig  = t.signal ? `[M:${t.signal.momentum>=0?'+':''}${t.signal.momentum.toFixed(1)} S:${t.signal.sentiment>=0?'+':''}${t.signal.sentiment.toFixed(2)} → ${t.signal.total>=0?'+':''}${t.signal.total.toFixed(2)}]` : '';
      console.log(
        ` ${icon} [${new Date(t.entryTs).toISOString().slice(11,16)}] ` +
        `${(t.type === 'arb' ? 'ARB' : t.side).padEnd(4)} ` +
        `@ ${t.costPerShare.toFixed(3)} ×${t.shares} | ` +
        `P&L ${t.realProfit >= 0 ? '+' : ''}$${t.realProfit.toFixed(3)} ${sig}`
      );
    }
  }

  console.log('');
  console.log(' SIGNAL WEIGHT BREAKDOWN:');
  console.log(`   Momentum  (Binance 2m): ${(CFG.W_MOMENTUM*100).toFixed(0)}%`);
  console.log(`   Sentiment (Groq LLM):   ${(CFG.W_SENTIMENT*100).toFixed(0)}%`);
  console.log(`   Fear/Greed (Alt.me):    ${(CFG.W_FEAR_GREED*100).toFixed(0)}%`);
  console.log(`   Entry threshold:        ±${CFG.ENTRY_THRESHOLD}`);

  console.log('');
  console.log(` ACTUAL RESULT: ${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}% over 120 minutes`);
  console.log('═'.repeat(72));

  const report = {
    runDate: new Date().toISOString(), version: 'v2-3signal', config: CFG,
    summary: { startCapital: CFG.INITIAL_CAPITAL, endCapital: capital, totalProfit, totalPct,
      totalTrades: completed.length, wins: wins.length, losses: losses.length, winRate: parseFloat(winRate) || 0 },
    trades: completed, sentimentLog, priceLog: priceLog.slice(-200),
  };
  const path = '/tmp/sim-120min-report.json';
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(` Full report saved → ${path}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const xaiKey = process.env.XAI_API_KEY;
  const hasSentiment = !!xaiKey;

  // Start dashboard server
  _simStartTime = Date.now();
  startDashboard(3001);

  const sdk       = new PolymarketSDK({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
  const sentSvc   = hasSentiment ? new SentimentService(xaiKey!) : null;

  const deadline  = Date.now() + CFG.RUN_MINUTES * 60_000;
  let allMarkets: DipArbMarketConfig[] = [];
  let lastMarketRefresh = 0;
  let lastScan  = 0;
  let lastDirEntry: Record<string, number> = {};
  let lastSentimentRefresh = 0;
  let btcSentiment: SentimentResult | null = null;
  let ethSentiment: SentimentResult | null = null;

  banner('POLYMARKET 120-MIN SIMULATION — v2 (3-Signal Fusion + X Live Search)');
  console.log(` Capital:        $${CFG.INITIAL_CAPITAL.toFixed(2)}`);
  console.log(` Signal weights: Momentum ${(CFG.W_MOMENTUM*100).toFixed(0)}% | Groq Sentiment ${(CFG.W_SENTIMENT*100).toFixed(0)}% | Fear/Greed ${(CFG.W_FEAR_GREED*100).toFixed(0)}%`);
  console.log(` Entry trigger:  |weighted| > ${CFG.ENTRY_THRESHOLD}`);
  console.log(` Runtime:        ${CFG.RUN_MINUTES} min until ${new Date(deadline).toISOString().slice(11,19)} UTC`);
  console.log(` xAI Grok:       ${hasSentiment ? '✅ enabled (grok-3-fast + X live search, BTC & ETH)' : '⚠️  XAI_API_KEY not set — sentiment signal disabled'}`);

  console.log(` DRY RUN — zero real orders`);
  console.log(` Dashboard: http://localhost:3001`);
  console.log('');
  emitSimState();
  dashboardEmitter.log('INFO', 'Polymarket sim started — DRY RUN — 120 minutes', { capital: CFG.INITIAL_CAPITAL, dryRun: true });

  // Initial BTC price
  const init = await getBtcMomentum();
  console.log(` BTC @ $${init.price.toFixed(2)} | 2m trend: ${init.dir} (${init.changePct.toFixed(3)}%)`);

  // Initial sentiment fetch — BTC and ETH in parallel
  if (sentSvc) {
    console.log(` Fetching initial BTC + ETH sentiment from X, RSS, StockTwits...`);
    try {
      [btcSentiment, ethSentiment] = await Promise.all([
        sentSvc.getSentiment('BTC'),
        sentSvc.getSentiment('ETH'),
      ]);
      const bs = btcSentiment!, es = ethSentiment!;
      sentimentLog.push({ ts: Date.now(), direction: bs.direction, confidence: bs.confidence, fearGreed: bs.fearGreed.value, reasoning: bs.reasoning });
      console.log(` BTC Sentiment: ${bs.direction} (conf=${(bs.confidence*100).toFixed(0)}%, X posts=${bs.xPostsFound}) | F&G: ${bs.fearGreed.value} "${bs.fearGreed.classification}"`);
      console.log(` Grok on BTC:   "${bs.reasoning.slice(0, 100)}"`);
      console.log(` ETH Sentiment: ${es.direction} (conf=${(es.confidence*100).toFixed(0)}%, X posts=${es.xPostsFound})`);
      console.log(` Grok on ETH:   "${es.reasoning.slice(0, 100)}"`);
      console.log(` Top headline: ${bs.headlines[0] ?? 'none'}`);
    } catch (e) {
      console.log(` Sentiment fetch failed: ${(e as any).message}`);
    }
  }
  console.log('');

  // Main loop
  while (Date.now() < deadline - 30_000) {
    const now = Date.now();

    // Refresh market list every 4 minutes
    if (now - lastMarketRefresh > 240_000) {
      try {
        const btc5m = await sdk.dipArb.scanUpcomingMarkets({ coin: 'BTC', duration: '5m', minMinutesUntilEnd: 2, maxMinutesUntilEnd: 30, limit: 10 });
        const eth5m = await sdk.dipArb.scanUpcomingMarkets({ coin: 'ETH', duration: '5m', minMinutesUntilEnd: 2, maxMinutesUntilEnd: 30, limit: 5 });
        allMarkets = [...btc5m, ...eth5m];
        lastMarketRefresh = now;
        console.log(`[${ts()}] 🔄 Markets: ${btc5m.length} BTC + ${eth5m.length} ETH active`);
      } catch (e) {
        console.log(`[${ts()}] ⚠️  Market refresh failed`);
      }
    }

    // Refresh sentiment every 5 minutes (BTC + ETH via X live search)
    if (sentSvc && (now - lastSentimentRefresh) > 300_000) {
      try {
        [btcSentiment, ethSentiment] = await Promise.all([
          sentSvc.getSentiment('BTC'),
          sentSvc.getSentiment('ETH'),
        ]);
        lastSentimentRefresh = now;
        const bs = btcSentiment!, es = ethSentiment!;
        sentimentLog.push({ ts: now, direction: bs.direction, confidence: bs.confidence, fearGreed: bs.fearGreed.value, reasoning: bs.reasoning });
        console.log(`\n[${ts()}] 🧠 X SENTIMENT UPDATE`);
        console.log(`[${ts()}]   BTC: ${bs.direction} (conf=${(bs.confidence*100).toFixed(0)}%, X posts=${bs.xPostsFound}) F&G=${bs.fearGreed.value}`);
        console.log(`[${ts()}]   ETH: ${es.direction} (conf=${(es.confidence*100).toFixed(0)}%, X posts=${es.xPostsFound})`);
        console.log(`[${ts()}]   Grok on BTC: "${bs.reasoning.slice(0, 90)}"`);
        if (bs.headlines.length) console.log(`[${ts()}]   News: "${bs.headlines[0]}"`);
        dashboardEmitter.log('SIGNAL', `🧠 BTC=${bs.direction}(${(bs.confidence*100).toFixed(0)}%) ETH=${es.direction}(${(es.confidence*100).toFixed(0)}%) F&G=${bs.fearGreed.value}`,
          { btc: { direction: bs.direction, confidence: bs.confidence, xPosts: bs.xPostsFound, reasoning: bs.reasoning }, eth: { direction: es.direction }, fearGreed: bs.fearGreed.value }
        );;
      } catch {}
    }

    // Resolve completed trades
    await checkResolutions();

    // Arb scanner
    if (now - lastScan >= CFG.POLL_INTERVAL_MS && allMarkets.length > 0) {
      await scanForArb(allMarkets);
      lastScan = now;
    }

    // Directional entries — use coin-specific X sentiment
    for (const m of allMarkets) {
      const isEth = /eth/i.test(m.name);
      const coinSentiment = isEth ? ethSentiment : btcSentiment;
      await tryDirectionalEntry(m, coinSentiment, lastDirEntry);
    }

    // Heartbeat every 60s
    if ((now % 60_000) < CFG.POLL_INTERVAL_MS) {
      const w = completed.filter(t => t.resolution === 'WIN' || t.resolution === 'ARB_WIN').length;
      const l = completed.filter(t => t.resolution === 'LOSS').length;
      const pnl = capital - CFG.INITIAL_CAPITAL;
      const elapsed   = ((now - (deadline - CFG.RUN_MINUTES * 60_000)) / 60_000).toFixed(0);
      const remaining = ((deadline - now) / 60_000).toFixed(0);
      console.log(
        `\n[${ts()}] ⏱  T+${elapsed}m (${remaining}m left) | cap=$${capital.toFixed(2)} ` +
        `P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${w}W/${l}L | pending=${pending.length}`
      );
      emitSimState();
    }

    await new Promise(r => setTimeout(r, CFG.POLL_INTERVAL_MS));
  }

  await new Promise(r => setTimeout(r, 5000));
  await checkResolutions();
  await printReport();
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
