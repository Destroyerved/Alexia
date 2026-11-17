import { useEffect, useState } from 'react';

/**
 * HeroTrainBackground — Full-page fixed background with two stylised high-speed trains.
 *
 * Requirements (Change B):
 * 1. Fixed layer behind all content:
 *    position: fixed; inset: 0; z-index: 0; pointer-events: none; aria-hidden="true".
 *    All page content sits above it with position: relative; z-index: 1.
 * 2. Size:
 *    Main train: 28% to 35% viewport width (clamp: min 240px, max 520px).
 *    Second train: smaller (~20% viewport width) for atmospheric depth.
 * 3. Position:
 *    Main track: horizontal at ~72% viewport height (72vh), train moving left to right.
 *    Second track: horizontal at ~35% viewport height (35vh), train moving right to left.
 * 4. Visibility & Colors:
 *    Navy (#0B2545) and orange (#FF9933) only.
 *    Main train opacity: 12% (range 10% to 14%).
 *    Second train opacity: 7% (range 6% to 8%).
 * 5. Motion:
 *    Main train duration: 35s (range 30s to 40s), loops seamlessly.
 *    Second train duration: 55s, loops seamlessly.
 *    CSS transform keyframes only. Pauses when tab is hidden.
 *    prefers-reduced-motion: static trains with no animation.
 * 6. Bundled inline SVG, works 100% offline with zero extra libraries.
 */
export default function HeroTrainBackground() {
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsPaused(document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 pointer-events-none select-none z-0 overflow-hidden"
    >
      <style>{`
        @keyframes trainLeftToRight {
          0% {
            transform: translate3d(-100%, 0, 0);
          }
          100% {
            transform: translate3d(100vw, 0, 0);
          }
        }
        @keyframes trainRightToLeft {
          0% {
            transform: translate3d(100vw, 0, 0) scaleX(-1);
          }
          100% {
            transform: translate3d(-100%, 0, 0) scaleX(-1);
          }
        }
        .main-train-motion {
          will-change: transform;
          animation: trainLeftToRight 35s linear infinite;
        }
        .second-train-motion {
          will-change: transform;
          animation: trainRightToLeft 55s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .main-train-motion {
            animation: none !important;
            transform: translate3d(8vw, 0, 0) !important;
          }
          .second-train-motion {
            animation: none !important;
            transform: translate3d(68vw, 0, 0) scaleX(-1) !important;
          }
        }
      `}</style>

      {/* ── 1. SECOND TRAIN & TRACK (Upper corridor at 35% viewport height) ── */}
      <div
        className="absolute left-0 right-0 top-[35vh] h-[55px] -translate-y-full"
        style={{ opacity: 0.07 }}
      >
        {/* Upper Track line */}
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#0B2545]" />
        <div className="absolute bottom-[-2px] left-0 right-0 h-[1px] bg-[#FF9933]" />

        {/* Second Train (moving right to left, scaleX(-1)) */}
        <div
          className="absolute bottom-0 left-0 w-[clamp(160px,22vw,320px)] second-train-motion"
          style={{ animationPlayState: isPaused ? 'paused' : 'running' }}
        >
          <svg
            viewBox="0 0 420 70"
            className="w-full h-auto block"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Aerodynamic train body */}
            <path
              d="M 10 56 C 45 56 80 50 115 36 C 150 22 185 14 230 14 L 420 14 L 420 56 Z"
              fill="#ffffff"
              stroke="#0B2545"
              strokeWidth="2.5"
            />
            {/* Windshield */}
            <path
              d="M 38 46 C 62 44 84 36 108 26 L 100 22 C 74 30 52 38 30 40 Z"
              fill="#0B2545"
            />
            {/* Passenger windows */}
            <rect x="140" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="180" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="220" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="260" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="300" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="340" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="380" y="24" width="28" height="12" rx="2" fill="#0B2545" />

            {/* Saffron accent speed stripe */}
            <path
              d="M 22 50 C 55 50 90 46 120 40 L 420 40 L 420 44 L 118 44 C 88 48 54 52 22 52 Z"
              fill="#FF9933"
            />

            {/* Pantograph */}
            <path
              d="M 290 14 L 305 4 L 320 14 L 312 4 L 330 4"
              stroke="#0B2545"
              strokeWidth="2"
            />

            {/* Wheels / bogies */}
            <circle cx="85" cy="58" r="4.5" fill="#0B2545" />
            <circle cx="115" cy="58" r="4.5" fill="#0B2545" />
            <circle cx="330" cy="58" r="4.5" fill="#0B2545" />
            <circle cx="360" cy="58" r="4.5" fill="#0B2545" />
          </svg>
        </div>
      </div>

      {/* ── 2. MAIN TRAIN & TRACK (Lower corridor at 72% viewport height) ── */}
      <div
        className="absolute left-0 right-0 top-[72vh] h-[75px] -translate-y-full"
        style={{ opacity: 0.12 }}
      >
        {/* Main Track line */}
        <div className="absolute bottom-0 left-0 right-0 h-[2.5px] bg-[#0B2545]" />
        <div className="absolute bottom-[-3px] left-0 right-0 h-[1.5px] bg-[#FF9933]" />

        {/* Main Train (moving left to right, 28% to 35% viewport width) */}
        <div
          className="absolute bottom-0 left-0 w-[clamp(240px,32vw,520px)] main-train-motion"
          style={{ animationPlayState: isPaused ? 'paused' : 'running' }}
        >
          <svg
            viewBox="0 0 420 70"
            className="w-full h-auto block"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Aerodynamic train body */}
            <path
              d="M 10 56 C 45 56 80 50 115 36 C 150 22 185 14 230 14 L 420 14 L 420 56 Z"
              fill="#ffffff"
              stroke="#0B2545"
              strokeWidth="3"
            />
            {/* Windshield */}
            <path
              d="M 38 46 C 62 44 84 36 108 26 L 100 22 C 74 30 52 38 30 40 Z"
              fill="#0B2545"
            />
            {/* Passenger windows */}
            <rect x="140" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="180" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="220" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="260" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="300" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="340" y="24" width="28" height="12" rx="2" fill="#0B2545" />
            <rect x="380" y="24" width="28" height="12" rx="2" fill="#0B2545" />

            {/* Saffron accent speed stripe */}
            <path
              d="M 22 50 C 55 50 90 46 120 40 L 420 40 L 420 44 L 118 44 C 88 48 54 52 22 52 Z"
              fill="#FF9933"
            />

            {/* Pantograph */}
            <path
              d="M 290 14 L 305 4 L 320 14 L 312 4 L 330 4"
              stroke="#0B2545"
              strokeWidth="2.5"
            />

            {/* Wheels / bogies */}
            <circle cx="85" cy="58" r="5" fill="#0B2545" />
            <circle cx="115" cy="58" r="5" fill="#0B2545" />
            <circle cx="330" cy="58" r="5" fill="#0B2545" />
            <circle cx="360" cy="58" r="5" fill="#0B2545" />
          </svg>
        </div>
      </div>
    </div>
  );
}
