/**
 * DelaySimulator — Upgraded Delay Simulator Component.
 * Supports:
 * - Mode selection: Metro / AMTS / BRTS
 * - Delay buttons: +5 min / +10 min / +20 min
 * - Reset button
 * - Explanatory badge
 */

import { AlertTriangle, RotateCcw } from 'lucide-react';

interface DelaySimulatorProps {
  currentDelayMin: number;
  currentMode: 'metro' | 'amts' | 'brts';
  onApplyDelay: (mode: 'metro' | 'amts' | 'brts', minutes: number) => void;
  onReset: () => void;
  disabled?: boolean;
}

export default function DelaySimulator({
  currentDelayMin,
  currentMode,
  onApplyDelay,
  onReset,
  disabled = false,
}: DelaySimulatorProps) {
  const modes: { id: 'metro' | 'amts' | 'brts'; label: string }[] = [
    { id: 'metro', label: 'Metro' },
    { id: 'amts', label: 'AMTS' },
    { id: 'brts', label: 'BRTS' },
  ];

  return (
    <div className="bg-[#F4E8D8] border border-[#E3D2B8] rounded-lg p-3 sm:p-4 text-xs sm:text-sm shadow-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2.5">
        <div className="flex items-center gap-1.5 font-bold text-[#0B2545]">
          <AlertTriangle size={16} className="text-[#FF9933] shrink-0" />
          <span>Delay Simulator (Judge Demo)</span>
        </div>
        {currentDelayMin > 0 && (
          <span className="text-[11px] font-semibold bg-red-100 text-red-800 px-2 py-0.5 rounded border border-red-200">
            Active: +{currentDelayMin} min on {currentMode.toUpperCase()}
          </span>
        )}
      </div>

      <p className="text-xs text-gray-700 mb-3 leading-snug">
        Test multi-modal re-routing when a connection is delayed. Watch the itinerary flag missed connections and animate the recommendation banner.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        {/* Mode selector */}
        <div className="flex items-center gap-1 bg-white border border-[#E3D2B8] rounded p-0.5">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              onClick={() => onApplyDelay(m.id, currentDelayMin || 10)}
              className={`px-2 py-1 rounded text-xs font-semibold transition-colors ${
                currentMode === m.id
                  ? 'bg-[#0B2545] text-white'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Minutes buttons */}
        <div className="flex items-center gap-1.5">
          {[5, 10, 20].map((mins) => (
            <button
              key={mins}
              type="button"
              disabled={disabled}
              onClick={() => onApplyDelay(currentMode, mins)}
              className={`px-2.5 py-1 rounded text-xs font-bold border transition-colors ${
                currentDelayMin === mins
                  ? 'bg-amber-600 text-white border-amber-700 shadow-sm'
                  : 'bg-white hover:bg-amber-100 text-amber-900 border-amber-300'
              }`}
            >
              +{mins} min
            </button>
          ))}
        </div>

        {/* Reset button */}
        {currentDelayMin > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 bg-white border border-gray-300 hover:bg-gray-50 px-2.5 py-1 rounded font-medium transition-colors"
          >
            <RotateCcw size={12} />
            <span>Reset</span>
          </button>
        )}
      </div>
    </div>
  );
}
