// Color derivation utilities for dynamic theming

interface HSL { h: number; s: number; l: number; }
interface RGB { r: number; g: number; b: number; }

interface ThemeCoreColors {
  bg: string;
  bgSoft?: string;
  bgCard?: string;
  bgBorder?: string;
  accent: string;
}

export interface ThemeColors {
  bg: string;
  bgSoft: string;
  bgCard: string;
  bgElevated: string;
  bgOverlay: string;
  bgBorder: string;
  content: string;
  contentSoft: string;
  contentMuted: string;
  contentFaint: string;
  contentInverted: string;
  primary: string;
  primaryForeground: string;
  primarySoft: string;
  primaryBorder: string;
  secondary: string;
  ring: string;
  success: string;
  successForeground: string;
  successSoft: string;
  successBorder: string;
  warning: string;
  warningForeground: string;
  warningSoft: string;
  warningBorder: string;
  danger: string;
  dangerForeground: string;
  dangerSoft: string;
  dangerBorder: string;
  info: string;
  accent: string;
  accentGlow: string;
  warmGlow: string;
  coolGlow: string;
  ambientGlow: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  colors: ThemeColors;
}

export interface ThemePresetGroup {
  label: string;
  themes: ThemePreset[];
}

export interface ElementColorConfig {
  id: string;
  selector: string;
  color: string;
  name: string;
}

export interface FavoriteScheme {
  id: string;
  name: string;
  baseColor: string;
  colors: ThemeColors;
  elementColors?: ElementColorConfig[];
  createdAt: number;
}

export function hexToRgb(hex: string): RGB {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clampChannel = (c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0");
  return "#" + clampChannel(r) + clampChannel(g) + clampChannel(b);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function rgbToHsl(r: number, g: number, b: number): HSL {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
      case gn: h = ((bn - rn) / d + 2) / 6; break;
      case bn: h = ((rn - gn) / d + 4) / 6; break;
    }
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const hn = h / 360, sn = s / 100, ln = l / 100;
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  return {
    r: Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hn) * 255),
    b: Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  };
}

function shiftColor(hex: string, lightnessDelta: number, saturationDelta = 0, hueDelta = 0) {
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const next = hslToRgb(
    (hsl.h + hueDelta + 360) % 360,
    clamp(hsl.s + saturationDelta, 0, 100),
    clamp(hsl.l + lightnessDelta, 0, 100)
  );
  return rgbToHex(next.r, next.g, next.b);
}

function mixColors(color1: string, color2: string, weight = 0.5) {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);
  const mix = (a: number, b: number) => a * weight + b * (1 - weight);
  return rgbToHex(mix(rgb1.r, rgb2.r), mix(rgb1.g, rgb2.g), mix(rgb1.b, rgb2.b));
}

function withAlpha(hex: string, alpha: number) {
  const clean = hex.replace("#", "");
  const value = clamp(Math.round(alpha * 255), 0, 255).toString(16).padStart(2, "0");
  return `#${clean}${value}`;
}

function getReadableForeground(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#09090b" : "#fcfcfd";
}

export function createThemeColors(core: ThemeCoreColors): ThemeColors {
  const bg = core.bg;
  const bgSoft = core.bgSoft ?? shiftColor(bg, -4, -6);
  const bgCard = core.bgCard ?? shiftColor(bg, 5, -4);
  const bgBorder = core.bgBorder ?? shiftColor(bgCard, 10, -8);
  const accent = core.accent;
  const secondary = shiftColor(accent, 4, -20, 18);
  const success = "#22c55e";
  const warning = "#f59e0b";
  const danger = shiftColor(accent, -2, 8, -18);
  const primaryForeground = getReadableForeground(accent);
  const content = mixColors("#f8fafc", accent, 0.94);

  return {
    bg,
    bgSoft,
    bgCard,
    bgElevated: shiftColor(bgCard, 4, -2),
    bgOverlay: mixColors(bgCard, "#ffffff", 0.9),
    bgBorder,
    content,
    contentSoft: mixColors(content, bg, 0.8),
    contentMuted: mixColors(content, bg, 0.64),
    contentFaint: mixColors(content, bg, 0.48),
    contentInverted: "#09090b",
    primary: accent,
    primaryForeground,
    primarySoft: withAlpha(accent, 0.14),
    primaryBorder: withAlpha(accent, 0.34),
    secondary,
    ring: withAlpha(accent, 0.42),
    success,
    successForeground: getReadableForeground(success),
    successSoft: withAlpha(success, 0.16),
    successBorder: withAlpha(success, 0.3),
    warning,
    warningForeground: getReadableForeground(warning),
    warningSoft: withAlpha(warning, 0.16),
    warningBorder: withAlpha(warning, 0.3),
    danger,
    dangerForeground: getReadableForeground(danger),
    dangerSoft: withAlpha(danger, 0.16),
    dangerBorder: withAlpha(danger, 0.3),
    info: shiftColor(accent, 8, -12, 40),
    accent,
    accentGlow: withAlpha(accent, 0.52),
    warmGlow: withAlpha(shiftColor(bg, 8, 14, 8), 0.22),
    coolGlow: withAlpha(shiftColor(bg, 10, 8, -28), 0.18),
    ambientGlow: withAlpha(mixColors(accent, bg, 0.72), 0.16),
  };
}

export function deriveColors(baseHex: string): ThemeColors {
  return createThemeColors({
    bg: baseHex,
    accent: shiftColor(baseHex, 26, 26, 152),
  });
}

export function normalizeTheme(colors: Partial<ThemeColors> | null | undefined): ThemeColors {
  if (!colors?.bg) {
    return createThemeColors({ bg: "#17120a", bgSoft: "#110d07", bgCard: "#241c10", bgBorder: "#42301a", accent: "#f59e0b" });
  }

  const accent = colors.accent ?? colors.primary ?? shiftColor(colors.bg, 26, 26, 152);
  const base = createThemeColors({
    bg: colors.bg,
    bgSoft: colors.bgSoft,
    bgCard: colors.bgCard,
    bgBorder: colors.bgBorder,
    accent,
  });

  return {
    ...base,
    ...colors,
    primary: colors.primary ?? accent,
    accent,
    accentGlow: colors.accentGlow ?? withAlpha(accent, 0.52),
    warmGlow: colors.warmGlow ?? base.warmGlow,
    coolGlow: colors.coolGlow ?? base.coolGlow,
    ambientGlow: colors.ambientGlow ?? base.ambientGlow,
  };
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: "market-amber", name: "Market Amber", colors: createThemeColors({ bg: "#17120a", bgSoft: "#110d07", bgCard: "#241c10", bgBorder: "#42301a", accent: "#f59e0b" }) },
  { id: "wine-dark", name: "Wine Dark", colors: createThemeColors({ bg: "#180a0e", bgSoft: "#100609", bgCard: "#221014", bgBorder: "#381820", accent: "#f43f5e" }) },
  { id: "burgundy-noir", name: "Burgundy Noir", colors: createThemeColors({ bg: "#1a0c10", bgSoft: "#12080b", bgCard: "#26121a", bgBorder: "#3e1c28", accent: "#fda4af" }) },
  { id: "crimson-noir", name: "Crimson Noir", colors: createThemeColors({ bg: "#160d0f", bgSoft: "#100809", bgCard: "#22141a", bgBorder: "#3d202a", accent: "#fca5a5" }) },
  { id: "rose-nebula", name: "Rose Nebula", colors: createThemeColors({ bg: "#160f1a", bgSoft: "#100b13", bgCard: "#241521", bgBorder: "#42283a", accent: "#fb7185" }) },
  { id: "neon-ember", name: "Neon Ember", colors: createThemeColors({ bg: "#181008", bgSoft: "#110b05", bgCard: "#27190f", bgBorder: "#47301b", accent: "#f97316" }) },
  { id: "royal-plum", name: "Royal Plum", colors: createThemeColors({ bg: "#160f20", bgSoft: "#100b18", bgCard: "#221830", bgBorder: "#3d2b55", accent: "#d8b4fe" }) },
  { id: "lavender-haze", name: "Lavender Haze", colors: createThemeColors({ bg: "#14102a", bgSoft: "#0e0b1e", bgCard: "#1e1938", bgBorder: "#302850", accent: "#c4b5fd" }) },
  { id: "cobalt-night", name: "Cobalt Night", colors: createThemeColors({ bg: "#08111f", bgSoft: "#050b15", bgCard: "#111b2d", bgBorder: "#1a2e4a", accent: "#60a5fa" }) },
  { id: "deep-space", name: "Deep Space", colors: createThemeColors({ bg: "#0a0c18", bgSoft: "#060810", bgCard: "#121525", bgBorder: "#1e2140", accent: "#a5b4fc" }) },
  { id: "slate-ocean", name: "Slate Ocean", colors: createThemeColors({ bg: "#0f1520", bgSoft: "#0a0f18", bgCard: "#182030", bgBorder: "#243044", accent: "#93c5fd" }) },
  { id: "ocean-depth", name: "Ocean Depth", colors: createThemeColors({ bg: "#091520", bgSoft: "#060f18", bgCard: "#101d2c", bgBorder: "#1a2d40", accent: "#38bdf8" }) },
  { id: "aurora-mist", name: "Aurora Mist", colors: createThemeColors({ bg: "#071714", bgSoft: "#04110f", bgCard: "#0f231f", bgBorder: "#1d4038", accent: "#2dd4bf" }) },
  { id: "emerald-abyss", name: "Emerald Abyss", colors: createThemeColors({ bg: "#0c1a17", bgSoft: "#081210", bgCard: "#142822", bgBorder: "#214d3d", accent: "#6ee7b7" }) },
  { id: "forest-pine", name: "Forest Pine", colors: createThemeColors({ bg: "#0b1710", bgSoft: "#07100b", bgCard: "#12221a", bgBorder: "#1e3d2a", accent: "#86efac" }) },
  { id: "deep-jungle", name: "Deep Jungle", colors: createThemeColors({ bg: "#091510", bgSoft: "#060f0a", bgCard: "#101e16", bgBorder: "#1a3020", accent: "#4ade80" }) },
  { id: "teal-smoke", name: "Teal Smoke", colors: createThemeColors({ bg: "#0a1818", bgSoft: "#071010", bgCard: "#122222", bgBorder: "#1c3434", accent: "#5eead4" }) },
  { id: "amber-dusk", name: "Amber Dusk", colors: createThemeColors({ bg: "#17120a", bgSoft: "#110d07", bgCard: "#241c10", bgBorder: "#42301a", accent: "#fcd34d" }) },
  { id: "solar-flare", name: "Solar Flare", colors: createThemeColors({ bg: "#180f07", bgSoft: "#110a04", bgCard: "#251710", bgBorder: "#3d2410", accent: "#fdba74" }) },
  { id: "golden-hour", name: "Golden Hour", colors: createThemeColors({ bg: "#191107", bgSoft: "#120c05", bgCard: "#281b0f", bgBorder: "#47331b", accent: "#f59e0b" }) },
  { id: "graphite", name: "Graphite", colors: createThemeColors({ bg: "#111318", bgSoft: "#0c0e12", bgCard: "#1a1d24", bgBorder: "#272b35", accent: "#93c5fd" }) },
  { id: "zinc-dark", name: "Zinc Dark", colors: createThemeColors({ bg: "#121214", bgSoft: "#0d0d0f", bgCard: "#1c1c20", bgBorder: "#2c2c32", accent: "#a1a1aa" }) },
];

export const THEME_PRESET_GROUPS: ThemePresetGroup[] = [
  {
    label: "Винные / Тёплые",
    themes: THEME_PRESETS.filter((theme) => ["market-amber", "wine-dark", "burgundy-noir", "crimson-noir", "rose-nebula", "neon-ember", "amber-dusk", "solar-flare", "golden-hour"].includes(theme.id)),
  },
  {
    label: "Фиолетовые / Синие",
    themes: THEME_PRESETS.filter((theme) => ["royal-plum", "lavender-haze", "cobalt-night", "deep-space", "slate-ocean", "ocean-depth"].includes(theme.id)),
  },
  {
    label: "Зелёные",
    themes: THEME_PRESETS.filter((theme) => ["aurora-mist", "emerald-abyss", "forest-pine", "deep-jungle", "teal-smoke"].includes(theme.id)),
  },
  {
    label: "Нейтральные",
    themes: THEME_PRESETS.filter((theme) => ["graphite", "zinc-dark"].includes(theme.id)),
  },
];

const LS_KEY = "solana-launcher.theme";
const PRESET_KEY = "solana-launcher.theme-preset";
const ELEMENT_LS_KEY = "solana-launcher.element-colors";
const FAVORITES_LS_KEY = "solana-launcher.favorite-schemes";

export function loadTheme(): ThemeColors | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? normalizeTheme(JSON.parse(raw)) : null;
  } catch { return null; }
}

export function saveTheme(colors: ThemeColors) {
  localStorage.setItem(LS_KEY, JSON.stringify(normalizeTheme(colors)));
}

export function loadThemePresetId(): string | null {
  try {
    return localStorage.getItem(PRESET_KEY);
  } catch { return null; }
}

export function saveThemePresetId(presetId: string) {
  localStorage.setItem(PRESET_KEY, presetId);
}

export function getThemePresetById(presetId: string | null | undefined) {
  return THEME_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

export function loadElementColors(): ElementColorConfig[] {
  try {
    const raw = localStorage.getItem(ELEMENT_LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveElementColors(configs: ElementColorConfig[]) {
  localStorage.setItem(ELEMENT_LS_KEY, JSON.stringify(configs));
}

export function loadFavorites(): FavoriteScheme[] {
  try {
    const raw = localStorage.getItem(FAVORITES_LS_KEY);
    const favorites = raw ? JSON.parse(raw) as FavoriteScheme[] : [];
    return favorites.map((favorite) => ({
      ...favorite,
      colors: normalizeTheme(favorite.colors),
    }));
  } catch { return []; }
}

export function saveFavorites(favorites: FavoriteScheme[]) {
  localStorage.setItem(FAVORITES_LS_KEY, JSON.stringify(favorites.map((favorite) => ({
    ...favorite,
    colors: normalizeTheme(favorite.colors),
  }))));
}

export function addFavorite(name: string, baseColor: string, colors: ThemeColors, elementColors?: ElementColorConfig[]): FavoriteScheme {
  const newScheme: FavoriteScheme = {
    id: Math.random().toString(36).slice(2),
    name,
    baseColor,
    colors: normalizeTheme(colors),
    elementColors,
    createdAt: Date.now(),
  };
  const favorites = loadFavorites();
  favorites.push(newScheme);
  saveFavorites(favorites);
  return newScheme;
}

export function removeFavorite(id: string) {
  const favorites = loadFavorites().filter(f => f.id !== id);
  saveFavorites(favorites);
}

export function applyTheme(colors: ThemeColors) {
  const theme = normalizeTheme(colors);
  const root = document.documentElement;
  root.dataset.theme = "dark";
  root.style.setProperty("--theme-bg", theme.bg);
  root.style.setProperty("--theme-bg-soft", theme.bgSoft);
  root.style.setProperty("--theme-bg-card", theme.bgCard);
  root.style.setProperty("--theme-bg-elevated", theme.bgElevated);
  root.style.setProperty("--theme-bg-overlay", theme.bgOverlay);
  root.style.setProperty("--theme-bg-border", theme.bgBorder);
  root.style.setProperty("--theme-content", theme.content);
  root.style.setProperty("--theme-content-soft", theme.contentSoft);
  root.style.setProperty("--theme-content-muted", theme.contentMuted);
  root.style.setProperty("--theme-content-faint", theme.contentFaint);
  root.style.setProperty("--theme-content-inverted", theme.contentInverted);
  root.style.setProperty("--theme-primary", theme.primary);
  root.style.setProperty("--theme-primary-foreground", theme.primaryForeground);
  root.style.setProperty("--theme-primary-soft", theme.primarySoft);
  root.style.setProperty("--theme-primary-border", theme.primaryBorder);
  root.style.setProperty("--theme-primary-glow", theme.accentGlow);
  root.style.setProperty("--theme-secondary", theme.secondary);
  root.style.setProperty("--theme-ring", theme.ring);
  root.style.setProperty("--theme-success", theme.success);
  root.style.setProperty("--theme-success-foreground", theme.successForeground);
  root.style.setProperty("--theme-success-soft", theme.successSoft);
  root.style.setProperty("--theme-success-border", theme.successBorder);
  root.style.setProperty("--theme-warning", theme.warning);
  root.style.setProperty("--theme-warning-foreground", theme.warningForeground);
  root.style.setProperty("--theme-warning-soft", theme.warningSoft);
  root.style.setProperty("--theme-warning-border", theme.warningBorder);
  root.style.setProperty("--theme-danger", theme.danger);
  root.style.setProperty("--theme-danger-foreground", theme.dangerForeground);
  root.style.setProperty("--theme-danger-soft", theme.dangerSoft);
  root.style.setProperty("--theme-danger-border", theme.dangerBorder);
  root.style.setProperty("--theme-info", theme.info);
  root.style.setProperty("--theme-accent", theme.accent);
  root.style.setProperty("--theme-accent-glow", theme.accentGlow);
  root.style.setProperty("--theme-warm-glow", theme.warmGlow);
  root.style.setProperty("--theme-cool-glow", theme.coolGlow);
  root.style.setProperty("--theme-ambient-glow", theme.ambientGlow);
  root.style.setProperty("--page-accent", theme.primary);
  root.style.setProperty("--page-accent-2", theme.secondary);
  root.style.setProperty("--page-glow", theme.primarySoft);
  root.style.setProperty("--page-glow-2", `color-mix(in srgb, ${theme.secondary} 16%, transparent)`);
}

export const PRESET_COLORS = [
  "#00ff88", // neon mint
  "#39ff14", // acid green
  "#00e5ff", // electric cyan
  "#2563ff", // laser blue
  "#7c3aed", // ultraviolet
  "#d946ef", // neon orchid
  "#ff2bd6", // hot magenta
  "#ff1744", // plasma red
  "#ff6d00", // lava orange
  "#ffd400", // cyber yellow
  "#14f195", // solana green
  "#9945ff", // solana purple
];
