import { Bus, Car, Info } from 'lucide-react';
import type { LastMileOption } from '../data/stationData';
import { STATION_BY_ID } from '../data/stationData';
import { getStationLastMile, type AmtsBrtsStopInfo } from '../data/lastMileData';
import RapidoHandoffPanel from './RapidoHandoffPanel';

interface LastMilePanelProps {
  options: LastMileOption[];
  /** Physical station ID of the metro boarding station */
  boardingStationId: string | null;
  /** Physical station ID of the metro destination / alighting station */
  destinationStationId: string | null;
}

const modeIcon = (mode: string) => {
  switch (mode) {
    case 'brts':
    case 'amts':
      return <Bus size={20} aria-hidden="true" />;
    case 'auto':
      return <Car size={20} aria-hidden="true" />;
    default:
      return <Bus size={20} aria-hidden="true" />;
  }
};

const modeAccent: Record<string, { bg: string; border: string; icon: string }> = {
  amts: { bg: 'bg-orange-50',  border: 'border-orange-200', icon: 'text-orange-600' },
  brts: { bg: 'bg-green-50',   border: 'border-green-200',  icon: 'text-green-700'  },
  auto: { bg: 'bg-yellow-50',  border: 'border-yellow-300', icon: 'text-yellow-700' },
};

// ── AMTS / BRTS info card body ─────────────────────────────────────────────

function BusStopInfo({
  stopInfo,
  destinationName,
}: {
  stopInfo: AmtsBrtsStopInfo | null;
  destinationName: string | null;
}) {
  return (
    <div className="flex flex-col gap-1.5 mt-auto">
      {destinationName && (
        <p className="text-xs text-gray-500">
          Near:{' '}
          <span className="font-semibold text-gray-700">{destinationName}</span>
        </p>
      )}

      {stopInfo ? (
        <div className="text-xs bg-amber-50 border border-amber-100 rounded p-2">
          <p className="text-amber-800 leading-snug">{stopInfo.statusNote}</p>
          <p className="text-[10px] mt-1 text-amber-600 italic">
            {stopInfo.isSimulated
              ? 'Simulated — details not officially verified.'
              : 'Verified data.'}
          </p>
        </div>
      ) : (
        <p className="text-xs text-gray-400 italic">
          Stop distance not available yet.
        </p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function LastMilePanel({
  options,
  boardingStationId,
  destinationStationId,
}: LastMilePanelProps) {
  const hasJourney = Boolean(boardingStationId && destinationStationId);

  const destinationName: string | null = destinationStationId
    ? (STATION_BY_ID[destinationStationId]?.name ?? null)
    : null;

  const lastMile = destinationStationId
    ? getStationLastMile(destinationStationId)
    : null;

  return (
    <section aria-labelledby="lastmile-heading">
      <h3
        id="lastmile-heading"
        className="text-sm font-bold text-[#0B2545] uppercase tracking-wide mb-3"
      >
        Last-Mile Options
      </h3>

      {!hasJourney ? (
        /* Pre-selection placeholder */
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 flex items-center gap-2 text-sm text-gray-500">
          <Info size={16} className="shrink-0 text-gray-400" aria-hidden="true" />
          Select your journey to see last-mile options.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {options.map((opt) => {
            const accent = modeAccent[opt.mode] ?? {
              bg: 'bg-gray-50',
              border: 'border-gray-200',
              icon: 'text-gray-600',
            };

            // Auto-rickshaw: show full Rapido handoff panel
            if (opt.mode === 'auto') {
              return (
                <div
                  key={opt.mode}
                  className={`rounded-lg border ${accent.bg} ${accent.border} p-4 flex flex-col gap-2`}
                  role="article"
                  aria-label={opt.label}
                >
                  <div className={`flex items-center gap-2 font-semibold text-gray-800 ${accent.icon}`}>
                    {modeIcon(opt.mode)}
                    <span className="text-sm">{opt.label}</span>
                  </div>
                  <p className="text-xs text-gray-600 leading-snug">
                    {opt.description}
                  </p>
                  {/* pickupStation = the metro exit / destination station */}
                  <RapidoHandoffPanel pickupStation={destinationName} />
                </div>
              );
            }

            // AMTS / BRTS
            const stopInfo =
              opt.mode === 'amts' ? (lastMile?.amts ?? null) : (lastMile?.brts ?? null);

            return (
              <div
                key={opt.mode}
                className={`rounded-lg border ${accent.bg} ${accent.border} p-4 flex flex-col gap-2`}
                role="article"
                aria-label={opt.label}
              >
                <div className={`flex items-center gap-2 font-semibold text-gray-800 ${accent.icon}`}>
                  {modeIcon(opt.mode)}
                  <span className="text-sm">{opt.label}</span>
                </div>
                <p className="text-xs text-gray-600 leading-snug">
                  {opt.description}
                </p>
                <BusStopInfo stopInfo={stopInfo} destinationName={destinationName} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
