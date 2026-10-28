/**
 * RapidoHandoffPanel — auto-rickshaw last-mile handoff component.
 *
 * In the last-mile flow the user has just exited the metro. The pickup point
 * for the auto-rickshaw is therefore the metro DESTINATION station. The user
 * then enters their onward (final) destination address manually.
 *
 * Since Rapido has no public deep-link URL format for prefilling locations,
 * this component implements the documented reliable fallback:
 *  - Opens https://www.rapido.bike/ in a new tab.
 *  - Displays the metro exit station as the Rapido pickup.
 *  - Lets the user type their onward destination address.
 *  - "Copy Ride Details" copies both fields for easy paste into the Rapido app.
 *  - Falls back to displaying text for manual copy if clipboard is denied.
 */
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Car,
  Check,
  Copy,
  ExternalLink,
} from 'lucide-react';
import {
  buildJourneyDetailText,
  buildRapidoUrl,
  copyToClipboard,
  RAPIDO_BASE_URL,
} from '../data/rapidoHandoff';

interface RapidoHandoffPanelProps {
  /**
   * The metro exit / alighting station — this becomes the Rapido pickup point.
   * Pass null before the user has selected a destination.
   */
  pickupStation: string | null;
}

type CopyState = 'idle' | 'copied' | 'failed';

export default function RapidoHandoffPanel({
  pickupStation,
}: RapidoHandoffPanelProps) {
  const [onwardDestination,  setOnwardDestination]  = useState('');
  const [pickupCopyState,    setPickupCopyState]    = useState<CopyState>('idle');
  const [detailCopyState,    setDetailCopyState]    = useState<CopyState>('idle');
  const [showManualCopy,     setShowManualCopy]     = useState(false);
  const [onwardTouched,      setOnwardTouched]      = useState(false);

  // When the metro exit station changes, clear any previously entered address
  useEffect(() => {
    setOnwardDestination('');
    setOnwardTouched(false);
    setPickupCopyState('idle');
    setDetailCopyState('idle');
    setShowManualCopy(false);
  }, [pickupStation]);

  const hasPickup    = Boolean(pickupStation);
  const hasOnward    = Boolean(onwardDestination.trim());
  const showOnwardError = onwardTouched && !hasOnward;

  // Build detail text only when both pickup and onward destination are available
  const detailText = hasPickup && hasOnward
    ? buildJourneyDetailText({
        pickupStation: pickupStation ?? '',
        onwardDestination: onwardDestination.trim(),
      })
    : null;

  const rapUrl = buildRapidoUrl({
    pickupStation: pickupStation ?? '',
  });

  const handleCopy = async (text: string, setState: (s: CopyState) => void) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
    } else {
      setState('failed');
      setShowManualCopy(true);
    }
  };

  // ── Sub-component: copy button ────────────────────────────────────────────
  const CopyButton = ({
    label,
    text,
    state,
    onCopy,
    disabled,
  }: {
    label: string;
    text: string;
    state: CopyState;
    onCopy: () => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      onClick={onCopy}
      disabled={disabled || !text}
      aria-label={label}
      className={[
        'flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md border transition-colors',
        state === 'copied'
          ? 'bg-green-50 border-green-400 text-green-700'
          : state === 'failed'
          ? 'bg-red-50 border-red-300 text-red-600'
          : 'bg-white border-gray-300 hover:bg-gray-50 text-gray-700',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-gray-400',
      ].join(' ')}
    >
      {state === 'copied' ? (
        <Check size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      {state === 'copied' ? 'Copied!' : state === 'failed' ? 'Denied' : label}
    </button>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 flex flex-col gap-3"
      role="region"
      aria-label="Auto-Rickshaw last-mile via Rapido"
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <Car size={18} className="text-yellow-700 shrink-0" aria-hidden="true" />
        <span className="text-sm font-bold text-yellow-800">
          Auto-Rickshaw — Continue via Rapido
        </span>
      </div>

      {/* No pickup warning */}
      {!hasPickup && (
        <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>Plan a journey first to see pickup details.</span>
        </div>
      )}

      {/* Journey details */}
      {hasPickup && (
        <dl className="grid grid-cols-1 gap-2 text-xs text-gray-700">
          {/* Pickup = metro exit station */}
          <div className="flex items-start justify-between gap-2">
            <div>
              <dt className="text-gray-500 font-medium">
                Pickup <span className="font-normal">(metro exit):</span>
              </dt>
              <dd className="font-semibold text-gray-900">{pickupStation}</dd>
            </div>
            <CopyButton
              label="Copy Pickup"
              text={pickupStation ?? ''}
              state={pickupCopyState}
              onCopy={() => handleCopy(pickupStation ?? '', setPickupCopyState)}
            />
          </div>

          {/* Onward destination — user-entered */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="rapido-onward-dest"
              className="text-gray-500 font-medium"
            >
              Onward destination{' '}
              <span className="font-normal">(your final stop):</span>
            </label>
            <input
              id="rapido-onward-dest"
              type="text"
              value={onwardDestination}
              onChange={(e) => setOnwardDestination(e.target.value)}
              onBlur={() => setOnwardTouched(true)}
              placeholder="e.g. Science City, Ahmedabad"
              aria-required="true"
              aria-invalid={showOnwardError}
              aria-describedby={showOnwardError ? 'rapido-onward-err' : undefined}
              className={[
                'w-full border rounded px-2.5 py-1.5 text-xs bg-white text-gray-800',
                'focus:outline-none focus:ring-2 focus:ring-[#0B2545] focus:border-[#0B2545]',
                showOnwardError
                  ? 'border-red-400'
                  : 'border-gray-300',
              ].join(' ')}
            />
            {showOnwardError && (
              <p id="rapido-onward-err" className="text-red-600 text-[10px]">
                Enter your onward destination to generate ride details.
              </p>
            )}
          </div>
        </dl>
      )}

      {/* Action row */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Open Rapido */}
        <a
          href={rapUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open Rapido website in a new tab"
          className="flex items-center gap-1.5 bg-[#FF9933] hover:bg-[#e8882a] text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-[#FF9933]"
        >
          <ExternalLink size={12} aria-hidden="true" />
          Open Rapido
        </a>

        {/* Copy ride details — enabled only when both fields are set */}
        {hasPickup && (
          <CopyButton
            label="Copy Ride Details"
            text={detailText ?? ''}
            state={detailCopyState}
            disabled={!hasOnward}
            onCopy={() => {
              if (!hasOnward) {
                setOnwardTouched(true);
                return;
              }
              if (detailText) handleCopy(detailText, setDetailCopyState);
            }}
          />
        )}
      </div>

      {/* Manual copy fallback */}
      {showManualCopy && detailText && (
        <div className="mt-1">
          <p className="text-xs text-gray-500 mb-1">
            Clipboard access was denied. Copy the details below manually:
          </p>
          <textarea
            readOnly
            rows={6}
            value={detailText}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Ride details for manual copy"
            className="w-full text-xs font-mono border border-gray-300 rounded px-2 py-1.5 bg-white resize-none focus:outline-none focus:ring-1 focus:ring-gray-400"
          />
        </div>
      )}

      {/* Disclaimer */}
      <p className="text-[10px] text-yellow-700 leading-snug">
        Rapido availability, ride matching, fare, and booking are handled entirely
        by Rapido. TransitSync has no partnership with or API access to Rapido.
        No ride is booked by clicking &ldquo;Open Rapido&rdquo;. External link
        opens{' '}
        <span className="font-semibold">{RAPIDO_BASE_URL}</span> in a new tab.
      </p>
    </div>
  );
}
