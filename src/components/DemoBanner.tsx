import { AlertTriangle } from 'lucide-react';

export default function DemoBanner() {
  return (
    <div
      role="note"
      aria-label="Demo mode disclaimer"
      className="flex items-start gap-3 bg-amber-50 border border-amber-400 text-amber-900 text-sm rounded-md px-4 py-3 mx-0"
    >
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
      <p className="leading-snug">
        <strong>Demo mode:</strong> schedules and delays are simulated.{' '}
        <strong>Not live transport information.</strong> Do not use for actual journey planning.
      </p>
    </div>
  );
}
