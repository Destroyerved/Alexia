import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';

export const SoftCursor: React.FC = () => {
  const { resolvedTheme } = useTheme();
  const [isEnabled, setIsEnabled] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const dotRef = useRef<HTMLDivElement>(null);
  const mouse = useRef({ x: -100, y: -100 });
  const pos = useRef({ x: -100, y: -100 });
  const rafId = useRef<number | null>(null);

  useEffect(() => {
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!finePointer || reducedMotion) {
      setIsEnabled(false);
      return;
    }

    setIsEnabled(true);

    const handleMouseMove = (e: MouseEvent) => {
      mouse.current.x = e.clientX;
      mouse.current.y = e.clientY;
      if (!isVisible) setIsVisible(true);
    };

    const handleMouseLeave = () => setIsVisible(false);
    const handleMouseEnter = () => setIsVisible(true);

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('mouseenter', handleMouseEnter);

    const render = () => {
      // Smooth subtle follow
      pos.current.x += (mouse.current.x - pos.current.x) * 0.35;
      pos.current.y += (mouse.current.y - pos.current.y) * 0.35;

      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0)`;
      }

      rafId.current = requestAnimationFrame(render);
    };

    rafId.current = requestAnimationFrame(render);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, [isVisible]);

  if (!isEnabled) return null;

  const isLight = resolvedTheme === 'light';

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[9999] overflow-hidden select-none transition-opacity duration-300"
      style={{ opacity: isVisible ? 1 : 0 }}
    >
      {/* Small, subtle diffused green dot */}
      <div
        ref={dotRef}
        className="absolute top-0 left-0 -ml-2 -mt-2 rounded-full will-change-transform"
        style={{
          width: '16px',
          height: '16px',
          background: isLight
            ? 'radial-gradient(circle, rgba(8, 127, 62, 0.5) 0%, rgba(8, 127, 62, 0.15) 50%, transparent 80%)'
            : 'radial-gradient(circle, rgba(0, 233, 79, 0.6) 0%, rgba(0, 233, 79, 0.15) 50%, transparent 80%)',
        }}
      />
    </div>
  );
};
