/**
 * MultiLegRouteCard — displays a calculated multi-leg route result.
 * Used when the routing engine returns a RouteResult with found=true.
 * Preserves the existing single-line RouteCard styling conventions.
 */
import { ArrowRight, RefreshCw, AlertTriangle, Clock, CreditCard, Info } from 'lucide-react';
import type { RouteResult, RouteLeg, Transfer } from '../data/routingEngine';
import { STATION_BY_ID, TIMETABLE_NOTICE } from '../data/stationData';

interface MultiLegRouteCardProps {
  result: RouteResult;
  delayMin: number;
}

const LINE_COLORS: Record<string, { dot: string; badge: string; text: string }> = {
  blue:   { dot: '#1D4ED8', badge: 'bg-blue-100 text-blue-800',   text: 'Blue Line'   },
  red:    { dot: '#B91C1C', badge: 'bg-red-100 text-red-700',     text: 'Red Line'    },
  yellow: { dot: '#CA8A04', badge: 'bg-yellow-100 text-yellow-800', text: 'Yellow Line' },
  violet: { dot: '#7C3AED', badge: 'bg-violet-100 text-violet-800', text: 'Violet Line' },
};

function StopList({ leg }: { leg: RouteLeg }) {
  const colors = LINE_COLORS[leg.line.id] ?? { dot: '#888', badge: 'bg-gray-100 text-gray-700' };
  const stations = leg.stationIds.map((id) => STATION_BY_ID[id]);

  return (
    <ol
      aria-label={`Stops on ${leg.line.shortName}`}
      className="relative border-l-2 pl-5 space-y-1.5 my-2"
      style={{ borderColor: leg.line.hexColor }}
    >
      {stations.map((station, idx) => {
        const isFirst = idx === 0;
        const isLast  = idx === stations.length - 1;
        const isHighlighted = isFirst || isLast;

        return (
          <li key={station.id} className="relative">
            <span
              className="absolute -left-[21px] top-1 w-3 h-3 rounded-full border-2"
              style={{
                backgroundColor: isHighlighted ? leg.line.hexColor : '#e5e7eb',
                borderColor:     isHighlighted ? '#fff' : '#d1d5db',
              }}
              aria-hidden="true"
            />
            <div className="flex items-start gap-1.5 flex-wrap">
              <span
                className={`text-xs leading-snug ${
                  isHighlighted ? 'font-bold text-gray-900' : 'text-gray-500'
                }`}
              >
                {station.name}
              </span>
              {isFirst && (
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-white"
                  style={{ backgroundColor: leg.line.hexColor }}
                >
                  Board
                </span>
              )}
              {isLast && (
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-white"
                  style={{ backgroundColor: leg.line.hexColor }}
                >
                  Alight
                </span>
              )}
              {station.isTerminus && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                  Terminus
                </span>
              )}
              {station.otherModes?.map((mode) => (
                <span
                  key={mode}
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                    mode === 'brts'  ? 'bg-green-100 text-green-800'  :
                    mode === 'amts'  ? 'bg-orange-100 text-orange-700':
                    mode === 'auto'  ? 'bg-yellow-100 text-yellow-800':
                    'bg-gray-100 text-gray-600'
                  }`}
                >
                  {mode.toUpperCase()}
                </span>
              ))}
              {(colors.badge && station.lineIds.length > 1) && (
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${colors.badge}`}>
                  Interchange
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TransferBadge({ transfer }: { transfer: Transfer }) {
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs border ${
        transfer.isSimulated
          ? 'bg-amber-50 border-amber-300 text-amber-800'
          : 'bg-blue-50 border-blue-200 text-blue-800'
      }`}
    >
      <RefreshCw size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        <strong>Transfer</strong> at{' '}
        <strong>{transfer.atStation.name}</strong> — change to{' '}
        <strong>{transfer.toLine.shortName}</strong>
        {transfer.isSimulated && (
          <span className="ml-1 font-semibold text-amber-700">[SIMULATED — demo only]</span>
        )}
      </span>
    </div>
  );
}

export default function MultiLegRouteCard({ result, delayMin }: MultiLegRouteCardProps) {
  if (!result.found) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm px-5 py-4">
        <div className="flex items-start gap-2 text-red-700 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            <strong>No route found: </strong>{result.reason}
          </span>
        </div>
      </div>
    );
  }

  const hasDelay = delayMin > 0;
  const fromStation = STATION_BY_ID[result.boardStationId];
  const toStation   = STATION_BY_ID[result.alightStationId];

  // Estimate journey time: sum of leg stop counts × approx minutes per stop (2.5 min)
  const estimatedMin = Math.round(result.totalStops * 2.5) + (result.transferCount * 3);
  const adjustedMin  = estimatedMin + delayMin;

  return (
    <section
      aria-labelledby="multileg-route-heading"
      className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden"
    >
      {/* Header */}
      <div className="px-5 py-3 bg-[#0B2545]/5 border-b border-gray-100 flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-[#0B2545]" id="multileg-route-heading">
          {fromStation?.name ?? result.boardStationId}
        </span>
        <ArrowRight size={14} className="text-gray-400 shrink-0" aria-hidden="true" />
        <span className="text-sm font-bold text-[#0B2545]">
          {toStation?.name ?? result.alightStationId}
        </span>
        {result.warnings.length > 0 && (
          <span className="ml-auto text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5">
            ⚠ Demo warnings
          </span>
        )}
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Stats */}
        <div className="flex flex-wrap gap-4 text-xs text-gray-600">
          <span className="flex items-center gap-1">
            <Clock size={13} className="text-[#0B2545]" aria-hidden="true" />
            Journey:{' '}
            <strong className={`ml-0.5 ${hasDelay ? 'text-red-600' : 'text-gray-800'}`}>
              ~{adjustedMin} min (sim.){hasDelay && ` +${delayMin} min delay`}
            </strong>
          </span>
          <span className="flex items-center gap-1">
            <RefreshCw size={13} className="text-[#0B2545]" aria-hidden="true" />
            Transfers: <strong className="ml-0.5 text-gray-800">{result.transferCount}</strong>
          </span>
          <span className="flex items-center gap-1">
            Stops: <strong className="ml-0.5 text-gray-800">{result.totalStops}</strong>
          </span>
          <span className="flex items-center gap-1">
            <CreditCard size={13} className="text-[#0B2545]" aria-hidden="true" />
            Fare: <strong className="ml-0.5 text-gray-800">₹{Math.max(10, result.totalStops * 2)} (sim.)</strong>
          </span>
        </div>

        {/* Delay alert */}
        {hasDelay && (
          <div
            role="alert"
            className="flex items-start gap-2 bg-red-50 border border-red-300 text-red-700 rounded-md px-3 py-2 text-xs"
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              <strong>Simulated delay:</strong> +{delayMin} min on this route (demo only).
            </span>
          </div>
        )}

        {/* Timetable notice */}
        <div className="flex items-start gap-1.5 text-[11px] text-gray-400 italic">
          <Info size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
          {TIMETABLE_NOTICE}
        </div>

        {/* Warnings */}
        {result.warnings.map((w, i) => (
          <div
            key={i}
            role="note"
            className="flex items-start gap-2 bg-amber-50 border border-amber-300 text-amber-800 rounded-md px-3 py-2 text-xs"
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{w}</span>
          </div>
        ))}

        {/* Same station edge case */}
        {result.legs.length === 0 && (
          <p className="text-sm text-gray-600 italic">
            Boarding and destination are the same station.
          </p>
        )}

        {/* Legs and transfers interleaved */}
        {result.legs.map((leg, idx) => {
          const colors = LINE_COLORS[leg.line.id] ?? { dot: '#888', badge: '' };
          const transfer = result.transfers[idx];

          return (
            <div key={idx} className="space-y-2">
              {/* Leg header */}
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-md"
                style={{
                  backgroundColor: leg.line.hexColor + '15',
                  borderLeft: `3px solid ${leg.line.hexColor}`,
                }}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: colors.dot }}
                  aria-hidden="true"
                />
                <span className="text-xs font-semibold text-gray-800">
                  {leg.line.shortName} — {leg.direction}
                </span>
                <span className="ml-auto text-xs text-gray-500">
                  {leg.stopCount} stop{leg.stopCount !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Stop list */}
              <StopList leg={leg} />

              {/* Transfer badge (if not the last leg) */}
              {transfer && <TransferBadge transfer={transfer} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
