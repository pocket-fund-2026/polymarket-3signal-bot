import type { BotState } from '../types';

interface TrendIndicatorsProps {
  state: BotState | null;
}

type Trend = 'up' | 'down' | 'neutral';

function SignalBar({ label, weight, color }: { label: string; weight: number; color: string }) {
  const pct = Math.round(weight * 100);
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] text-gray-500 w-7 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] font-mono text-gray-400 w-6 text-right">{pct}%</span>
    </div>
  );
}

export function TrendIndicators({ state }: TrendIndicatorsProps) {
  const getTrendBadge = (t: Trend) => {
    switch (t) {
      case 'up': return { arrow: '↗', class: 'badge-green' };
      case 'down': return { arrow: '↘', class: 'badge-red' };
      default: return { arrow: '→', class: 'bg-gray-500/20 text-gray-400 border border-gray-500/30' };
    }
  };

  const trends = [
    { coin: 'BTC', icon: '₿', trend: state?.btcTrend ?? 'neutral', color: 'bg-orange-500/20' },
    { coin: 'ETH', icon: 'Ξ', trend: state?.ethTrend ?? 'neutral', color: 'bg-blue-500/20' },
    { coin: 'SOL', icon: '◎', trend: state?.solTrend ?? 'neutral', color: 'bg-purple-500/20' },
  ];

  const sw = state?.signalWeights;
  const defaultWeights = { momentum: 0.35, sentiment: 0.35, fearGreed: 0.15, smartMoney: 0.15 };
  const weights = sw ?? defaultWeights;
  const evolved = sw && sw.tradesSeen >= 8;

  return (
    <div className="glass-card rounded-xl p-3 space-y-3">
      {/* Trend row */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-base">📊</span>
            <span className="text-sm font-medium text-white">Market Trends</span>
          </div>
          <span className="text-[10px] text-gray-500">15m K-lines</span>
        </div>
        <div className="flex gap-2">
          {trends.map(({ coin, icon, trend, color }) => {
            const badge = getTrendBadge(trend as Trend);
            return (
              <div key={coin} className="flex-1 flex items-center justify-between p-2 rounded-lg bg-poly-dark/50">
                <div className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-md ${color} flex items-center justify-center text-xs`}>
                    {icon}
                  </div>
                  <span className="text-xs font-medium text-white">{coin}</span>
                </div>
                <span className={`badge text-[10px] px-1.5 py-0.5 ${badge.class}`}>
                  {badge.arrow} {trend.toUpperCase()}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Signal evolution row */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-gray-400 font-medium">
            {evolved ? '🧠 Evolved Weights' : '⚖️ Signal Weights'}
          </span>
          <span className="text-[9px] text-gray-600">
            {evolved ? `auto-tuned · ${sw!.tradesSeen} trades` : 'static · learning…'}
          </span>
        </div>
        <div className="space-y-1">
          <SignalBar label="BTC"  weight={weights.momentum}                  color="bg-orange-400" />
          <SignalBar label="ETH"  weight={(weights as any).ethMomentum ?? 0} color="bg-blue-500" />
          <SignalBar label="SENT" weight={weights.sentiment}                  color="bg-blue-400" />
          <SignalBar label="F&G"  weight={weights.fearGreed}                  color="bg-yellow-400" />
          <SignalBar label="FLOW" weight={(weights as any).bookFlow ?? 0}     color="bg-emerald-400" />
        </div>

        {/* Kelly + volatility stats */}
        {sw && (
          <div className="flex gap-2 mt-2 pt-1.5 border-t border-white/5">
            <div className="flex-1 text-center">
              <div className="text-[9px] text-gray-500">Kelly Size</div>
              <div className="text-[11px] font-mono font-bold text-emerald-400">
                {(sw.currentKelly * 100).toFixed(1)}%
                {sw.winStreak >= 2 && <span className="text-orange-400 ml-0.5">🔥{sw.winStreak}</span>}
              </div>
            </div>
            <div className="flex-1 text-center">
              <div className="text-[9px] text-gray-500">Threshold</div>
              <div className="text-[11px] font-mono font-bold text-blue-400">
                ±{sw.currentThreshold?.toFixed(2) ?? '0.15'}
              </div>
            </div>
            <div className="flex-1 text-center">
              <div className="text-[9px] text-gray-500">Volatility</div>
              <div className={`text-[11px] font-mono font-bold ${
                (sw.volatility ?? 0) > 0.10 ? 'text-rose-400' :
                (sw.volatility ?? 0) < 0.03 ? 'text-emerald-400' : 'text-yellow-400'
              }`}>
                {((sw.volatility ?? 0) * 100).toFixed(3)}%
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
