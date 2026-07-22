"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, Palette, Sparkles } from "lucide-react";
import {
  applyTheme,
  getThemePresetById,
  loadTheme,
  loadThemePresetId,
  saveTheme,
  saveThemePresetId,
  THEME_PRESET_GROUPS,
  THEME_PRESETS,
} from "@/lib/themeColors";
import ThemeColorPicker from "@/components/ThemeColorPicker";
import { PICKER_ENABLED_KEY } from "@/components/ThemePickerToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// data-tag: settings.colors
export default function ColorsTab() {
  const [activeId, setActiveId] = useState<string>(THEME_PRESETS[0]?.id ?? "wine-dark");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pickerEnabled, setPickerEnabled] = useState(false);

  const activeTheme = useMemo(() => getThemePresetById(activeId) ?? THEME_PRESETS[0], [activeId]);

  useEffect(() => {
    const savedPresetId = loadThemePresetId();
    const savedPreset = getThemePresetById(savedPresetId);
    if (savedPreset) {
      setActiveId(savedPreset.id);
    } else {
      const saved = loadTheme();
      if (saved) {
        const match = THEME_PRESETS.find((theme) => theme.colors.bg.toLowerCase() === saved.bg.toLowerCase());
        if (match) setActiveId(match.id);
      }
    }

    setPickerEnabled(localStorage.getItem(PICKER_ENABLED_KEY) === "1");
  }, []);

  const togglePicker = () => {
    const next = !pickerEnabled;
    setPickerEnabled(next);
    localStorage.setItem(PICKER_ENABLED_KEY, next ? "1" : "0");
    window.dispatchEvent(new StorageEvent("storage", { key: PICKER_ENABLED_KEY, newValue: next ? "1" : "0" }));
  };

  const applyPreset = (preset: (typeof THEME_PRESETS)[number]) => {
    applyTheme(preset.colors);
    saveTheme(preset.colors);
    saveThemePresetId(preset.id);
    setActiveId(preset.id);
  };

  const previewSwatches = useMemo(
    () => [activeTheme.colors.bg, activeTheme.colors.bgCard, activeTheme.colors.primary, activeTheme.colors.secondary],
    [activeTheme]
  );

  return (
    <div data-tag="settings.colors" className="w-full space-y-4">
      <section className="surface-panel overflow-hidden p-5 sm:p-6">
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CardTitle>Colors and theme</CardTitle>
              <Badge variant="default">Preset-driven</Badge>
            </div>
            <CardDescription className="max-w-3xl">
              Choose a premium theme family. The selected preset updates the full site: background gradients,
              surface warmth, accents, borders, and highlight glow.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {previewSwatches.map((color, index) => (
              <span
                key={color + index}
                className="h-10 w-10 rounded-2xl border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_12px_30px_-18px_rgba(0,0,0,0.6)]"
                style={{ background: color }}
              />
            ))}
          </div>
        </div>
      </section>

      <Card className="surface-panel border-0 bg-transparent shadow-none">
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-[0.22em] text-content-faint">Current theme</div>
              <div className="flex items-center gap-2">
                <CardTitle>{activeTheme.name}</CardTitle>
                <Badge variant="secondary">Saved</Badge>
              </div>
              <CardDescription>The chosen preset is restored automatically after reload.</CardDescription>
            </div>
            <div className="flex items-center gap-3 text-xs text-content-muted">
              <Sparkles className="h-4 w-4 text-primary" />
              <span>Theme families with shared visual language</span>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="rounded-2xl border border-bg-border bg-bg-card p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-content-faint">Palette sync</div>
                <div className="mt-1 text-sm text-content-muted">
                  Theme changes now affect base color, gradient warmth, and ambient glow, so the site keeps the
                  Market Overview feel in every section.
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-content-muted">
                <Sparkles className="h-4 w-4 text-primary" />
                <span>Accent + background families</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-4 md:grid-cols-2">
            {THEME_PRESET_GROUPS.map((group) => (
              <div key={group.label} className="space-y-3">
                <p className="px-1 text-xs font-medium uppercase tracking-[0.18em] text-content-faint">{group.label}</p>
                <div className="space-y-2.5">
                  {group.themes.map((preset) => {
                    const isActive = activeId === preset.id;

                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        title={preset.name}
                        className={[
                          "group relative flex w-full flex-col gap-3 overflow-hidden rounded-2xl border p-3 text-left transition-all duration-200",
                          isActive
                            ? "border-primary-border bg-bg-card shadow-[0_12px_36px_-18px_var(--theme-primary-glow),0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_12%,transparent)]"
                            : "border-bg-border bg-bg-card hover:border-primary-border hover:bg-bg-elevated",
                        ].join(" ")}
                      >
                        <div
                          className="absolute inset-0 opacity-0 transition group-hover:opacity-100"
                          style={{ background: `radial-gradient(circle at top right, ${preset.colors.primarySoft}, transparent 50%)` }}
                        />
                        <div
                          className="relative h-24 w-full overflow-hidden rounded-xl border"
                          style={{
                            background: `linear-gradient(145deg, ${preset.colors.bgSoft} 0%, ${preset.colors.bg} 34%, ${preset.colors.bgCard} 70%, ${preset.colors.primarySoft} 100%)`,
                            borderColor: preset.colors.bgBorder,
                          }}
                        >
                          <div
                            className="absolute inset-2 rounded-lg border"
                            style={{
                              background: `linear-gradient(180deg, ${preset.colors.bgElevated}, ${preset.colors.bgCard})`,
                              borderColor: preset.colors.bgBorder,
                            }}
                          />
                          <div className="absolute left-3 top-3 flex gap-1.5">
                            <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
                            <span className="h-2.5 w-2.5 rounded-full bg-white/12" />
                            <span className="h-2.5 w-2.5 rounded-full bg-white/8" />
                          </div>
                          <div
                            className="absolute right-3 top-3 h-5 w-5 rounded-full border border-white/20"
                            style={{ background: preset.colors.primary, boxShadow: `0 0 18px ${preset.colors.accentGlow}` }}
                          />
                          <div
                            className="absolute left-3 bottom-3 h-2 w-20 rounded-full"
                            style={{ background: `linear-gradient(90deg, ${preset.colors.primary}, ${preset.colors.secondary})` }}
                          />
                        </div>
                        <div className="relative space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-content">{preset.name}</span>
                            <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Selected" : "Preset"}</Badge>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {[preset.colors.bg, preset.colors.bgCard, preset.colors.primary, preset.colors.secondary].map((color) => (
                              <span key={color} className="h-3.5 flex-1 rounded-full border border-white/10" style={{ background: color }} />
                            ))}
                          </div>
                        </div>
                        {isActive && (
                          <span className="absolute right-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full border border-primary-border bg-bg-soft text-primary shadow-[0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_14%,transparent)]">
                            <Check className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col justify-between gap-4 border-t border-bg-border pt-4 lg:flex-row lg:items-center">
            <div>
              <p className="text-sm font-semibold text-content">Floating picker</p>
              <p className="mt-0.5 text-xs text-content-muted">Quick access to manual color tuning in the corner of the screen.</p>
            </div>
            <Button type="button" variant={pickerEnabled ? "default" : "secondary"} onClick={togglePicker} className="min-w-40">
              {pickerEnabled ? "Enabled" : "Disabled"}
            </Button>
          </div>

          <div className="border-t border-bg-border pt-4">
            <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="flex w-full items-center gap-2 text-left">
              <Palette className="h-4 w-4 text-content-muted" />
              <span className="flex-1 text-sm font-semibold text-content">Advanced editor</span>
              {showAdvanced ? <ChevronUp className="h-4 w-4 text-content-muted" /> : <ChevronDown className="h-4 w-4 text-content-muted" />}
            </button>
            {showAdvanced && (
              <div className="mt-4 rounded-2xl border border-bg-border bg-bg-card p-4 shadow-surface-soft">
                <ThemeColorPicker embedded />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
