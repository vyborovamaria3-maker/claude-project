"use client";

import { useLayoutEffect } from "react";

const THEME_VARS = [
  "--theme-bg",
  "--theme-primary",
  "--theme-secondary",
] as const;

type RGB = { r: number; g: number; b: number };

function clamp(value: number, min = 0, max = 255) {
  return Math.min(max, Math.max(min, value));
}

function parseColor(value: string): RGB | null {
  const raw = value.trim();
  if (!raw) return null;

  const hex = raw.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  const shortHex = raw.match(/^#([0-9a-f]{3})$/i);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split("").map((c) => Number.parseInt(c + c, 16));
    return { r, g, b };
  }

  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) {
    return { r: clamp(Number(rgb[1])), g: clamp(Number(rgb[2])), b: clamp(Number(rgb[3])) };
  }

  return null;
}

function toHex({ r, g, b }: RGB) {
  return `#${[r, g, b].map((v) => Math.round(clamp(v)).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: RGB, b: RGB, amount: number): RGB {
  const t = Math.min(1, Math.max(0, amount));
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function luminance({ r, g, b }: RGB) {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function alpha(rgb: RGB, a: number) {
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${a})`;
}

function setVar(root: HTMLElement, name: string, value: string) {
  if (root.style.getPropertyValue(name).trim() !== value) root.style.setProperty(name, value);
}

function applyAdaptiveTheme() {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const bg = parseColor(computed.getPropertyValue("--theme-bg"));
  if (!bg) return;

  const primary = parseColor(computed.getPropertyValue("--theme-primary")) ?? { r: 245, g: 158, b: 11 };
  const secondary = parseColor(computed.getPropertyValue("--theme-secondary")) ?? primary;
  const light = luminance(bg) >= 0.38;

  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 7, g: 10, b: 9 };

  // Surface direction flips automatically: light themes get subtly darker cards,
  // dark themes get subtly brighter cards. This keeps hierarchy visible for any hue.
  const bgSoft = mix(bg, light ? black : black, light ? 0.035 : 0.18);
  const bgCard = mix(bg, light ? black : white, light ? 0.055 : 0.065);
  const bgElevated = mix(bg, light ? black : white, light ? 0.09 : 0.105);
  const bgOverlay = mix(bg, light ? black : white, light ? 0.13 : 0.14);
  const bgBorder = mix(bg, light ? black : white, light ? 0.19 : 0.18);

  const content = light ? mix(black, bg, 0.06) : mix(white, bg, 0.035);
  const contentSoft = mix(content, bg, light ? 0.22 : 0.2);
  const contentMuted = mix(content, bg, light ? 0.43 : 0.42);
  const contentFaint = mix(content, bg, light ? 0.61 : 0.6);

  setVar(root, "--theme-bg-soft", toHex(bgSoft));
  setVar(root, "--theme-bg-card", toHex(bgCard));
  setVar(root, "--theme-bg-elevated", toHex(bgElevated));
  setVar(root, "--theme-bg-overlay", toHex(bgOverlay));
  setVar(root, "--theme-bg-border", toHex(bgBorder));
  setVar(root, "--theme-content", toHex(content));
  setVar(root, "--theme-content-soft", toHex(contentSoft));
  setVar(root, "--theme-content-muted", toHex(contentMuted));
  setVar(root, "--theme-content-faint", toHex(contentFaint));
  setVar(root, "--theme-content-inverted", light ? "#fcfcfd" : "#09090b");
  setVar(root, "--theme-primary-foreground", luminance(primary) > 0.48 ? "#09090b" : "#fcfcfd");

  // Theme-wide translucent effects use the selected palette instead of fixed black/white.
  setVar(root, "--theme-shadow-color", light ? alpha(black, 0.18) : alpha(black, 0.72));
  setVar(root, "--theme-highlight-color", light ? alpha(white, 0.58) : alpha(white, 0.08));
  setVar(root, "--theme-warm-glow", alpha(primary, light ? 0.12 : 0.16));
  setVar(root, "--theme-cool-glow", alpha(secondary, light ? 0.1 : 0.13));
  setVar(root, "--theme-ambient-glow", alpha(mix(primary, secondary, 0.5), light ? 0.075 : 0.1));

  root.dataset.theme = light ? "light" : "dark";
  root.style.colorScheme = light ? "light" : "dark";
  document.body?.setAttribute("data-theme-tone", light ? "light" : "dark");
}

export default function ThemeRuntime() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let signature = "";

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const computed = getComputedStyle(root);
        const next = THEME_VARS.map((name) => computed.getPropertyValue(name).trim()).join("|");
        if (next === signature) return;
        signature = next;
        applyAdaptiveTheme();
      });
    };

    schedule();

    // applyTheme() writes CSS variables to <html style="...">. Observe those writes so
    // preset changes and the manual picker update every page immediately, without reload.
    const observer = new MutationObserver(schedule);
    observer.observe(root, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });

    const onStorage = () => schedule();
    const onThemeChange = () => schedule();
    window.addEventListener("storage", onStorage);
    window.addEventListener("potapoff:theme-change", onThemeChange as EventListener);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("potapoff:theme-change", onThemeChange as EventListener);
    };
  }, []);

  return null;
}
