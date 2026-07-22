"use client";

import { useLayoutEffect, useState } from "react";
import ThemeColorPicker from "./ThemeColorPicker";
import { applyTheme, loadElementColors, loadTheme, saveTheme, saveThemePresetId, THEME_PRESETS } from "@/lib/themeColors";

export const PICKER_ENABLED_KEY = "solana-launcher.picker-enabled";

// Zoom removed - site is now static 100%

export default function ThemePickerToggle() {
  const [enabled, setEnabled] = useState(false);

  useLayoutEffect(() => {
    const savedTheme = loadTheme();
    if (savedTheme) {
      applyTheme(savedTheme);
    } else if (THEME_PRESETS[0]) {
      applyTheme(THEME_PRESETS[0].colors);
      saveTheme(THEME_PRESETS[0].colors);
      saveThemePresetId(THEME_PRESETS[0].id);
    }

    const savedElements = loadElementColors();
    savedElements.forEach((cfg) => {
      const el = document.querySelector(cfg.selector) as HTMLElement | null;
      if (el) {
        el.style.backgroundColor = cfg.color;
        el.style.transition = "background-color 0.2s ease";
      }
    });

    setEnabled(localStorage.getItem(PICKER_ENABLED_KEY) === "1");

    // Zoom removed - site is now static 100%
    document.documentElement.style.zoom = "1";
  }, []);

  // Zoom removed - site is now static 100%
  return (
    <>
      {enabled ? <ThemeColorPicker /> : null}
    </>
  );
}
