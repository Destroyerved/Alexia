import { useState, useEffect } from 'react';
import { Wifi, WifiOff, Train } from 'lucide-react';

interface HeaderProps {
  isOnline: boolean;
}

export default function Header({ isOnline }: HeaderProps) {
  const [isTabHidden, setIsTabHidden] = useState(false);

  useEffect(() => {
    const handleVisibility = () => setIsTabHidden(document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  return (
    <header className="bg-[#0B2545] text-white shadow-md border-b-4 border-[#FF9933] relative z-10">
      {/* Gov-style top strip */}
      <div className="bg-[#0a1f3d] py-1 px-4 text-xs text-gray-300 flex items-center justify-between">
        <span className="font-medium tracking-wide">
          भारत सरकार | Government of India &nbsp;·&nbsp; गुजरात &nbsp;·&nbsp; Ahmedabad Municipal Corporation
        </span>
        {/* Offline indicator */}
        <span
          className={`flex items-center gap-1 font-semibold text-xs rounded px-2 py-0.5 ${
            isOnline
              ? 'bg-green-700/60 text-green-100'
              : 'bg-amber-700/70 text-amber-100 animate-pulse'
          }`}
          role="status"
          aria-live="polite"
          aria-label={isOnline ? 'Online' : 'Offline – data may be cached'}
        >
          {isOnline ? (
            <>
              <Wifi size={12} aria-hidden="true" /> Online
            </>
          ) : (
            <>
              <WifiOff size={12} aria-hidden="true" /> Offline – cached data
            </>
          )}
        </span>
      </div>

      {/* Main header row */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
        {/* Logo area */}
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[#FF9933]/20 border-2 border-[#FF9933]/50 shrink-0">
          <Train size={26} className="text-[#FF9933]" aria-hidden="true" />
        </div>

        <div>
          <h1 className="text-xl sm:text-2xl font-bold leading-tight tracking-tight text-white">
            TransitSync
          </h1>
          <p className="text-xs sm:text-sm text-blue-200 leading-snug">
            Ahmedabad Integrated Public Transport
          </p>
        </div>

        {/* Spacer + right badge */}
        <div className="ml-auto text-right hidden sm:block">
          <span className="block text-[10px] text-blue-300 uppercase tracking-widest">
            Metro&nbsp;·&nbsp;AMTS&nbsp;·&nbsp;BRTS&nbsp;·&nbsp;Auto
          </span>
          <span className="block text-[10px] text-[#FF9933] font-semibold mt-0.5">
            METRO HACKS · GDG Gandhinagar
          </span>
        </div>
      </div>

      {/* Dedicated ~28px track and train strip along bottom edge of header, above the saffron border */}
      <div
        aria-hidden="true"
        className="h-[28px] relative overflow-hidden bg-[#071930] pointer-events-none select-none border-t border-blue-950/60"
      >
        <style>{`
          @keyframes headerTrainRun {
            0% {
              transform: translate3d(-100%, 0, 0);
            }
            100% {
              transform: translate3d(100vw, 0, 0);
            }
          }
          .header-train-anim {
            will-change: transform;
            animation: headerTrainRun 28s linear infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .header-train-anim {
              animation: none !important;
              transform: translate3d(12vw, 0, 0) !important;
            }
          }
        `}</style>

        {/* Track Line */}
        <div className="absolute bottom-[4px] left-0 right-0 h-[2px] bg-[#FF9933]/40" />

        {/* Moving Orange Metro Train (driving left to right) */}
        <div
          className="absolute bottom-[5px] left-0 header-train-anim"
          style={{ animationPlayState: isTabHidden ? 'paused' : 'running' }}
        >
          <svg
            width="120"
            height="20"
            viewBox="0 0 120 20"
            className="block"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Train body in theme orange #FF9933 */}
            <path
              d="M 4 16 C 14 16 22 14 30 10 C 38 6 46 4 56 4 L 118 4 L 118 16 Z"
              fill="#FF9933"
            />
            {/* Windshield */}
            <path
              d="M 12 13 C 18 12 24 10 30 7 L 28 6 C 21 8 15 10 9 11 Z"
              fill="#0B2545"
            />
            {/* White windows */}
            <rect x="38" y="7" width="8" height="4" rx="1" fill="#ffffff" />
            <rect x="50" y="7" width="8" height="4" rx="1" fill="#ffffff" />
            <rect x="62" y="7" width="8" height="4" rx="1" fill="#ffffff" />
            <rect x="74" y="7" width="8" height="4" rx="1" fill="#ffffff" />
            <rect x="86" y="7" width="8" height="4" rx="1" fill="#ffffff" />
            <rect x="98" y="7" width="8" height="4" rx="1" fill="#ffffff" />
            <rect x="110" y="7" width="6" height="4" rx="1" fill="#ffffff" />
            {/* Wheels */}
            <circle cx="28" cy="17" r="1.5" fill="#ffffff" />
            <circle cx="36" cy="17" r="1.5" fill="#ffffff" />
            <circle cx="95" cy="17" r="1.5" fill="#ffffff" />
            <circle cx="103" cy="17" r="1.5" fill="#ffffff" />
          </svg>
        </div>
      </div>
    </header>
  );
}
