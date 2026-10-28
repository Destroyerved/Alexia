import { useState, useEffect } from 'react';

/**
 * Hook to detect whether the viewport is mobile-sized (< breakpoint).
 * Listens to matchMedia change events for responsive updates on resize or device rotation.
 * Defaults to 768px (Tailwind 'md' breakpoint).
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);

    const updateMatches = () => {
      setIsMobile(mql.matches);
    };

    updateMatches();

    mql.addEventListener('change', updateMatches);
    return () => {
      mql.removeEventListener('change', updateMatches);
    };
  }, [breakpoint]);

  return isMobile;
}
