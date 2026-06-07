import type { BotState, LogEntry, WeatherPosition, WeatherCompleted } from '../types';

interface Props {
  state: BotState | null;
  logs?: LogEntry[];
}

function EdgeBadge({ edge }: { edge: number }) {
  const pct = Math.round(Math.abs(edge) * 100);
  const color = pct > 40 ? 'text-emerald-400' : pct > 20 ? 'text-yellow-400' : 'text-orange-400';
  return <span className={`font-mono text-xs ${color}`}>{edge > 0 ? '+' : '-'}{pct}%</span>;
}

function DirectionBadge({ direction }: { direction: 'YES' | 'NO' }) {
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
      direction === 'YES' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
    }`}>
      {direction}
    </span>
  );
}

function PositionRow({ pos, isLog }: { pos: WeatherPosition; isLog?: boolean }) {
  const now = Date.now();
  const minsLeft = Math.max(0, Math.round((pos.endTs - now) / 60_000));
  const hoursLeft = Math.floor(minsLeft / 60);
  const timeStr = hoursLeft > 0 ? `${hoursLeft}h ${minsLeft % 60}m` : `${minsLeft}m`;
  const potentialWin = ((1 - pos.entryPrice) * pos.shares).toFixed(2);

  return (
    <div className="bg-white/[0.03] rounded-lg p-2.5 border border-white/5 hover:border-white/10 transition-colors">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm">🌤</span>
          <span className="text-white text-xs font-medium">{pos.cityName}</span>
          <DirectionBadge direction={pos.direction} />
          <span className="text-gray-400 text-xs">{pos.temp}°C</span>
          {isLog && <span className="text-[9px] text-gray-600 italic">from log</span>}
        </div>
        <EdgeBadge edge={pos.edge} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-[10px] text-gray-400">
        <div>
          <div className="text-gray-500">Forecast</div>
          <div className="text-blue-300 font-mono">{pos.forecastTemp?.toFixed(1)}°C</div>
        </div>
        <div>
          <div className="text-gray-500">Entry / Mkt</div>
          <div className="font-mono">${pos.entryPrice?.toFixed(3)} / {((pos.marketYes ?? 0) * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-gray-500">Win / Time</div>
          <div className="text-emerald-400 font-mono">+${potentialWin} ({timeStr})</div>
        </div>
      </div>
    </div>
  );
}

function CompletedRow({ pos }: { pos: WeatherCompleted }) {
  const won = pos.resolution === 'WIN';
  return (
    <div className={`bg-white/[0.02] rounded-lg p-2 border ${won ? 'border-emerald-500/20' : 'border-rose-500/20'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span>{won ? '✅' : '❌'}</span>
          <span className="text-xs text-white">{pos.cityName} {pos.temp}°C</span>
          <DirectionBadge direction={pos.direction} />
        </div>
        <span className={`text-xs font-mono font-bold ${won ? 'text-emerald-400' : 'text-rose-400'}`}>
          {pos.profit >= 0 ? '+' : ''}${pos.profit?.toFixed(2)}
        </span>
      </div>
      <div className="text-[10px] text-gray-500 mt-0.5">
        Forecast {pos.forecastTemp?.toFixed(1)}°C | Entry ${pos.entryPrice?.toFixed(3)} | Final YES {((pos.finalYes ?? 0) * 100).toFixed(0)}%
      </div>
    </div>
  );
}

// Parse weather trade data from activity logs (used when state doesn't yet include weatherPositions)
function extractFromLogs(logs: LogEntry[]): WeatherPosition[] {
  const WEATHER_END_TS = new Date('2026-06-07T12:00:00Z').getTime();
  const seen = new Set<string>();
  const positions: WeatherPosition[] = [];

  for (const log of logs) {
    if (log.level !== 'TRADE') continue;
    if (!log.message.includes('WEATHER')) continue;

    const d = log.data as Record<string, unknown> | undefined;
    if (!d) continue;

    // Check for entry (has entryPrice)
    if (d.entryPrice !== undefined && d.city && !d.profit && !d.finalYes) {
      const key = `${d.city}-${d.temp}-${d.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);

      positions.push({
        id: `log-${log.id}`,
        city: d.city as string,
        cityName: (d.city as string).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        temp: d.temp as number,
        direction: d.direction as 'YES' | 'NO',
        entryPrice: d.entryPrice as number,
        shares: Math.floor(((d.totalCost as number) ?? 0) / (d.entryPrice as number) || 1),
        totalCost: (d.totalCost as number) ?? (d.entryPrice as number),
        forecastTemp: d.forecast as number,
        modelProb: 0,
        marketYes: (d.marketYes as number) ?? 0,
        edge: d.edge as number,
        question: log.message,
        endTs: WEATHER_END_TS,
      });
    }
  }

  return positions;
}

export function WeatherPanel({ state, logs = [] }: Props) {
  // Prefer state (richer), fall back to log parsing
  const statePending   = state?.weatherPositions   ?? [];
  const stateCompleted = state?.weatherCompleted   ?? [];

  const logPending = statePending.length === 0 ? extractFromLogs(logs) : [];

  const pending   = statePending.length > 0 ? statePending : logPending;
  const completed = stateCompleted;

  const wxWins    = completed.filter(t => t.resolution === 'WIN').length;
  const wxLosses  = completed.filter(t => t.resolution === 'LOSS').length;
  const wxPnL     = completed.reduce((s, t) => s + (t.profit ?? 0), 0);
  const totalCost = pending.reduce((s, p) => s + (p.totalCost ?? 0), 0);

  if (pending.length === 0 && completed.length === 0) {
    return (
      <div className="bg-poly-card rounded-xl border border-white/5 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">🌤</span>
          <h3 className="text-sm font-semibold text-white">Weather Markets</h3>
          <span className="text-[10px] text-gray-500 ml-auto">June 7 · Airport stations</span>
        </div>
        <p className="text-xs text-gray-500 text-center py-4">Scanning June 7 temperature markets…</p>
      </div>
    );
  }

  return (
    <div className="bg-poly-card rounded-xl border border-white/5 p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">🌤</span>
        <h3 className="text-sm font-semibold text-white">Weather Markets</h3>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-gray-400">
          {completed.length > 0 && (
            <span className={wxPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {wxWins}W/{wxLosses}L {wxPnL >= 0 ? '+' : ''}${wxPnL.toFixed(2)}
            </span>
          )}
          <span className="text-gray-500">
            {pending.length} open · ${totalCost.toFixed(2)} at risk · June 7 noon UTC
          </span>
        </div>
      </div>

      {/* Open Positions */}
      {pending.length > 0 && (
        <div className="space-y-2 mb-3">
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Open Positions</div>
          {pending.map((pos, i) => (
            <PositionRow key={pos.id ?? i} pos={pos} isLog={statePending.length === 0} />
          ))}
        </div>
      )}

      {/* Completed */}
      {completed.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Resolved</div>
          {completed.slice(0, 5).map((pos, i) => (
            <CompletedRow key={pos.id ?? i} pos={pos} />
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="mt-2 pt-2 border-t border-white/5 text-[10px] text-gray-600 flex justify-between">
        <span>Airport stations (METAR-calibrated) · σ=2°C · min edge 15%</span>
        <span>Resolves: June 7 12:00 UTC</span>
      </div>
    </div>
  );
}
