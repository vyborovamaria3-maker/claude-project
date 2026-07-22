"use client";

import { CSSProperties, useEffect, useMemo, useRef } from "react";

export interface StrandsProps {
  colors?: string[];
  count?: number;
  speed?: number;
  amplitude?: number;
  waviness?: number;
  thickness?: number;
  glow?: number;
  taper?: number;
  spread?: number;
  hueShift?: number;
  intensity?: number;
  saturation?: number;
  opacity?: number;
  scale?: number;
  glass?: boolean;
  refraction?: number;
  dispersion?: number;
  glassSize?: number;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_COLORS = ["#FF4242", "#7C3AED", "#06B6D4", "#EAB308"];

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "").trim();
  if (normalized.length !== 6) return { r: 255, g: 255, b: 255 };
  const n = Number.parseInt(normalized, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
}

function blendColors(colors: string[], t: number) {
  if (!colors.length) return { r: 255, g: 255, b: 255 };
  const scaled = ((t % 1) + 1) % 1 * colors.length;
  const idx = Math.floor(scaled);
  const next = (idx + 1) % colors.length;
  const mix = scaled - idx;
  const a = hexToRgb(colors[idx]);
  const b = hexToRgb(colors[next]);
  return {
    r: Math.round(a.r + (b.r - a.r) * mix),
    g: Math.round(a.g + (b.g - a.g) * mix),
    b: Math.round(a.b + (b.b - a.b) * mix),
  };
}

export default function Strands({
  colors = DEFAULT_COLORS,
  count = 3,
  speed = 0.5,
  amplitude = 1,
  waviness = 1,
  thickness = 0.7,
  glow = 2.6,
  taper = 3,
  spread = 1,
  hueShift = 0,
  intensity = 0.6,
  saturation = 1.5,
  opacity = 1,
  scale = 1.5,
  glass = false,
  glassSize = 1,
  className = "",
  style,
}: StrandsProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const safeColors = useMemo(() => (colors.length ? colors : DEFAULT_COLORS), [colors]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    const start = performance.now();

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement ?? canvas);
    resize();

    const render = () => {
      const elapsed = (performance.now() - start) / 1000;
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const baseScale = Math.max(0.2, scale);
      const strandCount = Math.max(1, Math.min(12, Math.round(count)));
      const lineWidthBase = Math.max(0.8, thickness * 7);

      const wash = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(width, height) * 0.75);
      wash.addColorStop(0, "rgba(255,255,255,0.16)");
      wash.addColorStop(0.28, "rgba(167,139,250,0.12)");
      wash.addColorStop(0.58, "rgba(34,211,238,0.08)");
      wash.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.translate(cx, cy);
      ctx.scale(baseScale, baseScale);
      ctx.globalAlpha = Math.max(0, Math.min(1, opacity));

      for (let i = 0; i < strandCount; i += 1) {
        const phase = i * 1.6 * spread;
        const freq = (1.7 + i * 0.28) * waviness;
        const drift = (elapsed * speed * (1.2 + i * 0.22)) + phase + hueShift * Math.PI * 2;
        const color = blendColors(safeColors, i / Math.max(1, strandCount - 1) + hueShift);

        for (let layer = 0; layer < 4; layer += 1) {
          const layerAlpha = Math.min(1, (0.42 / (layer + 1)) * (0.55 + intensity));
          const w = lineWidthBase + layer * 5 * glow;
          ctx.beginPath();

          const points = 64;
          for (let p = 0; p <= points; p += 1) {
            const t = p / points;
            const x = (t - 0.5) * width * 1.08;
            const edgeFade = Math.max(0.08, Math.pow(1 - Math.abs(t * 2 - 1), taper));
            const y =
              Math.sin(t * freq * Math.PI * 2 + drift) * 44 * amplitude * edgeFade +
              Math.sin(t * freq * 2.2 - drift * 0.65 + phase * 1.3) * 20 * amplitude * edgeFade;

            if (p === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }

          ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${layerAlpha})`;
          ctx.lineWidth = w;
          ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.min(1, 0.95 * layerAlpha)})`;
          ctx.shadowBlur = 16 + layer * 12 * glow;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.stroke();

          ctx.strokeStyle = `rgba(255,255,255,${0.12 / (layer + 1)})`;
          ctx.lineWidth = Math.max(0.75, w * 0.18);
          ctx.shadowBlur = 0;
          ctx.stroke();
        }
      }

      ctx.restore();

      if (glass) {
        const radius = Math.min(width, height) * 0.42 * glassSize;
        const gradient = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
        gradient.addColorStop(0, "rgba(255,255,255,0.08)");
        gradient.addColorStop(0.72, "rgba(255,255,255,0.02)");
        gradient.addColorStop(1, "rgba(255,255,255,0)");

        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.lineWidth = 1.25;
        ctx.stroke();
        ctx.restore();
      }

      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [amplitude, colors, count, glass, glassSize, glow, hueShift, intensity, opacity, safeColors, scale, speed, spread, taper, thickness, waviness]);

  return (
    <div className={["relative overflow-hidden", className].filter(Boolean).join(" ")} style={style}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
