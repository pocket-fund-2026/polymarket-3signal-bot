import { readFileSync, writeFileSync, existsSync } from 'fs';

// ============================================================================
// Types
// ============================================================================

type Strategy = 'dipArb' | 'arbitrage' | 'smartMoney';

interface TradeRecord {
  timestamp: number;
  strategy: Strategy;
  profit: number;
  success: boolean;
}

interface StrategyStats {
  trades: number;
  wins: number;
  totalProfit: number;
  recentTrades: TradeRecord[];
}

interface AdaptedConfig {
  dipArb: { sumTarget: number; shares: number };
  smartMoney: { maxSizePerTrade: number };
  arbitrage: { minTradeSize: number };
}

interface MemoryState {
  strategies: Partial<Record<Strategy, StrategyStats>>;
  adaptedConfig: AdaptedConfig;
  lastAdaptedAt: number;
  adaptationLog: string[];
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS: AdaptedConfig = {
  dipArb:     { sumTarget: 0.92, shares: 3 },
  smartMoney: { maxSizePerTrade: 1 },
  arbitrage:  { minTradeSize: 1 },
};

const WINDOW = 20;  // rolling trade window per strategy

// Realistic BTC 5m DipArb defaults (used before enough trades accumulate):
//   Win: 8% profit on sumTarget=0.92, 3 shares → $0.24
//   Loss: failed Leg2 exit with ~25% slippage on Leg1 cost ($4.60 * 0.25 ≈ $1.15, round to $2)
const DEFAULT_AVG_WIN_DIPARB  = 0.80;
const DEFAULT_AVG_LOSS_DIPARB = 2.00;

// ============================================================================
// PerformanceMemory
// ============================================================================

export class PerformanceMemory {
  private state: MemoryState;
  private readonly filePath: string;
  private readonly capital: number;   // total USDC capital (from CAPITAL_USD env)

  constructor(filePath = './bot-memory.json', capital?: number) {
    this.filePath = filePath;
    this.capital = capital ?? parseFloat(process.env.CAPITAL_USD ?? '250');
    this.state = this.load();
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Record a completed trade and return any adaptation that fired. */
  record(strategy: Strategy, success: boolean, profit: number): string | null {
    if (!this.state.strategies[strategy]) {
      this.state.strategies[strategy] = { trades: 0, wins: 0, totalProfit: 0, recentTrades: [] };
    }
    const s = this.state.strategies[strategy]!;
    s.trades++;
    if (success && profit > 0) s.wins++;
    s.totalProfit += profit;
    s.recentTrades.unshift({ timestamp: Date.now(), strategy, profit, success });
    if (s.recentTrades.length > WINDOW) s.recentTrades = s.recentTrades.slice(0, WINDOW);
    const msg = this.adapt(strategy);
    this.save();
    return msg;
  }

  /** Current adapted config — apply this to the strategy on startup + after each record(). */
  getConfig(): AdaptedConfig {
    return this.state.adaptedConfig;
  }

  /** Rolling stats per strategy. */
  getStats(): Partial<Record<Strategy, { trades: number; winRate: number; totalProfit: number }>> {
    const out: Partial<Record<Strategy, { trades: number; winRate: number; totalProfit: number }>> = {};
    for (const [k, s] of Object.entries(this.state.strategies) as [Strategy, StrategyStats][]) {
      out[k] = {
        trades: s.trades,
        winRate: s.trades > 0 ? s.wins / s.trades : 0,
        totalProfit: s.totalProfit,
      };
    }
    return out;
  }

  /** Last N adaptation messages for display. */
  getAdaptationLog(n = 10): string[] {
    return this.state.adaptationLog.slice(0, n);
  }

  // --------------------------------------------------------------------------
  // Core adaptation logic (polymath: agentic-memory + Kelly criterion sizing)
  // --------------------------------------------------------------------------

  /**
   * Kelly criterion: f* = W/L - (1-W)/W
   * where W = win rate, L = loss rate (1-W), win/loss payoff assumed symmetric.
   * We use fractional Kelly (25%) for safety. Returns fraction of capital to risk.
   */
  private kelly(winRate: number, avgWin: number, avgLoss: number): number {
    if (avgLoss === 0 || winRate <= 0) return 0;
    const b = avgWin / avgLoss;           // win/loss ratio
    const q = 1 - winRate;
    const full = (b * winRate - q) / b;   // full Kelly fraction
    return Math.max(0, full * 0.25);      // quarter-Kelly for safety
  }

  private adapt(strategy: Strategy): string | null {
    const s = this.state.strategies[strategy];
    if (!s || s.recentTrades.length < 5) return null;

    const wins   = s.recentTrades.filter(t => t.success && t.profit > 0);
    const losses = s.recentTrades.filter(t => !t.success || t.profit <= 0);
    const winRate = wins.length / s.recentTrades.length;

    // Use strategy-specific realistic defaults before enough data accumulates.
    // BTC 5m DipArb: win = ~$0.80 (8% on 10 shares), loss = ~$2.00 (failed exit slippage).
    const defaultAvgWin  = strategy === 'dipArb' ? DEFAULT_AVG_WIN_DIPARB  : 1.0;
    const defaultAvgLoss = strategy === 'dipArb' ? DEFAULT_AVG_LOSS_DIPARB : 1.0;
    const avgWin  = wins.length   ? wins.reduce((a, t)   => a + t.profit, 0)          / wins.length   : defaultAvgWin;
    const avgLoss = losses.length ? losses.reduce((a, t) => a + Math.abs(t.profit), 0) / losses.length : defaultAvgLoss;
    const kellyFrac = this.kelly(winRate, avgWin, avgLoss);
    const changes: string[] = [];

    if (strategy === 'dipArb') {
      const cfg = this.state.adaptedConfig.dipArb;

      // sumTarget: lower = tighter filter (fewer but higher-quality trades)
      //            higher = looser filter (more trades, thinner margins)
      if (winRate > 0.70 && cfg.sumTarget > 0.88) {
        cfg.sumTarget = parseFloat((cfg.sumTarget - 0.01).toFixed(2));
        changes.push(`sumTarget ↓ ${cfg.sumTarget} (win rate ${(winRate * 100).toFixed(0)}% — tightening)`);
      } else if (winRate < 0.45 && cfg.sumTarget < 0.95) {
        cfg.sumTarget = parseFloat((cfg.sumTarget + 0.01).toFixed(2));
        changes.push(`sumTarget ↑ ${cfg.sumTarget} (win rate ${(winRate * 100).toFixed(0)}% — loosening)`);
      }

      // Kelly-optimal share count.
      // Cost per complete round = sumTarget × shares (both legs combined).
      // Correct formula: shares = (kellyFrac × capital) / sumTarget
      // Previous code used /0.46 which was /sumTarget*2 — 2× overcount fixed here.
      if (s.recentTrades.length >= 10) {
        const costPerRound = cfg.sumTarget;  // cost per share-pair at current sumTarget
        const kellyShares = Math.round((kellyFrac * this.capital) / costPerRound);
        const target = Math.max(3, Math.min(25, kellyShares));  // floor=3 → ~$1/leg minimum
        if (target !== cfg.shares) {
          cfg.shares = target;
          changes.push(`shares → ${cfg.shares} (Kelly ${(kellyFrac * 100).toFixed(1)}% of $${this.capital})`);
        }
      }
    }

    if (strategy === 'smartMoney') {
      const cfg = this.state.adaptedConfig.smartMoney;
      // Kelly-scaled max size: kellyFrac × capital, clamped [$5, $15]
      if (s.recentTrades.length >= 10) {
        const kellySize = Math.round(kellyFrac * this.capital);
        const target = Math.max(5, Math.min(15, kellySize));
        if (target !== cfg.maxSizePerTrade) {
          cfg.maxSizePerTrade = target;
          changes.push(`maxSizePerTrade → $${cfg.maxSizePerTrade} (Kelly ${(kellyFrac * 100).toFixed(1)}%)`);
        }
      }
    }

    if (strategy === 'arbitrage') {
      const cfg = this.state.adaptedConfig.arbitrage;
      if (winRate > 0.75 && cfg.minTradeSize < 20) {
        cfg.minTradeSize = Math.min(20, cfg.minTradeSize + 2);
        changes.push(`arb.minTradeSize ↑ ${cfg.minTradeSize} (solid win rate)`);
      } else if (winRate < 0.40 && cfg.minTradeSize > 3) {
        cfg.minTradeSize = Math.max(3, cfg.minTradeSize - 1);
        changes.push(`arb.minTradeSize ↓ ${cfg.minTradeSize} (low win rate — raising bar)`);
      }
    }

    if (!changes.length) return null;

    this.state.lastAdaptedAt = Date.now();
    const msg = `[ADAPT:${strategy}] ${changes.join(' | ')}`;
    this.state.adaptationLog.unshift(msg);
    if (this.state.adaptationLog.length > 50) this.state.adaptationLog = this.state.adaptationLog.slice(0, 50);
    return msg;
  }

  /** Positive = consecutive wins, negative = consecutive losses. */
  private streak(strategy: Strategy): number {
    const trades = this.state.strategies[strategy]?.recentTrades ?? [];
    if (!trades.length) return 0;
    const first = trades[0].success;
    let n = 0;
    for (const t of trades) {
      if (t.success === first) n++;
      else break;
    }
    return first ? n : -n;
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private load(): MemoryState {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as MemoryState;
        // Merge with defaults so new fields appear after upgrades
        raw.adaptedConfig = { ...DEFAULTS, ...raw.adaptedConfig };
        raw.adaptationLog = raw.adaptationLog ?? [];
        return raw;
      } catch {
        // Corrupt file — start fresh
      }
    }
    return {
      strategies: {},
      adaptedConfig: { ...DEFAULTS },
      lastAdaptedAt: 0,
      adaptationLog: [],
    };
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch {
      // Non-fatal — bot continues without persistence
    }
  }
}
