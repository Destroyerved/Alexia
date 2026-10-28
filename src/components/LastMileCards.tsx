import { useState, useRef, useEffect } from 'react';
import {
  Bus,
  Car,
  ExternalLink,
  MapPin,
  Check,
  Maximize2,
  X,
  ZoomIn,
  ZoomOut,
  Map as MapIcon,
} from 'lucide-react';
import type { LastMileResult } from '../engine';

interface LastMileCardsProps {
  lastMile: LastMileResult;
  isOnline: boolean;
  destinationName?: string;
}

export default function LastMileCards({
  lastMile,
  isOnline,
  destinationName,
}: LastMileCardsProps) {
  const { brts, amts, station } = lastMile;
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [isMapModalOpen, setIsMapModalOpen] = useState(false);
  const [zoom, setZoom] = useState(1);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);

  // Check if destination differs from station where user gets off
  const dropLocation = destinationName || lastMile.destinationQuery || station;
  const isDifferent = Boolean(
    dropLocation && dropLocation.trim().toLowerCase() !== station.trim().toLowerCase(),
  );

  // Modal focus trap & Escape key handler
  useEffect(() => {
    if (isMapModalOpen) {
      closeButtonRef.current?.focus();
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setIsMapModalOpen(false);
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    } else {
      triggerButtonRef.current?.focus();
    }
  }, [isMapModalOpen]);

  const handleBookRapido = () => {
    if (!isOnline) return;

    if (isDifferent) {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(dropLocation).catch(() => {});
      }
      setToastMessage('Destination copied. Paste it as your drop in Rapido.');
    } else {
      setToastMessage('Open Rapido and choose your drop.');
    }

    setShowToast(true);
    setTimeout(() => {
      setShowToast(false);
    }, 4000);

    if (typeof window !== 'undefined' && window.open) {
      window.open('https://www.rapido.bike/', '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <section aria-labelledby="lastmile-heading" className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-1">
        <h3 id="lastmile-heading" className="text-sm font-bold text-[#0B2545] uppercase tracking-wide">
          Last-Mile Feeder & Transit Options (from {station})
        </h3>
        <span className="text-[11px] text-gray-600 italic">
          Feeder routes & straight-line walk estimates
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 1. Janmarg BRTS Card */}
        <div className="rounded-lg border bg-green-50/70 border-green-300 p-4 flex flex-col justify-between text-xs sm:text-sm shadow-sm">
          <div>
            <div className="flex items-center gap-2 font-bold text-green-950 mb-1">
              <Bus size={18} className="text-green-700" />
              <span>Janmarg BRTS</span>
            </div>
            <p className="text-xs text-gray-600 mb-3">
              Dedicated bus corridors connecting major city arterials.
            </p>

            {brts.hasData ? (
              <div className="space-y-1.5 bg-[#F4E8D8]/80 border border-[#E3D2B8] rounded p-2.5 mb-3 text-xs">
                <div>
                  <span className="text-gray-600">Nearest stop: </span>
                  <span className="font-semibold text-gray-900">{brts.stop.name}</span>
                </div>
                <div>
                  <span className="text-gray-600">Distance: </span>
                  {/* Distance Rule: < 500m bold, >= 500m normal */}
                  <span className={brts.stop.isBold ? 'font-bold text-gray-900' : 'font-normal text-gray-700'}>
                    {brts.stop.distM} m (~{brts.stop.walkMin} min walk)
                  </span>
                </div>
              </div>
            ) : (
              <div className="bg-[#F4E8D8]/60 border border-[#E3D2B8] rounded p-2.5 text-xs text-gray-600 italic mb-3">
                no BRTS data nearby
              </div>
            )}
          </div>

          {/* Walk to nearest BRTS button */}
          {brts.hasData && brts.stop.walkUrl && (
            <a
              href={isOnline ? brts.stop.walkUrl : undefined}
              target="_blank"
              rel="noopener noreferrer"
              className={`w-full min-h-[44px] px-3 rounded text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                isOnline
                  ? 'bg-green-700 hover:bg-green-800 text-white shadow-sm'
                  : 'bg-gray-200 text-gray-500 cursor-not-allowed border border-gray-300'
              }`}
              title={isOnline ? 'Open Google Maps walking directions' : 'Map needs internet'}
              aria-disabled={!isOnline}
            >
              <MapPin size={14} />
              <span>{isOnline ? 'Walk to BRTS stop' : 'Map needs internet'}</span>
              {isOnline && <ExternalLink size={12} />}
            </a>
          )}
        </div>

        {/* 2. AMTS City Bus Card */}
        <div className="rounded-lg border bg-orange-50/70 border-orange-300 p-4 flex flex-col justify-between text-xs sm:text-sm shadow-sm">
          <div>
            <div className="flex items-center gap-2 font-bold text-orange-950 mb-1">
              <Bus size={18} className="text-orange-700" />
              <span>AMTS City Bus & Feeder</span>
            </div>
            <p className="text-xs text-gray-600 mb-3">
              Municipal bus network and dedicated metro station feeder routes.
            </p>

            {amts.hasData ? (
              <div className="space-y-1.5 bg-[#F4E8D8]/80 border border-[#E3D2B8] rounded p-2.5 mb-3 text-xs">
                <div>
                  <span className="text-gray-600">Nearest stop: </span>
                  <span className="font-semibold text-gray-900">{amts.stop.name}</span>
                </div>
                <div>
                  <span className="text-gray-600">Distance: </span>
                  {/* Distance Rule: < 500m bold, >= 500m normal */}
                  <span className={amts.stop.isBold ? 'font-bold text-gray-900' : 'font-normal text-gray-700'}>
                    {amts.stop.distM} m (~{amts.stop.walkMin} min walk)
                  </span>
                </div>

                {/* Next feeder route departure from static GTFS */}
                {amts.nextFeeder && (
                  <div className="mt-2 pt-2 border-t border-orange-200/80 text-xs text-orange-950">
                    <span className="font-semibold">Next Feeder ({amts.nextFeeder.routeName}): </span>
                    <strong className="font-mono text-gray-900">{amts.nextFeeder.depTime}</strong>{' '}
                    ({amts.nextFeeder.waitMin} min wait)
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-[#F4E8D8]/60 border border-[#E3D2B8] rounded p-2.5 text-xs text-gray-600 italic mb-3">
                no AMTS data nearby
              </div>
            )}
          </div>

          {/* Walk to nearest AMTS button */}
          {amts.hasData && amts.stop.walkUrl && (
            <a
              href={isOnline ? amts.stop.walkUrl : undefined}
              target="_blank"
              rel="noopener noreferrer"
              className={`w-full min-h-[44px] px-3 rounded text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                isOnline
                  ? 'bg-orange-700 hover:bg-orange-800 text-white shadow-sm'
                  : 'bg-gray-200 text-gray-500 cursor-not-allowed border border-gray-300'
              }`}
              title={isOnline ? 'Open Google Maps walking directions' : 'Map needs internet'}
              aria-disabled={!isOnline}
            >
              <MapPin size={14} />
              <span>{isOnline ? 'Walk to AMTS stop' : 'Map needs internet'}</span>
              {isOnline && <ExternalLink size={12} />}
            </a>
          )}
        </div>

        {/* 3. Auto-Rickshaw (Rapido) Card — CHANGE 3: Exact Title, Dynamic Subtitle & Conditional Copy */}
        <div className="rounded-lg border bg-yellow-50/80 border-yellow-300 p-4 flex flex-col justify-between text-xs sm:text-sm shadow-sm">
          <div>
            <div className="flex items-center gap-2 font-bold text-yellow-950 mb-1">
              <Car size={18} className="text-yellow-700" />
              <span>Book Rapido for your drop</span>
            </div>
            <p className="text-xs text-gray-700 mb-4 leading-relaxed">
              {isDifferent ? (
                <>
                  Pickup: <span className="font-semibold text-gray-900">{station}</span> | Drop:{' '}
                  <span className="font-semibold text-gray-900">{dropLocation}</span>
                </>
              ) : (
                <>
                  Pickup: <span className="font-semibold text-gray-900">{station}</span>. Choose your drop in the Rapido app.
                </>
              )}
            </p>

            {/* Toast feedback when destination is copied or prompt shown */}
            {showToast && (
              <div
                role="status"
                aria-live="polite"
                className="mb-3 p-2.5 bg-yellow-100 border border-yellow-400 text-yellow-950 rounded text-xs font-semibold flex items-center gap-1.5 shadow-sm"
              >
                <Check size={14} className="text-yellow-800 shrink-0" />
                <span>{toastMessage}</span>
              </div>
            )}
          </div>

          <div>
            {/* Book Rapido Button — min 44px touch target & visible focus style */}
            <button
              type="button"
              onClick={handleBookRapido}
              disabled={!isOnline}
              className={`min-h-[44px] w-full px-4 py-2.5 rounded-md font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-colors focus:outline-none focus:ring-2 focus:ring-[#0B2545] focus:ring-offset-2 ${
                isOnline
                  ? 'bg-[#FF9933] hover:bg-[#e8882a] text-white shadow-sm cursor-pointer'
                  : 'bg-gray-200 text-gray-500 cursor-not-allowed border border-gray-300'
              }`}
              aria-label={isOnline ? 'Book Rapido' : 'Needs internet to open Rapido'}
            >
              <span>{isOnline ? 'Book Rapido' : 'Needs internet to open Rapido'}</span>
              {isOnline && <ExternalLink size={14} />}
            </button>

            {/* Muted line below button */}
            <p className="text-[11px] text-gray-500 mt-2 text-center leading-tight">
              Opens Rapido. Fare and booking happen in the Rapido app.
            </p>
          </div>
        </div>
      </div>

      {/* 4. Metro Route Map Section (CHANGE 2) */}
      <div className="bg-[#F4E8D8] border border-[#E3D2B8] rounded-lg p-4 sm:p-5 shadow-sm space-y-3 mt-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h4 className="font-bold text-[#0B2545] text-sm uppercase tracking-wide flex items-center gap-2">
              <MapIcon size={16} className="text-[#FF9933]" />
              <span>Metro route map</span>
            </h4>
            <p className="text-xs text-gray-600 mt-0.5">
              Ahmedabad & Gandhinagar Metro Network (Phase-1 & Phase-2)
            </p>
          </div>
          <button
            ref={triggerButtonRef}
            type="button"
            onClick={() => {
              setZoom(1);
              setIsMapModalOpen(true);
            }}
            className="min-h-[44px] px-3.5 py-2 bg-[#0B2545] hover:bg-[#163a6b] text-white rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0B2545] focus:ring-offset-2"
            aria-label="Tap to enlarge metro route map"
          >
            <Maximize2 size={14} />
            <span>Tap to enlarge</span>
          </button>
        </div>

        {/* Thumbnail Preview: max-height: 420px, object-fit: contain, top-aligned */}
        <div
          onClick={() => {
            setZoom(1);
            setIsMapModalOpen(true);
          }}
          className="w-full max-h-[420px] bg-white rounded border border-[#E3D2B8] overflow-hidden flex justify-center cursor-pointer group relative shadow-inner"
          title="Click to view full-screen map"
        >
          <img
            src="/images/metro-route-map.webp"
            alt="Ahmedabad and Gandhinagar metro route map"
            className="w-full max-h-[420px] object-contain object-top group-hover:scale-[1.01] transition-transform duration-200"
          />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center pointer-events-none">
            <span className="opacity-0 group-hover:opacity-100 transition-opacity bg-[#0B2545]/90 text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow flex items-center gap-1.5">
              <Maximize2 size={13} />
              <span>Tap to enlarge</span>
            </span>
          </div>
        </div>
      </div>

      {/* Full-screen viewer Modal with zoom & pan, Escape to close, focus trap */}
      {isMapModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Metro route map full-screen viewer"
          className="fixed inset-0 z-50 bg-black/90 flex flex-col"
        >
          {/* Modal Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-[#0B2545] text-white border-b border-[#FF9933] shrink-0">
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm sm:text-base">Ahmedabad & Gandhinagar Metro Route Map</span>
              <span className="text-xs text-blue-200 hidden sm:inline">(Phase 1 & Phase 2)</span>
            </div>

            <div className="flex items-center gap-2">
              {/* Zoom In */}
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(z + 0.25, 3))}
                className="p-2 hover:bg-blue-900 rounded text-xs font-bold border border-blue-800 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
                title="Zoom in"
                aria-label="Zoom in map"
              >
                <ZoomIn size={16} />
              </button>
              {/* Zoom Out */}
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(z - 0.25, 0.75))}
                className="p-2 hover:bg-blue-900 rounded text-xs font-bold border border-blue-800 min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
                title="Zoom out"
                aria-label="Zoom out map"
              >
                <ZoomOut size={16} />
              </button>
              {/* Reset Zoom */}
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="px-2.5 py-1.5 hover:bg-blue-900 rounded text-xs font-semibold border border-blue-800 min-h-[44px] flex items-center justify-center cursor-pointer"
                title="Reset zoom"
              >
                100%
              </button>
              {/* Close Button */}
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setIsMapModalOpen(false)}
                className="min-h-[44px] px-3.5 py-1.5 bg-[#FF9933] hover:bg-[#e8882a] text-[#0B2545] font-bold text-xs rounded flex items-center gap-1.5 cursor-pointer shadow focus:outline-none focus:ring-2 focus:ring-white"
                aria-label="Close full-screen map viewer"
              >
                <X size={16} />
                <span>Close</span>
              </button>
            </div>
          </div>

          {/* Modal Map Pan/Zoom Container */}
          <div
            className="flex-1 overflow-auto p-4 flex items-center justify-center touch-pan-x touch-pan-y"
            style={{ overscrollBehavior: 'contain' }}
          >
            <img
              src="/images/metro-route-map.webp"
              alt="Ahmedabad and Gandhinagar metro route map"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
              className="max-w-none transition-transform duration-150 ease-out shadow-2xl rounded"
            />
          </div>
        </div>
      )}
    </section>
  );
}
