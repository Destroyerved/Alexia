import React, { useEffect, useRef } from 'react';
import { useTheme } from '../../context/ThemeContext';

export const PerspectiveGrid: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isTouch = window.matchMedia('(pointer: coarse)').matches;

    let animationFrameId: number;
    let isTabVisible = !document.hidden;

    // Viewport-relative mouse coordinates & easing
    const mouse = {
      x: window.innerWidth * 0.5,
      y: window.innerHeight * 0.35,
      targetX: window.innerWidth * 0.5,
      targetY: window.innerHeight * 0.35,
      prevTargetX: window.innerWidth * 0.5,
      prevTargetY: window.innerHeight * 0.35,
      activity: 0.2, // Movement activity level (decays when still)
    };

    const handleMouseMove = (e: MouseEvent) => {
      mouse.targetX = e.clientX;
      mouse.targetY = e.clientY;
      const dx = mouse.targetX - mouse.prevTargetX;
      const dy = mouse.targetY - mouse.prevTargetY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      mouse.activity = Math.min(1.0, mouse.activity + dist * 0.04);
      mouse.prevTargetX = mouse.targetX;
      mouse.prevTargetY = mouse.targetY;
    };

    const handleVisibilityChange = () => {
      isTabVisible = !document.hidden;
      if (isTabVisible && !animationFrameId && !reducedMotion && !isTouch) {
        animationFrameId = requestAnimationFrame(render);
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = window.innerWidth;
      const height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    // Static rendering for reduced-motion or touch devices
    const drawStaticGrid = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      ctx.clearRect(0, 0, width, height);

      const isLight = resolvedTheme === 'light';
      const lineColor = isLight ? 'rgba(8, 127, 62, ' : 'rgba(0, 233, 79, ';

      const horizonY = height * 0.18;
      const vanishingX = width * 0.5;
      const vanishingY = horizonY;

      // Radial perspective rays
      const numRays = 34;
      const spread = width * 2.4;
      const startX = vanishingX - spread / 2;

      ctx.lineWidth = 1;
      for (let i = 0; i <= numRays; i++) {
        const bottomX = startX + (i / numRays) * spread;
        ctx.strokeStyle = `${lineColor}0.15)`;
        ctx.beginPath();
        ctx.moveTo(vanishingX, vanishingY);
        ctx.lineTo(bottomX, height);
        ctx.stroke();
      }

      // Transverse horizontal perspective lines
      const numHorizontals = 20;
      for (let j = 1; j <= numHorizontals; j++) {
        const t = Math.pow(j / numHorizontals, 2.3);
        const y = horizonY + t * (height - horizonY);
        ctx.strokeStyle = `${lineColor}${(0.08 + (j / numHorizontals) * 0.14).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    };

    if (reducedMotion || isTouch) {
      drawStaticGrid();
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('resize', resize);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }

    // Dynamic 3D interactive animation loop
    const render = () => {
      if (!isTabVisible) {
        animationFrameId = requestAnimationFrame(render);
        return;
      }

      // Smooth eased following
      mouse.x += (mouse.targetX - mouse.x) * 0.08;
      mouse.y += (mouse.targetY - mouse.y) * 0.08;
      // Decay activity smoothly back to zero when pointer stops
      mouse.activity *= 0.94;

      const width = window.innerWidth;
      const height = window.innerHeight;

      ctx.clearRect(0, 0, width, height);

      const isLight = resolvedTheme === 'light';
      const lineColor = isLight ? 'rgba(8, 127, 62, ' : 'rgba(0, 233, 79, ';

      // Dynamic vanishing point that subtly shifts with cursor for 3D parallax depth
      const horizonY = height * 0.18;
      const vanishingX = width * (0.42 + (mouse.x / width) * 0.16);
      const vanishingY = horizonY + (mouse.y / height - 0.5) * 20;

      // 1. Soft cursor-following ambient illumination glow
      const glowRadius = 320;
      const radialGlow = ctx.createRadialGradient(
        mouse.x,
        mouse.y,
        0,
        mouse.x,
        mouse.y,
        glowRadius
      );
      if (isLight) {
        radialGlow.addColorStop(0, 'rgba(8, 127, 62, 0.14)');
        radialGlow.addColorStop(0.5, 'rgba(8, 127, 62, 0.04)');
        radialGlow.addColorStop(1, 'transparent');
      } else {
        radialGlow.addColorStop(0, 'rgba(0, 233, 79, 0.22)');
        radialGlow.addColorStop(0.45, 'rgba(0, 233, 79, 0.06)');
        radialGlow.addColorStop(1, 'transparent');
      }

      ctx.fillStyle = radialGlow;
      ctx.fillRect(0, 0, width, height);

      // 2. Perspective Rays (Vertical longitude lines converging at vanishing point)
      const numRays = 36;
      const spread = width * 2.4;
      const startX = vanishingX - spread / 2;
      const bendRadius = 240;

      for (let i = 0; i <= numRays; i++) {
        const bottomX = startX + (i / numRays) * spread;

        // Check proximity of ray to mouse for illumination
        const rayMidX = (vanishingX + bottomX) / 2;
        const rayDistToMouse = Math.abs(rayMidX - mouse.x);
        const mouseProx = Math.max(0, 1 - rayDistToMouse / 380);

        const baseAlpha = isLight ? 0.08 : 0.14;
        const rayAlpha = Math.min(0.65, baseAlpha + mouseProx * (isLight ? 0.18 : 0.35));

        ctx.strokeStyle = `${lineColor}${rayAlpha.toFixed(3)})`;
        ctx.lineWidth = mouseProx > 0.4 ? 1.3 : 1;

        // Draw segmented line with 3D bending near mouse
        const segments = 16;
        ctx.beginPath();
        for (let s = 0; s <= segments; s++) {
          const t = s / segments;
          let px = vanishingX + (bottomX - vanishingX) * t;
          let py = vanishingY + (height - vanishingY) * t;

          // Subtle 3D deformation bend near pointer
          if (mouse.activity > 0.05) {
            const dist = Math.hypot(px - mouse.x, py - mouse.y);
            if (dist < bendRadius) {
              const bendFactor = Math.cos((dist / bendRadius) * (Math.PI / 2));
              const displacement = bendFactor * 10 * mouse.activity;
              const angle = Math.atan2(py - mouse.y, px - mouse.x);
              px += Math.cos(angle) * displacement;
              py += Math.sin(angle) * displacement * 0.4;
            }
          }

          if (s === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }

      // 3. Transverse Horizontal Perspective Lines
      const numHorizontals = 22;
      const intersectionPoints: { x: number; y: number; dist: number }[] = [];

      for (let j = 1; j <= numHorizontals; j++) {
        const t = Math.pow(j / numHorizontals, 2.3);
        const yBase = horizonY + t * (height - horizonY);

        const distY = Math.abs(yBase - mouse.y);
        const yProx = Math.max(0, 1 - distY / 320);

        const baseAlpha = isLight ? 0.07 + (j / numHorizontals) * 0.06 : 0.12 + (j / numHorizontals) * 0.10;
        const lineAlpha = Math.min(0.60, baseAlpha + yProx * (isLight ? 0.15 : 0.30));

        ctx.strokeStyle = `${lineColor}${lineAlpha.toFixed(3)})`;
        ctx.lineWidth = yProx > 0.4 ? 1.3 : 1;

        // Draw segmented horizontal line with gentle warp near mouse
        const hSegments = 24;
        ctx.beginPath();
        for (let k = 0; k <= hSegments; k++) {
          const u = k / hSegments;
          let px = u * width;
          let py = yBase;

          if (mouse.activity > 0.05) {
            const dist = Math.hypot(px - mouse.x, py - mouse.y);
            if (dist < bendRadius) {
              const bendFactor = Math.cos((dist / bendRadius) * (Math.PI / 2));
              const displacement = bendFactor * 8 * mouse.activity;
              const angle = Math.atan2(py - mouse.y, px - mouse.x);
              px += Math.cos(angle) * displacement;
              py += Math.sin(angle) * displacement;
            }
          }

          if (k === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }

          // Sample potential intersection nodes near cursor for illumination
          const distToCursor = Math.hypot(px - mouse.x, py - mouse.y);
          if (distToCursor < 240) {
            intersectionPoints.push({ x: px, y: py, dist: distToCursor });
          }
        }
        ctx.stroke();
      }

      // 4. Glowing technical intersection nodes near cursor
      for (let p = 0; p < intersectionPoints.length; p++) {
        const pt = intersectionPoints[p];
        const intensity = 1 - pt.dist / 240;
        const nodeAlpha = (intensity * (isLight ? 0.45 : 0.85)).toFixed(3);
        const nodeSize = 1.2 + intensity * 1.5;

        ctx.fillStyle = `${lineColor}${nodeAlpha})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, nodeSize, 0, Math.PI * 2);
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cancelAnimationFrame(animationFrameId);
    };
  }, [resolvedTheme]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 w-screen h-screen select-none"
      style={{
        zIndex: 0,
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
      }}
    />
  );
};
