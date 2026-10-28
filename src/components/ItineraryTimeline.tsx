/**
 * ItineraryTimeline — Displays multi-modal journey itinerary.
 * - Metro legs with direction, "get off at X, N stops after Y", interchanges, depart/arrive times, fare
 * - Transfer walking & buffer legs
 * - Source chips on every leg: "Scheduled (GMRC timetable w.e.f. 18 May 2026)", "Approximate", "Estimated", "Simulated delay"
 * - Dynamic warning banner for missed connections
 */

import { Train, Clock, ArrowRight, AlertTriangle, ArrowLeftRight, IndianRupee } from 'lucide-react';
import type { JourneyPlan } from '../engine';

interface ItineraryTimelineProps {
  plan: JourneyPlan;
}

export default function ItineraryTimeline({ plan }: ItineraryTimelineProps) {
  const { legs, totalDurationMin, totalFareINR, departureTime, arrivalTime } = plan;

  const sourceChipBadge = (chip: string) => {
    if (chip === 'Simulated delay') {
      return 'bg-red-100 text-red-800 border-red-200';
    }
    if (chip === 'Approximate') {
      return 'bg-amber-100 text-amber-800 border-amber-200';
    }
    if (chip === 'Estimated') {
      return 'bg-purple-100 text-purple-800 border-purple-200';
    }
    return 'bg-blue-100 text-blue-900 border-blue-200';
  };

  return (
    <div className="bg-[#F4E8D8] border border-[#E3D2B8] rounded-lg shadow-sm p-4 sm:p-6 space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-[#E3D2B8] pb-3 flex-wrap gap-2">
        <div>
          <span className="text-xs uppercase tracking-wider text-gray-600 font-bold block">
            Suggested Journey Plan
          </span>
          <div className="flex items-center gap-2 text-base sm:text-lg font-bold text-[#0B2545]">
            <span>{plan.origin}</span>
            <ArrowRight size={16} className="text-[#FF9933]" />
            <span>{plan.destination}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs sm:text-sm">
          <div className="flex items-center gap-1 font-semibold text-gray-800 bg-[#EFE0CD] border border-[#E3D2B8] rounded px-2.5 py-1">
            <Clock size={14} className="text-gray-600" />
            <span>{departureTime} → {arrivalTime} ({totalDurationMin} min)</span>
          </div>
          <div className="flex items-center gap-0.5 font-bold text-gray-900 bg-green-50 border border-green-200 text-green-800 rounded px-2 py-1">
            <IndianRupee size={13} />
            <span>{totalFareINR}</span>
          </div>
        </div>
      </div>

      {/* Missed Connection Warning & Recommendation Banner */}
      {plan.hasLikelyMissedConnection && (
        <div className="p-3 bg-red-50 border-l-4 border-red-600 rounded text-xs text-red-900 space-y-1 animate-pulse">
          <div className="flex items-center gap-1.5 font-bold text-red-800">
            <AlertTriangle size={15} className="text-red-600 shrink-0" />
            Connection Likely Missed!
          </div>
          <p>
            Due to delay or tight transfer buffer, the scheduled connecting service may be missed.
          </p>
          {plan.recommendationBanner && (
            <div className="mt-2 p-2 bg-white/80 border border-red-200 rounded text-red-900 font-medium">
              💡 {plan.recommendationBanner}
            </div>
          )}
        </div>
      )}

      {/* Timeline Legs */}
      <div className="relative pl-6 sm:pl-8 space-y-6 before:absolute before:left-3 sm:before:left-4 before:top-2 before:bottom-2 before:w-0.5 before:bg-gray-200">
        {legs.map((leg, index) => {
          const isMetro = leg.mode === 'metro';
          const isTransfer = leg.mode === 'transfer';
          const isAlert = leg.statusAlert === 'missed' || leg.statusAlert === 'delayed';

          return (
            <div key={leg.id || index} className="relative group">
              {/* Timeline marker icon */}
              <div
                className={`absolute -left-6 sm:-left-8 top-0 flex items-center justify-center w-6 sm:w-8 h-6 sm:h-8 rounded-full border-2 text-white shadow-sm ${
                  isAlert
                    ? 'bg-red-600 border-red-200'
                    : isMetro
                    ? 'bg-[#0B2545] border-white'
                    : 'bg-[#FF9933] border-white'
                }`}
              >
                {isMetro ? (
                  <Train size={14} />
                ) : (
                  <ArrowLeftRight size={13} />
                )}
              </div>

              {/* Leg Card */}
              <div
                className={`border rounded-lg p-3 sm:p-4 text-xs sm:text-sm transition-all ${
                  leg.statusAlert === 'missed'
                    ? 'bg-red-50/60 border-red-300'
                    : leg.statusAlert === 'delayed'
                    ? 'bg-amber-50/60 border-amber-300'
                    : 'bg-[#F4E8D8] border-[#E3D2B8] hover:border-amber-400'
                }`}
              >
                {/* Leg Header */}
                <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-[#0B2545]">
                      {leg.lineName || (isTransfer ? 'Station Transfer' : 'Metro Leg')}
                    </span>
                    {leg.direction && (
                      <span className="text-[11px] text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 font-medium">
                        Towards {leg.direction}
                      </span>
                    )}
                  </div>

                  {/* Leg Source Chip */}
                  <span
                    className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${sourceChipBadge(
                      leg.sourceChip,
                    )}`}
                  >
                    {leg.sourceChip}
                  </span>
                </div>

                {/* Departure & Arrival Times */}
                <div className="flex items-center gap-3 text-xs text-gray-600 mb-2">
                  <span className="font-mono font-bold text-gray-900 bg-gray-100 rounded px-1.5 py-0.5">
                    {leg.depTime}
                  </span>
                  <span>→</span>
                  <span className="font-mono font-bold text-gray-900 bg-gray-100 rounded px-1.5 py-0.5">
                    {leg.arrTime}
                  </span>
                  <span className="text-gray-500 font-medium">({leg.durationMin} min ride)</span>
                  {leg.waitMin > 0 && (
                    <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded text-[11px]">
                      {leg.waitMin} min wait
                    </span>
                  )}
                </div>

                {/* Stations details */}
                <div className="text-xs text-gray-700 space-y-1">
                  <div>
                    <span className="text-gray-500">Board at: </span>
                    <strong className="text-gray-900">{leg.from}</strong>
                  </div>
                  <div>
                    <span className="text-gray-500">Alight at: </span>
                    <strong className="text-gray-900">{leg.to}</strong>
                  </div>
                </div>

                {/* Get off hint per spec ("get off at X, N stops after Y") */}
                {leg.getOffHint && (
                  <p className="mt-2 text-xs font-semibold text-blue-900 bg-blue-50/80 border border-blue-200 rounded p-1.5">
                    💡 {leg.getOffHint}
                  </p>
                )}

                {/* Alert message if delayed or missed */}
                {leg.alertMessage && (
                  <p className="mt-2 text-xs text-red-700 bg-red-100/70 rounded p-1.5 font-medium">
                    ⚠️ {leg.alertMessage}
                  </p>
                )}

                {/* Intermediate stops toggle preview */}
                {leg.stopsList && leg.stopsList.length > 2 && (
                  <details className="mt-2 text-[11px] text-gray-500 cursor-pointer">
                    <summary className="hover:text-gray-700 font-medium">
                      View all {leg.stopsList.length} stops ({leg.stopsCount} stops count)
                    </summary>
                    <ol className="list-decimal list-inside pl-2 pt-1 text-gray-600 space-y-0.5">
                      {leg.stopsList.map((st, i) => (
                        <li key={i} className={i === 0 || i === leg.stopsList!.length - 1 ? 'font-bold text-gray-900' : ''}>
                          {st}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
