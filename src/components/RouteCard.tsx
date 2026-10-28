import { Clock, CreditCard, ArrowRight, AlertCircle } from 'lucide-react';
import type { MetroLine, Station } from '../data/stationData';

interface RouteCardProps {
  line: MetroLine;
  stops: Station[];
  from: string;
  to: string;
  durationMin: number;
  fareINR: number;
  nextDeparture: string;
  delayMin: number;
}

const modeColors: Record<string, string> = {
  metro: 'bg-blue-100 text-blue-800',
  brts:  'bg-green-100 text-green-800',
  amts:  'bg-orange-100 text-orange-700',
  auto:  'bg-yellow-100 text-yellow-800',
};

export default function RouteCard({
  line,
  stops,
  from,
  to,
  durationMin,
  fareINR,
  nextDeparture,
  delayMin,
}: RouteCardProps) {
  const adjustedMinutes = durationMin + delayMin;
  const hasDelay = delayMin > 0;

  return (
    <section
      aria-labelledby="route-heading"
      className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden"
    >
      {/* Line header */}
      <div
        className="px-5 py-3 flex items-center gap-3 border-b border-gray-100"
        style={{ backgroundColor: line.hexColor + '10', borderLeftColor: line.hexColor, borderLeftWidth: 4 }}
      >
        <span
          className="inline-block w-3 h-3 rounded-full shrink-0"
          style={{ backgroundColor: line.hexColor }}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p id="route-heading" className="text-sm font-bold text-gray-800 truncate">
            {line.name}
          </p>
          <p className="text-xs text-gray-500">{line.direction}</p>
        </div>
      </div>

      <div className="px-5 py-4">
        {/* Journey summary */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-sm font-semibold text-[#0B2545]">{from}</span>
          <ArrowRight size={14} className="text-gray-400 shrink-0" aria-hidden="true" />
          <span className="text-sm font-semibold text-[#0B2545]">{to}</span>
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap gap-4 text-xs text-gray-600 mb-4">
          <span className="flex items-center gap-1">
            <Clock size={13} className="text-[#0B2545]" aria-hidden="true" />
            <span>
              Next departure:{' '}
              <strong className={hasDelay ? 'text-red-600' : 'text-gray-800'}>
                {nextDeparture}
                {hasDelay && (
                  <span className="ml-1 text-red-600 font-normal" aria-label={`Delayed by ${delayMin} minutes`}>
                    (+{delayMin} min delay)
                  </span>
                )}
              </strong>
            </span>
          </span>
          <span className="flex items-center gap-1">
            <Clock size={13} className="text-[#0B2545]" aria-hidden="true" />
            Journey: <strong className="text-gray-800 ml-0.5">{adjustedMinutes} min (sim.)</strong>
          </span>
          <span className="flex items-center gap-1">
            <CreditCard size={13} className="text-[#0B2545]" aria-hidden="true" />
            Fare: <strong className="text-gray-800 ml-0.5">₹{fareINR} (sim.)</strong>
          </span>
        </div>

        {/* Delay alert */}
        {hasDelay && (
          <div
            role="alert"
            className="flex items-start gap-2 bg-red-50 border border-red-300 text-red-700 rounded-md px-3 py-2 mb-4 text-xs"
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              <strong>Simulated delay:</strong> {delayMin}-minute delay on {line.name} (demo only).
            </span>
          </div>
        )}

        {/* Stop list */}
        <ol
          aria-label="Journey stops"
          className="relative border-l-2 pl-5 space-y-2"
          style={{ borderColor: line.hexColor }}
        >
          {stops.map((stop, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === stops.length - 1;
            const isBoard = stop.name === from;
            const isAlight = stop.name === to;
            const isHighlighted = isBoard || isAlight;

            return (
              <li key={stop.id} className="relative" aria-label={stop.name}>
                {/* Dot */}
                <span
                  className={`absolute -left-[22px] top-0.5 w-3.5 h-3.5 rounded-full border-2 ${
                    isHighlighted
                      ? 'border-white shadow-md'
                      : 'border-gray-200'
                  }`}
                  style={{
                    backgroundColor: isHighlighted ? line.hexColor : '#e5e7eb',
                  }}
                  aria-hidden="true"
                />

                <div className="flex items-start gap-2 flex-wrap">
                  <span
                    className={`text-xs leading-snug ${
                      isHighlighted ? 'font-bold text-gray-900' : 'text-gray-600'
                    } ${isFirst || isLast ? 'font-semibold' : ''}`}
                  >
                    {stop.name}
                  </span>

                  {/* Stop badges */}
                  {(isBoard || isAlight) && (
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-white"
                      style={{ backgroundColor: line.hexColor }}
                    >
                      {isBoard ? 'Board' : 'Alight'}
                    </span>
                  )}
                  {stop.isTerminus && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                      Terminus
                    </span>
                  )}

                  {/* Interchange badges */}
                  {stop.otherModes?.map((mode) => (
                    <span
                      key={mode}
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${modeColors[mode] ?? 'bg-gray-100 text-gray-700'}`}
                    >
                      {mode.toUpperCase()}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
