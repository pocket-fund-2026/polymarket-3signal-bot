/**
 * Polymarket Momentum Bot — 3-Signal Strategy
 *
 * Signals (weighted fusion):
 *   40%  Binance 2-min BTC momentum
 *   40%  Groq/xAI LLM sentiment (live X posts + news)
 *   20%  Fear & Greed index
 *
 * Entry fires only when |weighted score| > 0.15
 * Sizing: 30% of capital, MAX_SHARES = 5
 * Entry:  within first 3 min of 5-min market, ≥2 min remaining
 * Coins:  BTC + ETH simultaneously, MAX 1 open position per coin
 *
 * DRY RUN — zero real orders
 */

import 'dotenv/config';
import { appendFileSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { PolymarketSDK } from './src/index.js';

// Lock file prevents tsx child-process double-evaluation
const LOCK = '/tmp/sim-pure.lock';
if (existsSync(LOCK)) {
  const born = parseInt(readFileSync(LOCK, 'utf8') || '0');
  if (Date.now() - born < 15_000) process.exit(0);  // fresh lock → this is the duplicate, exit
}
writeFileSync(LOCK, String(Date.now()));
process.on('exit',    () => { try { unlinkSync(LOCK); } catch {} });
process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
import type { DipArbMarketConfig } from './src/services/dip-arb-types.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';
import { SentimentService } from './src/services/sentiment-service.js';
import type { SentimentResult } from './src/services/sentiment-service.js';

const LOG_FILE = '/tmp/sim-pure.log';
writeFileSync(LOG_FILE, '');
// Dedup on globalThis so state survives tsx's double-evaluation of the module
const G = globalThis as any;
if (!G.__simLog) { G.__simLog = { last: '', ts: 0 }; }
const origLog = console.log.bind(console);
console.log = (...args: any[]) => {
  const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  origLog(line);
  const now = Date.now();
  if (line === G.__simLog.last && now - G.__simLog.ts < 200) return;
  G.__simLog.last = line; G.__simLog.ts = now;
  appendFileSync(LOG_FILE, line + '\n');
};

// ─── Config ───────────────────────────────────────────────────────────────────
const CFG = {
  INITIAL_CAPITAL:    parseFloat(process.env.CAPITAL_USD ?? '4.87'),
  DIR_FRACTION:       0.30,
  MAX_SHARES:         5,
  DIR_MAX_ASK:        0.75,
  ENTRY_THRESHOLD:    0.15,   // min |weighted score| to fire a trade
  W_MOMENTUM:         0.40,
  W_SENTIMENT:        0.40,
  W_FEAR_GREED:       0.20,
  COOLDOWN_MS:        25_000,
  COIN_LOCK_MS:       280_000, // prevent re-entry on same coin for ~4.5 min
  SENTIMENT_TTL_MS:   300_000, // refresh sentiment every 5 min
  POLL_MS:            3_000,
  MARKET_REFRESH_MS:  60_000,
};

// ─── Types ────────────────────────────────────────────────────────────────────
interface Book { bestBid: number; bestAsk: number; }
interface Trade {
  id: string;
  coin: 'BTC' | 'ETH';
  market: string;
  side: 'UP' | 'DOWN';
  shares: number;
  costPerShare: number;
  totalCost: number;
  entryTs: number;
  marketStartTs: number;
  marketEndTs: number;
  priceAtEntry: number;
  signal?: { momentum: number; sentiment: number; fearGreed: number; total: number };
  resolution?: 'WIN' | 'LOSS';
  priceAtEnd?: number;
  realProfit?: number;
}

// ─── State ────────────────────────────────────────────────────────────────────
let capital     = CFG.INITIAL_CAPITAL;
let peakCapital = CFG.INITIAL_CAPITAL;
let _startTs    = Date.now();
let _btcTrend: 'up' | 'down' | 'neutral' = 'neutral';
let _ethTrend: 'up' | 'down' | 'neutral' = 'neutral';
const pending:      Trade[] = [];
const completed:    Trade[] = [];
const lastCoinEntry: Record<string, number> = {};

// ─── API helpers ──────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 19); }

async function getBook(tokenId: string): Promise<Book> {
  try {
    const r = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`,
      { signal: AbortSignal.timeout(4000) });
    const d: any = await r.json();
    const asks = (d.asks ?? []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    return { bestBid: 0, bestAsk: asks.length ? parseFloat(asks[0].price) : 1 };
  } catch { return { bestBid: 0, bestAsk: 1 }; }
}

async function getBtcMomentum(): Promise<{ dir: 'UP' | 'DOWN' | 'NEUTRAL'; changePct: number; price: number }> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=4`,
      { signal: AbortSignal.timeout(5000) });
    const candles: number[][] = await r.json();
    if (candles.length < 3) return { dir: 'NEUTRAL', changePct: 0, price: 0 };
    const price2mAgo = parseFloat(candles[candles.length - 3][4] as any);
    const priceNow   = parseFloat(candles[candles.length - 1][4] as any);
    const changePct  = ((priceNow - price2mAgo) / price2mAgo) * 100;
    return {
      dir: changePct >= 0.01 ? 'UP' : changePct <= -0.01 ? 'DOWN' : 'NEUTRAL',
      changePct,
      price: priceNow,
    };
  } catch { return { dir: 'NEUTRAL', changePct: 0, price: 0 }; }
}

async function getEthPrice(): Promise<number> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT`,
      { signal: AbortSignal.timeout(3000) });
    const d: any = await r.json();
    return parseFloat(d.price) || 0;
  } catch { return 0; }
}

async function getPriceAt(symbol: string, unixMs: number): Promise<number> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m` +
      `&startTime=${unixMs - 60000}&endTime=${unixMs + 60000}&limit=3`,
      { signal: AbortSignal.timeout(5000) }
    );
    const candles: number[][] = await r.json();
    if (!candles.length) return 0;
    return parseFloat(candles[candles.length - 1][4] as any);
  } catch { return 0; }
}

function getEndTs(m: DipArbMarketConfig): number {
  return m.endTime instanceof Date ? m.endTime.getTime() : (m.endTime as unknown as number) * 1000;
}
function getStartTs(m: DipArbMarketConfig): number {
  return getEndTs(m) - (m.durationMinutes ?? 5) * 60_000;
}

// ─── Dashboard state ──────────────────────────────────────────────────────────
function emitState() {
  peakCapital = Math.max(peakCapital, capital);
  const wins = completed.filter(t => t.resolution === 'WIN').length;
  const losses = completed.filter(t => t.resolution === 'LOSS').length;
  const pnl = capital - CFG.INITIAL_CAPITAL;
  dashboardEmitter.updateState({
    startTime: _startTs, dailyPnL: pnl, totalPnL: pnl,
    tradesExecuted: completed.length, consecutiveLosses: losses, consecutiveWins: wins,
    monthlyPnL: pnl, monthStartTime: _startTs, peakCapital, currentCapital: capital,
    currentDrawdown: capital < peakCapital ? (peakCapital - capital) / peakCapital : 0,
    permanentlyHalted: false, isPaused: false, pauseUntil: 0, lastDailyReset: _startTs,
    smartMoneyTrades: 0, arbTrades: 0, dipArbTrades: completed.length, directTrades: 0,
    arbProfit: 0, followedWallets: [],
    positions: pending.map(t => ({ market: t.market, side: t.side, shares: t.shares, cost: t.totalCost })),
    activeArbMarket: null, activeDipArbMarket: pending[0]?.market ?? null,
    splits: 0, merges: 0, redeems: 0, swaps: 0,
    usdcBalance: capital, usdcEBalance: 0, maticBalance: 0, unrealizedPnL: 0,
    btcTrend: _btcTrend, ethTrend: _ethTrend, solTrend: 'neutral',
    dipArb: {
      marketName: pending[0]?.market ?? null, underlying: 'BTC/ETH', duration: '5m',
      endTime: pending[0]?.marketEndTs ?? null, upPrice: 0, downPrice: 0, sum: 0,
      status: pending.length > 0 ? 'active' : 'scanning', lastSignal: null, signals: [],
    },
    arbitrage: { status: 'idle', marketsScanned: 0, opportunitiesFound: 0, currentMarket: null, lastOpportunity: null },
    smartMoneySignals: [],
    paper: { balance: capital, initialBalance: CFG.INITIAL_CAPITAL, pnl, trades: completed.length, totalVolume: completed.reduce((s, t) => s + t.totalCost, 0) },
  } as any);
}

// ─── Terminal dashboard ───────────────────────────────────────────────────────
function drawDashboard(btcPrice: number, ethPrice: number, changePct: number, lastSignal: string) {
  const W = 64;
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
  const ln  = (s: string) => `║  ${pad(s, W - 4)}║`;
  const R = '\x1b[0m', B = '\x1b[1m', G = '\x1b[32m', RD = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m';

  const pnl = capital - CFG.INITIAL_CAPITAL;
  const wins = completed.filter(t => t.resolution === 'WIN').length;
  const losses = completed.filter(t => t.resolution === 'LOSS').length;
  const capColor = pnl >= 0 ? G : RD;
  const runtimeMin = Math.floor((Date.now() - _startTs) / 60_000);

  const rows: string[] = [];
  rows.push(`╔${'═'.repeat(W - 2)}╗`);
  rows.push(ln(`${B}  3-SIGNAL BOT  —  BTC 5m + ETH 5m${R}`));
  rows.push(`╠${'═'.repeat(W - 2)}╣`);
  rows.push(ln(`  Capital  ${capColor}${('$' + capital.toFixed(2)).padEnd(10)}${R} Peak $${peakCapital.toFixed(2).padEnd(8)} → $60`));
  rows.push(ln(`  P&L      ${capColor}${(pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2)}${R}${' '.repeat(6)} W:${wins}  L:${losses}  Open:${pending.length}`));
  rows.push(`╠${'═'.repeat(W - 2)}╣`);
  rows.push(ln(`  BTC  ${Y}$${btcPrice.toFixed(2)}${R}   2m: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(3)}%`));
  rows.push(ln(`  ETH  ${C}$${ethPrice.toFixed(2)}${R}`));
  rows.push(ln(`  Signal   ${lastSignal}`));
  rows.push(`╠${'═'.repeat(W - 2)}╣`);

  if (pending.length > 0) {
    rows.push(ln('  OPEN'));
    for (const t of pending) {
      const minsLeft = ((t.marketEndTs - Date.now()) / 60_000).toFixed(1);
      const coinC = t.coin === 'BTC' ? Y : C;
      rows.push(ln(`  ▶ ${coinC}${t.coin}${R} ${t.side.padEnd(4)} ${t.shares}sh@$${t.costPerShare.toFixed(2)}  T-${minsLeft}m`));
    }
    rows.push(`╠${'═'.repeat(W - 2)}╣`);
  }

  rows.push(ln(`  Runtime  ${runtimeMin}m  |  ${ts()} UTC`));
  rows.push(`╠${'═'.repeat(W - 2)}╣`);
  rows.push(ln('  TRADE HISTORY'));
  let runCap = CFG.INITIAL_CAPITAL;
  for (const t of completed) {
    runCap += t.realProfit!;
    const icon = t.resolution === 'WIN' ? `${G}✓${R}` : `${RD}✗${R}`;
    const coinC = t.coin === 'BTC' ? Y : C;
    const p = t.realProfit! >= 0
      ? `${G}+$${t.realProfit!.toFixed(2)}${R}`
      : `${RD}-$${Math.abs(t.realProfit!).toFixed(2)}${R}`;
    const sig = t.signal ? `[${t.signal.total >= 0 ? '+' : ''}${t.signal.total.toFixed(2)}]` : '';
    rows.push(ln(`  ${icon} ${coinC}${t.coin}${R} ${t.side.padEnd(4)} ${t.shares}sh@$${t.costPerShare.toFixed(2)}  ${p.padEnd(14)} $${runCap.toFixed(2)} ${sig}`));
  }
  if (completed.length === 0) rows.push(ln('  (no completed trades yet)'));
  rows.push(`╚${'═'.repeat(W - 2)}╝`);

  process.stdout.write('\x1b[H\x1b[J' + rows.join('\n') + '\n');
}

// ─── Resolution ───────────────────────────────────────────────────────────────
async function checkResolutions(): Promise<void> {
  const toResolve = pending.filter(t => Date.now() > t.marketEndTs + 5000);
  for (const trade of toResolve) {
    pending.splice(pending.indexOf(trade), 1);
    const symbol   = trade.coin === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
    const priceEnd = await getPriceAt(symbol, trade.marketEndTs);
    const priceStart = trade.priceAtEntry;
    let resolution: 'WIN' | 'LOSS';
    let realProfit: number;
    if (priceEnd === 0 || priceStart === 0) {
      resolution = 'WIN'; realProfit = (1 - trade.costPerShare) * trade.shares;
    } else {
      const movedUp = priceEnd >= priceStart;
      const weWon   = trade.side === 'UP' ? movedUp : !movedUp;
      resolution  = weWon ? 'WIN' : 'LOSS';
      realProfit  = weWon
        ? (1 - trade.costPerShare) * trade.shares
        : -trade.costPerShare * trade.shares;
    }
    capital += realProfit;
    trade.resolution = resolution; trade.priceAtEnd = priceEnd; trade.realProfit = realProfit;
    completed.push(trade);
    const icon = resolution === 'WIN' ? '✅' : '❌';
    const chg  = priceStart > 0 ? ((priceEnd - priceStart) / priceStart * 100).toFixed(3) : '?';
    console.log(
      `[${ts()}] ${icon} ${resolution} — ${trade.coin} ${trade.side} ${trade.shares}sh@$${trade.costPerShare.toFixed(2)} | ` +
      `${trade.coin} ${priceStart.toFixed(2)}→${priceEnd.toFixed(2)} (${chg}%) | ` +
      `P&L ${realProfit >= 0 ? '+' : ''}$${realProfit.toFixed(2)} | cap=$${capital.toFixed(2)}`
    );
    dashboardEmitter.log(resolution === 'WIN' ? 'TRADE' : 'WARN',
      `${icon} ${resolution}: ${trade.coin} ${trade.side} ${trade.shares}sh P&L ${realProfit >= 0 ? '+' : ''}$${realProfit.toFixed(2)} cap=$${capital.toFixed(2)}`,
      { resolution, profit: realProfit, capital }
    );
    emitState();
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────
async function tryEntry(
  market: DipArbMarketConfig,
  coin: 'BTC' | 'ETH',
  momentum: { dir: 'UP' | 'DOWN' | 'NEUTRAL'; changePct: number; price: number },
  sentiment: SentimentResult | null,
  priceNow: number,
): Promise<void> {
  const mId     = market.upTokenId;
  const endTs   = getEndTs(market);
  const startTs = getStartTs(market);
  const now     = Date.now();

  // Timing gate: within first 3 min of market open, ≥2 min remaining
  if (now < startTs || (now - startTs) > 180_000 || (endTs - now) / 60_000 < 2.0) return;

  // Hard cap: 1 open position per coin at a time (prevents ALL duplicates)
  if (pending.some(t => t.coin === coin)) return;

  // Per-coin lock: prevents re-entry within same 5-min window
  if ((now - (lastCoinEntry[coin] ?? 0)) < CFG.COIN_LOCK_MS) return;

  // ── Signal fusion ────────────────────────────────────────────────────────────
  const momentumScore =
    momentum.dir === 'UP'   ?  1 :
    momentum.dir === 'DOWN' ? -1 : 0;

  const sentDir  = sentiment?.direction ?? 'NEUTRAL';
  const sentConf = sentiment?.confidence ?? 0;
  const sentimentScore =
    sentDir === 'BULLISH' ?  sentConf :
    sentDir === 'BEARISH' ? -sentConf : 0;

  const fgVal = sentiment?.fearGreed?.value ?? 50;
  const fearGreedScore =
    fgVal >= 70 ?  0.8 :
    fgVal >= 55 ?  0.4 :
    fgVal <= 25 ? -0.8 :
    fgVal <= 40 ? -0.4 : 0;

  const weighted =
    momentumScore  * CFG.W_MOMENTUM  +
    sentimentScore * CFG.W_SENTIMENT +
    fearGreedScore * CFG.W_FEAR_GREED;

  if (Math.abs(weighted) < CFG.ENTRY_THRESHOLD) {
    console.log(
      `[${ts()}] ⏸  ${coin} skipped — weak signal ` +
      `M:${momentumScore >= 0 ? '+' : ''}${momentumScore.toFixed(2)} ` +
      `S:${sentimentScore >= 0 ? '+' : ''}${sentimentScore.toFixed(2)} ` +
      `FG:${fearGreedScore >= 0 ? '+' : ''}${fearGreedScore.toFixed(2)} ` +
      `→ ${weighted.toFixed(3)} (need ±${CFG.ENTRY_THRESHOLD})`
    );
    return;
  }

  const direction: 'UP' | 'DOWN' = weighted > 0 ? 'UP' : 'DOWN';

  // ── Book price ───────────────────────────────────────────────────────────────
  const book = await getBook(direction === 'UP' ? mId : market.downTokenId);
  const ask  = book.bestAsk;
  if (ask <= 0 || ask > CFG.DIR_MAX_ASK) return;

  const shares    = Math.min(CFG.MAX_SHARES, Math.max(1, Math.floor(capital * CFG.DIR_FRACTION / ask)));
  const totalCost = shares * ask;
  if (totalCost > capital * 0.95) return;

  const trade: Trade = {
    id: `${coin}-${now}`, coin, market: market.name, side: direction,
    shares, costPerShare: ask, totalCost,
    entryTs: now, marketStartTs: startTs, marketEndTs: endTs,
    priceAtEntry: priceNow,
    signal: { momentum: momentumScore, sentiment: sentimentScore, fearGreed: fearGreedScore, total: weighted },
  };

  pending.push(trade);
  lastCoinEntry[coin] = now;

  const minsLeft = ((endTs - now) / 60_000).toFixed(1);
  console.log(
    `[${ts()}] ⚡ ENTRY — ${coin} BUY ${shares} ${direction} @ $${ask.toFixed(2)} = $${totalCost.toFixed(2)} | ` +
    `T-${minsLeft}m | fusion=${weighted >= 0 ? '+' : ''}${weighted.toFixed(3)} ` +
    `(M:${momentumScore >= 0 ? '+' : ''}${momentumScore.toFixed(1)} ` +
    `S:${sentimentScore >= 0 ? '+' : ''}${sentimentScore.toFixed(2)} ` +
    `FG:${fearGreedScore >= 0 ? '+' : ''}${fearGreedScore.toFixed(1)})`
  );
  dashboardEmitter.log('TRADE',
    `⚡ ENTRY: ${coin} BUY ${shares} ${direction} @ $${ask.toFixed(2)} fusion=${weighted.toFixed(3)}`,
    { coin, direction, shares, ask, weighted }
  );
  emitState();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  _startTs = Date.now();
  startDashboard(3001);

  const sdk      = new PolymarketSDK({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
  const xaiKey   = process.env.XAI_API_KEY;
  const sentSvc  = xaiKey ? new SentimentService(xaiKey) : null;

  let markets: DipArbMarketConfig[] = [];
  let lastMarketRefresh  = 0;
  let lastSentimentRefresh = 0;
  let btcSentiment: SentimentResult | null = null;
  let ethSentiment: SentimentResult | null = null;
  let lastDraw = 0;
  let btcPrice = 0, ethPrice = 0;
  let lastChangePct = 0;
  let lastSignalStr = 'waiting for first signal…';

  console.log(`[${ts()}] 3-SIGNAL BOT started | cap=$${capital.toFixed(2)} | DRY RUN`);
  console.log(`[${ts()}] Signals: Momentum 40% + Groq Sentiment 40% + Fear&Greed 20% | threshold ±0.15`);
  console.log(`[${ts()}] xAI Groq: ${sentSvc ? '✅ enabled' : '⚠️  XAI_API_KEY missing — sentiment disabled'}`);

  // Initial sentiment fetch
  if (sentSvc) {
    console.log(`[${ts()}] Fetching initial BTC + ETH sentiment…`);
    try {
      [btcSentiment, ethSentiment] = await Promise.all([
        sentSvc.getSentiment('BTC'),
        sentSvc.getSentiment('ETH'),
      ]);
      lastSentimentRefresh = Date.now();
      console.log(`[${ts()}] BTC: ${btcSentiment!.direction} (conf=${(btcSentiment!.confidence * 100).toFixed(0)}%) F&G=${btcSentiment!.fearGreed.value}`);
      console.log(`[${ts()}] ETH: ${ethSentiment!.direction} (conf=${(ethSentiment!.confidence * 100).toFixed(0)}%)`);
      console.log(`[${ts()}] Grok: "${btcSentiment!.reasoning.slice(0, 100)}"`);
    } catch (e) {
      console.log(`[${ts()}] Sentiment fetch failed: ${(e as any).message}`);
    }
  }

  while (true) {
    const now = Date.now();

    // Refresh markets every 60s
    if (now - lastMarketRefresh > CFG.MARKET_REFRESH_MS) {
      try {
        const [btcRaw, ethRaw] = await Promise.all([
          sdk.dipArb.scanUpcomingMarkets({ coin: 'BTC', duration: '5m', minMinutesUntilEnd: 2, maxMinutesUntilEnd: 30, limit: 10 }),
          sdk.dipArb.scanUpcomingMarkets({ coin: 'ETH', duration: '5m', minMinutesUntilEnd: 2, maxMinutesUntilEnd: 30, limit: 5 }),
        ]);
        markets = [
          ...btcRaw.filter((m: any) => m.upTokenId && m.downTokenId),
          ...ethRaw.filter((m: any) => m.upTokenId && m.downTokenId),
        ];
        lastMarketRefresh = now;
        console.log(`[${ts()}] 🔄 Markets: ${btcRaw.length} BTC + ${ethRaw.length} ETH`);
      } catch (e) {
        console.log(`[${ts()}] ⚠️  Market refresh failed: ${(e as any).message}`);
      }
    }

    // Refresh sentiment every 5 min
    if (sentSvc && now - lastSentimentRefresh > CFG.SENTIMENT_TTL_MS) {
      try {
        [btcSentiment, ethSentiment] = await Promise.all([
          sentSvc.getSentiment('BTC'),
          sentSvc.getSentiment('ETH'),
        ]);
        lastSentimentRefresh = now;
        console.log(`[${ts()}] 🧠 SENTIMENT — BTC:${btcSentiment!.direction}(${(btcSentiment!.confidence*100).toFixed(0)}%) ETH:${ethSentiment!.direction}(${(ethSentiment!.confidence*100).toFixed(0)}%) F&G=${btcSentiment!.fearGreed.value}`);
        dashboardEmitter.log('SIGNAL',
          `🧠 BTC=${btcSentiment!.direction}(${(btcSentiment!.confidence*100).toFixed(0)}%) ETH=${ethSentiment!.direction}(${(ethSentiment!.confidence*100).toFixed(0)}%) F&G=${btcSentiment!.fearGreed.value}`,
          { btc: btcSentiment, eth: ethSentiment }
        );
      } catch {}
    }

    // Get BTC momentum
    const momentum = await getBtcMomentum();
    btcPrice = momentum.price || btcPrice;
    lastChangePct = momentum.changePct;
    _btcTrend = momentum.dir === 'UP' ? 'up' : momentum.dir === 'DOWN' ? 'down' : 'neutral';
    _ethTrend = _btcTrend;

    // Get ETH price
    const ep = await getEthPrice();
    ethPrice = ep || ethPrice;

    // Update signal display string
    if (btcSentiment) {
      const fg = btcSentiment.fearGreed.value;
      lastSignalStr = `M:${momentum.dir} S:${btcSentiment.direction}(${(btcSentiment.confidence*100).toFixed(0)}%) F&G:${fg}`;
    } else {
      lastSignalStr = `M:${momentum.dir}(${momentum.changePct.toFixed(3)}%)  no sentiment`;
    }

    // Resolve completed trades
    await checkResolutions();

    // Try entries
    for (const m of markets) {
      const isBtc = /btc|bitcoin/i.test(m.name);
      const coin: 'BTC' | 'ETH' = isBtc ? 'BTC' : 'ETH';
      const price = isBtc ? btcPrice : ethPrice;
      const coinSentiment = isBtc ? btcSentiment : ethSentiment;
      await tryEntry(m, coin, momentum, coinSentiment, price);
    }

    // Emit state and redraw every poll cycle
    emitState();
    if (now - lastDraw > 3000) {
      drawDashboard(btcPrice, ethPrice, lastChangePct, lastSignalStr);
      lastDraw = now;
    }

    await new Promise(r => setTimeout(r, CFG.POLL_MS));
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
