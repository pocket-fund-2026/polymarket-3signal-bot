/**
 * Pure Kelly Criterion — BTC 5m + ETH 5m
 *
 * Each coin's 5-minute up/down markets are traded using that coin's
 * own price momentum. Kelly sizes each bet. One position at a time.
 */

import 'dotenv/config';
import { writeFileSync, appendFileSync } from 'fs';
import { PolymarketSDK } from './src/index.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';

const LOG_FILE = '/tmp/sim-kelly.log';
writeFileSync(LOG_FILE, '');
const origLog = console.log.bind(console);
console.log = (...args: any[]) => {
  const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  origLog(line);
  appendFileSync(LOG_FILE, line + '\n');
};

// ─── Config ───────────────────────────────────────────────────────────────────
const INITIAL_CAPITAL  = parseFloat(process.env.CAPITAL_USD ?? '4.37');
const WIN_PROB         = 0.60;
const MIN_ASK          = 0.40;
const MAX_ASK          = 0.65;
const COOLDOWN_MS      = 25_000;
const POLL_MS          = 3_000;
const MARKET_REFRESH_MS = 60_000;
const CAPITAL_TARGET   = 60.00;
const MAX_PER_COIN     = 1;   // 1 open position per coin (BTC + ETH = 2 max)
const MIN_MINS_LEFT    = 2.0;
const MAX_MINS_LEFT    = 5.0; // true 5-min window

// ─── Types ────────────────────────────────────────────────────────────────────
interface Book { bestBid: number; bestAsk: number; }

interface Market {
  name: string; upTokenId: string; downTokenId: string;
  endTime: Date | number; durationMinutes?: number;
  coin: 'BTC' | 'ETH';
}

interface Price { price: number; changePct: number; dir: 'UP' | 'DOWN' | 'FLAT'; }

interface PendingTrade {
  id: string; market: string; coin: 'BTC' | 'ETH'; side: 'UP' | 'DOWN';
  shares: number; costPerShare: number; totalCost: number;
  entryTs: number; marketEndTs: number; priceAtEntry: number;
}

interface CompletedTrade extends PendingTrade {
  resolution: 'WIN' | 'LOSS'; realProfit: number; priceAtEnd: number;
}

// ─── State ────────────────────────────────────────────────────────────────────
let capital      = INITIAL_CAPITAL;
const pending:   PendingTrade[]   = [];
const completed: CompletedTrade[] = [];
const cooldowns  = new Map<string, number>();

let _peakCapital = INITIAL_CAPITAL;
let _simStart    = Date.now();
let _btc: Price  = { price: 0, changePct: 0, dir: 'FLAT' };
let _eth: Price  = { price: 0, changePct: 0, dir: 'FLAT' };
let _status      = 'starting...';

function ts() { return new Date().toISOString().slice(11, 19); }
function banner(t: string) {
  console.log('\n' + '═'.repeat(62));
  console.log(` ◆ ${t}`);
  console.log('═'.repeat(62));
}

// ─── Terminal dashboard ───────────────────────────────────────────────────────
function printDash() {
  const wins   = completed.filter(t => t.resolution === 'WIN').length;
  const losses = completed.filter(t => t.resolution === 'LOSS').length;
  const pnl    = capital - INITIAL_CAPITAL;
  const elapsed = Math.floor((Date.now() - _simStart) / 60_000);

  const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', W = '\x1b[1m', X = '\x1b[0m';
  const pnlC = pnl >= 0 ? G : R;
  const btcC = _btc.dir === 'UP' ? G : _btc.dir === 'DOWN' ? R : Y;
  const ethC = _eth.dir === 'UP' ? G : _eth.dir === 'DOWN' ? R : Y;
  const btcA = _btc.dir === 'UP' ? '▲' : _btc.dir === 'DOWN' ? '▼' : '─';
  const ethA = _eth.dir === 'UP' ? '▲' : _eth.dir === 'DOWN' ? '▼' : '─';

  const W2 = 60;
  const ln = (s: string) => `║  ${s.padEnd(W2 - 4)}  ║`;
  const dv = `╠${'═'.repeat(W2)}╣`;

  const rows = [
    `╔${'═'.repeat(W2)}╗`,
    ln(`${W}  KELLY BOT  —  BTC 5m + ETH 5m  [entry <3min]${X}`),
    dv,
    ln(`  Capital  ${pnlC}$${capital.toFixed(2).padEnd(9)}${X} Peak $${_peakCapital.toFixed(2).padEnd(8)} → $${CAPITAL_TARGET}`),
    ln(`  P&L      ${pnlC}${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2).padEnd(9)}${X} W:${wins}  L:${losses}  Open:${pending.length}`),
    dv,
    ln(`  BTC  ${btcC}${btcA} $${_btc.price.toFixed(2).padEnd(11)} ${(_btc.changePct >= 0 ? '+' : '') + _btc.changePct.toFixed(3)}%${X}`),
    ln(`  ETH  ${ethC}${ethA} $${_eth.price.toFixed(2).padEnd(11)} ${(_eth.changePct >= 0 ? '+' : '') + _eth.changePct.toFixed(3)}%${X}`),
    ln(`  Status   ${_status.slice(0, W2 - 12)}`),
    ln(`  Runtime  ${elapsed}m  |  ${new Date().toISOString().slice(11, 19)} UTC`),
  ];

  if (pending.length > 0) {
    rows.push(dv);
    rows.push(ln('  OPEN POSITIONS'));
    for (const t of pending) {
      const secLeft = Math.max(0, t.marketEndTs - Date.now());
      const mLeft   = Math.floor(secLeft / 60_000);
      const sLeft   = Math.floor((secLeft % 60_000) / 1000);
      const tStr    = `${mLeft}m ${sLeft.toString().padStart(2,'0')}s`;
      const coinC   = t.coin === 'BTC' ? Y : B;
      rows.push(ln(`  ${coinC}${t.coin}${X} ${t.side.padEnd(5)} ${t.shares}sh @ $${t.costPerShare.toFixed(3)}  cost=$${t.totalCost.toFixed(2)}  ⏱ ${tStr}`));
    }
  }

  // Full trade history
  rows.push(dv);
  rows.push(ln(`  TRADE HISTORY  (prev session: $4.37 → $6.26  4W/2L)`));
  if (completed.length === 0) {
    rows.push(ln(`  no trades yet this session`));
  } else {
    // running capital starts at INITIAL_CAPITAL
    let runCap = INITIAL_CAPITAL;
    for (const t of completed) {
      const icon   = t.resolution === 'WIN' ? `${G}✓${X}` : `${R}✗${X}`;
      const p      = t.realProfit >= 0 ? `${G}+$${t.realProfit.toFixed(2)}${X}` : `${R}-$${Math.abs(t.realProfit).toFixed(2)}${X}`;
      const coinC  = t.coin === 'BTC' ? Y : B;
      runCap      += t.realProfit;
      rows.push(ln(`  ${icon} ${coinC}${t.coin}${X} ${t.side.padEnd(5)} ${t.shares}sh@${t.costPerShare.toFixed(2)}  ${p}  → $${runCap.toFixed(2)}`));
    }
  }

  rows.push(`╚${'═'.repeat(W2)}╝`);
  process.stdout.write('\x1b[H\x1b[J' + rows.join('\n') + '\n');
}

function emitState() {
  _peakCapital = Math.max(_peakCapital, capital);
  const pnl = capital - INITIAL_CAPITAL;
  dashboardEmitter.updateState({
    startTime: _simStart, dailyPnL: pnl, totalPnL: pnl,
    tradesExecuted: completed.length, consecutiveLosses: 0, consecutiveWins: 0,
    monthlyPnL: pnl, monthStartTime: _simStart,
    peakCapital: _peakCapital, currentCapital: capital,
    currentDrawdown: capital < _peakCapital ? (_peakCapital - capital) / _peakCapital : 0,
    permanentlyHalted: false, isPaused: false, pauseUntil: 0, lastDailyReset: _simStart,
    smartMoneyTrades: 0, arbTrades: 0, dipArbTrades: completed.length, directTrades: 0,
    arbProfit: 0, followedWallets: [],
    positions: pending.map(t => ({ market: t.market, side: t.side, shares: t.shares, cost: t.totalCost })),
    activeArbMarket: null, activeDipArbMarket: pending[0]?.market ?? null,
    splits: 0, merges: 0, redeems: 0, swaps: 0,
    usdcBalance: capital, usdcEBalance: 0, maticBalance: 0, unrealizedPnL: 0,
    btcTrend: _btc.dir === 'UP' ? 'up' : _btc.dir === 'DOWN' ? 'down' : 'neutral',
    ethTrend: _eth.dir === 'UP' ? 'up' : _eth.dir === 'DOWN' ? 'down' : 'neutral',
    solTrend: 'neutral',
    dipArb: {
      marketName: pending[0]?.market ?? null, underlying: 'BTC/ETH', duration: '5m',
      endTime: pending[0]?.marketEndTs ?? null,
      upPrice: 0, downPrice: 0, sum: 0,
      status: pending.length > 0 ? 'active' : 'scanning', lastSignal: null, signals: [],
    },
    arbitrage: { status: 'idle', marketsScanned: 0, opportunitiesFound: 0, currentMarket: null, lastOpportunity: null },
    smartMoneySignals: [],
    paper: { balance: capital, initialBalance: INITIAL_CAPITAL, pnl, trades: completed.length, totalVolume: completed.reduce((s, t) => s + t.totalCost, 0) },
  } as any);
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function getBook(tokenId: string): Promise<Book> {
  try {
    const r = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, { signal: AbortSignal.timeout(4000) });
    const d: any = await r.json();
    const bids = (d.bids ?? []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (d.asks ?? []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    return { bestBid: bids[0] ? parseFloat(bids[0].price) : 0, bestAsk: asks[0] ? parseFloat(asks[0].price) : 1 };
  } catch { return { bestBid: 0, bestAsk: 1 }; }
}

async function getPrice(symbol: 'BTCUSDT' | 'ETHUSDT'): Promise<Price> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=3`, { signal: AbortSignal.timeout(5000) });
    const c: any[] = await r.json();
    if (c.length < 2) return { price: 0, changePct: 0, dir: 'FLAT' };
    const prev  = parseFloat(c[0][4]);
    const close = parseFloat(c[c.length - 1][4]);
    const pct   = ((close - prev) / prev) * 100;
    return { price: close, changePct: pct, dir: pct > 0.05 ? 'UP' : pct < -0.05 ? 'DOWN' : 'FLAT' };
  } catch { return { price: 0, changePct: 0, dir: 'FLAT' }; }
}

async function getPriceAt(symbol: 'BTCUSDT' | 'ETHUSDT', ms: number): Promise<number> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${ms - 60000}&endTime=${ms + 60000}&limit=3`, { signal: AbortSignal.timeout(5000) });
    const c: any[] = await r.json();
    return c.length ? parseFloat(c[c.length - 1][4]) : 0;
  } catch { return 0; }
}

// ─── Kelly ────────────────────────────────────────────────────────────────────
function kellyFraction(ask: number): number {
  const b = (1 - ask) / ask;
  const f = (b * WIN_PROB - (1 - WIN_PROB)) / b;
  return Math.max(0, Math.min(f, 0.30));
}

// ─── Resolution ───────────────────────────────────────────────────────────────
async function checkResolutions(): Promise<void> {
  const toResolve = pending.filter(t => Date.now() > t.marketEndTs + 5000);
  for (const trade of toResolve) {
    pending.splice(pending.indexOf(trade), 1);
    const symbol    = trade.coin === 'BTC' ? 'BTCUSDT' : 'ETHUSDT';
    const priceEnd  = await getPriceAt(symbol, trade.marketEndTs);
    const priceStart = trade.priceAtEntry;
    let resolution: 'WIN' | 'LOSS';
    let realProfit: number;
    if (priceEnd === 0 || priceStart === 0) {
      resolution = 'WIN'; realProfit = 0;
    } else {
      const weWon = trade.side === 'UP' ? priceEnd >= priceStart : priceEnd < priceStart;
      resolution  = weWon ? 'WIN' : 'LOSS';
      realProfit  = weWon
        ? (1 - trade.costPerShare) * trade.shares
        : -trade.costPerShare * trade.shares;
    }
    capital += realProfit;
    completed.push({ ...trade, resolution, realProfit, priceAtEnd: priceEnd });
    _status = `${resolution === 'WIN' ? '✅ WIN' : '❌ LOSS'} ${trade.coin} ${trade.side} — cap=$${capital.toFixed(2)}`;

    dashboardEmitter.log(resolution === 'WIN' ? 'TRADE' : 'WARN',
      `${resolution === 'WIN' ? '✅' : '❌'} ${resolution}: ${trade.coin} ${trade.side} ${trade.shares}sh @ ${trade.costPerShare.toFixed(3)} | P&L ${realProfit >= 0 ? '+' : ''}$${realProfit.toFixed(3)} | cap=$${capital.toFixed(2)}`,
      { resolution, coin: trade.coin, side: trade.side, profit: realProfit, capital }
    );
    emitState();
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────
async function tryEntry(markets: Market[], prices: Record<'BTC' | 'ETH', Price>): Promise<void> {
  for (const market of markets) {
    // Per-coin cap: skip if already holding one of this coin
    if (pending.filter(t => t.coin === market.coin).length >= MAX_PER_COIN) continue;

    const px = prices[market.coin];
    if (px.dir === 'FLAT' || px.price === 0) continue;

    const mId    = market.upTokenId;
    const now    = Date.now();
    const endTs  = market.endTime instanceof Date
      ? market.endTime.getTime()
      : (market.endTime as unknown as number) * 1000;
    const minsLeft = (endTs - now) / 60_000;
    if (minsLeft < MIN_MINS_LEFT || minsLeft > MAX_MINS_LEFT) continue;

    if ((cooldowns.get(mId) ?? 0) + COOLDOWN_MS > now) continue;
    if (pending.some(t => t.market === market.name)) continue;

    const direction = px.dir as 'UP' | 'DOWN';
    const tokenId   = direction === 'UP' ? market.upTokenId : market.downTokenId;
    const book      = await getBook(tokenId);
    const ask       = book.bestAsk;

    if (ask <= 0 || ask < MIN_ASK || ask > MAX_ASK) continue;

    const fraction  = kellyFraction(ask);
    if (fraction <= 0) continue;

    const shares    = Math.max(1, Math.floor((capital * fraction) / ask));
    const totalCost = shares * ask;
    if (totalCost > capital * 0.40 || totalCost > capital) continue;

    const trade: PendingTrade = {
      id: `k-${Date.now()}`, market: market.name, coin: market.coin, side: direction,
      shares, costPerShare: ask, totalCost,
      entryTs: now, marketEndTs: endTs, priceAtEntry: px.price,
    };
    pending.push(trade);
    cooldowns.set(mId, now);

    const mLeft = minsLeft.toFixed(1);
    _status = `ENTERED ${market.coin} ${direction} ${shares}sh @ $${ask.toFixed(3)} | T-${mLeft}m`;
    dashboardEmitter.log('TRADE',
      `⚡ KELLY ${market.coin} ${direction}: ${shares}sh @ ${ask.toFixed(3)} = $${totalCost.toFixed(2)} | f=${(fraction*100).toFixed(1)}% | T-${mLeft}m`,
      { coin: market.coin, side: direction, shares, ask, totalCost }
    );
    emitState();
    return; // one trade per cycle
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await startDashboard();

  const sdk = new PolymarketSDK({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
  let markets: Market[] = [];
  let lastRefresh = 0;
  let _wasFlat = false;

  banner(`KELLY BOT — BTC 5m + ETH 5m | Entry <3 min left | Start $${INITIAL_CAPITAL} → $${CAPITAL_TARGET}`);
  console.log(` Capital:  $${INITIAL_CAPITAL}`);
  console.log(` Logic:    BTC momentum → BTC markets | ETH momentum → ETH markets`);
  console.log(` Sizing:   Kelly f* = (b·p − q)/b  |  p=${WIN_PROB}  |  max 30%`);
  console.log(` Limit:    1 BTC position + 1 ETH position simultaneously`);
  console.log(` Mode:     🟡 DRY RUN`);
  console.log(` Dashboard: http://localhost:3001`);

  const [ib, ie] = await Promise.all([getPrice('BTCUSDT'), getPrice('ETHUSDT')]);
  _btc = ib; _eth = ie;
  console.log(` BTC @ $${_btc.price.toFixed(2)} ${_btc.dir}  |  ETH @ $${_eth.price.toFixed(2)} ${_eth.dir}`);
  emitState();

  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));

    // Refresh market list
    if (Date.now() - lastRefresh > MARKET_REFRESH_MS) {
      try {
        const [btcRaw, ethRaw] = await Promise.all([
          sdk.dipArb.scanUpcomingMarkets({ coin: 'BTC', duration: '5m', minMinutesUntilEnd: 1, maxMinutesUntilEnd: 30, limit: 10 }),
          sdk.dipArb.scanUpcomingMarkets({ coin: 'ETH', duration: '5m', minMinutesUntilEnd: 1, maxMinutesUntilEnd: 30, limit: 10 }),
        ]);
        const btcM = btcRaw.filter((m: any) => m.upTokenId && m.downTokenId).map((m: any) => ({ ...m, coin: 'BTC' as const }));
        const ethM = ethRaw.filter((m: any) => m.upTokenId && m.downTokenId).map((m: any) => ({ ...m, coin: 'ETH' as const }));
        markets = [...btcM, ...ethM];
        lastRefresh = Date.now();
        console.log(`[${ts()}] 🔄 ${btcM.length} BTC + ${ethM.length} ETH markets`);
      } catch (e: any) {
        console.log(`[${ts()}] ⚠️  Market refresh failed: ${e?.message?.slice(0, 50)}`);
      }
    }

    await checkResolutions();

    const [btc, eth] = await Promise.all([getPrice('BTCUSDT'), getPrice('ETHUSDT')]);
    _btc = btc; _eth = eth;

    if (capital >= CAPITAL_TARGET) {
      banner(`🎯 TARGET $${CAPITAL_TARGET} REACHED!`);
      process.exit(0);
    }

    if (markets.length > 0) {
      _status = `BTC ${btc.dir} (${btc.changePct >= 0 ? '+' : ''}${btc.changePct.toFixed(3)}%)  ETH ${eth.dir} (${eth.changePct >= 0 ? '+' : ''}${eth.changePct.toFixed(3)}%)`;
      const bothFlat = btc.dir === 'FLAT' && eth.dir === 'FLAT';
      if (bothFlat && !_wasFlat) {
        _status = `⏸ BOTH FLAT — BTC ${btc.changePct >= 0 ? '+' : ''}${btc.changePct.toFixed(3)}%  ETH ${eth.changePct >= 0 ? '+' : ''}${eth.changePct.toFixed(3)}%`;
      }
      _wasFlat = bothFlat;
      await tryEntry(markets, { BTC: btc, ETH: eth });
    }

    emitState();
    printDash();
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
