"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Palette, X, Undo2, MousePointer, Trash2, Check, Heart } from "lucide-react";
import {
  deriveColors,
  loadTheme,
  saveTheme,
  saveThemePresetId,
  applyTheme,
  loadElementColors,
  saveElementColors,
  loadFavorites,
  saveFavorites,
  PRESET_COLORS,
  THEME_PRESETS,
  type ThemeColors,
  type ElementColorConfig,
  type FavoriteScheme,
} from "@/lib/themeColors";

const DEFAULT_THEME = THEME_PRESETS[0];
const DEFAULT_COLOR = DEFAULT_THEME?.colors.bg ?? "#180a0e";
const ELEMENT_COLORS_KEY = "solana-launcher.element-colors";

export default function ThemeColorPicker({ embedded = false }: { embedded?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [currentColor, setCurrentColor] = useState(DEFAULT_COLOR);
  const [derived, setDerived] = useState<ThemeColors>(() => DEFAULT_THEME?.colors ?? deriveColors(DEFAULT_COLOR));
  const [isPicking, setIsPicking] = useState(false);
  const [elementColors, setElementColors] = useState<ElementColorConfig[]>([]);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<FavoriteScheme[]>([]);
  const [favoriteName, setFavoriteName] = useState("");
  const [showAddFavorite, setShowAddFavorite] = useState(false);
  const hoverOverlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const saved = loadTheme();
    if (saved) {
      setCurrentColor(saved.bg);
      setDerived(saved);
      applyTheme(saved);
    } else {
      const defaults = DEFAULT_THEME?.colors ?? deriveColors(DEFAULT_COLOR);
      setDerived(defaults);
      applyTheme(defaults);
    }
    const savedElements = loadElementColors();
    setElementColors(savedElements);
    applyElementColors(savedElements);
    setFavorites(loadFavorites());
  }, []);

  const applyElementColors = (configs: ElementColorConfig[]) => {
    configs.forEach(cfg => {
      const el = document.querySelector(cfg.selector) as HTMLElement | null;
      if (el) {
        el.style.backgroundColor = cfg.color;
        el.style.transition = "background-color 0.2s ease";
      }
    });
  };

  const generateSelector = (el: HTMLElement): string => {
    if (el.id) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).join(".");
    const dataTag = el.getAttribute("data-tag");
    if (dataTag) return `[data-tag="${dataTag}"]`;
    if (classes) return `${tag}.${classes}`;
    return tag;
  };

  const startPicking = () => {
    setIsPicking(true);
    document.body.style.cursor = "crosshair";
  };

  const stopPicking = () => {
    setIsPicking(false);
    document.body.style.cursor = "";
    if (hoverOverlayRef.current) {
      hoverOverlayRef.current.remove();
      hoverOverlayRef.current = null;
    }
  };

  useEffect(() => {
    if (!isPicking) return;

    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target || target.closest("[data-tag='theme.panel']") || target.closest("[data-tag='theme.toggle']")) return;
      e.preventDefault();
      
      const rect = target.getBoundingClientRect();
      let overlay = hoverOverlayRef.current;
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.style.position = "fixed";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "999999";
        overlay.style.border = "2px dashed #7c3aed";
        overlay.style.background = "rgba(124, 58, 237, 0.1)";
        overlay.style.borderRadius = "4px";
        document.body.appendChild(overlay);
        hoverOverlayRef.current = overlay;
      }
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    };

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target || target.closest("[data-tag='theme.panel']") || target.closest("[data-tag='theme.toggle']")) return;
      e.preventDefault();
      e.stopPropagation();
      
      const selector = generateSelector(target);
      const existingIndex = elementColors.findIndex(ec => ec.selector === selector);
      
      if (existingIndex >= 0) {
        const id = elementColors[existingIndex].id;
        setSelectedElementIds(prev => prev.includes(id) ? prev : [...prev, id]);
      } else {
        const newConfig: ElementColorConfig = {
          id: Math.random().toString(36).slice(2),
          selector,
          color: currentColor,
          name: target.getAttribute("data-tag") || target.tagName.toLowerCase(),
        };
        const updated = [...elementColors, newConfig];
        setElementColors(updated);
        saveElementColors(updated);
        applyElementColors([newConfig]);
        setSelectedElementIds(prev => [...prev, newConfig.id]);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") stopPicking();
    };

    document.addEventListener("mouseover", handleMouseOver, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mouseover", handleMouseOver, true);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPicking, currentColor, elementColors]);

  const handleChange = useCallback((hex: string) => {
    setCurrentColor(hex);
    const colors = deriveColors(hex);
    setDerived(colors);
    applyTheme(colors);
    saveTheme(colors);
    saveThemePresetId("custom");
  }, []);

  const handleReset = useCallback(() => {
    setCurrentColor(DEFAULT_COLOR);
    const colors = DEFAULT_THEME?.colors ?? deriveColors(DEFAULT_COLOR);
    setDerived(colors);
    applyTheme(colors);
    saveTheme(colors);
    if (DEFAULT_THEME?.id) saveThemePresetId(DEFAULT_THEME.id);
    elementColors.forEach(cfg => {
      const el = document.querySelector(cfg.selector) as HTMLElement | null;
      if (el) el.style.backgroundColor = "";
    });
    setElementColors([]);
    saveElementColors([]);
    setSelectedElementIds([]);
  }, [elementColors]);

  const updateElementColor = (id: string, color: string) => {
    const updated = elementColors.map(ec => ec.id === id ? { ...ec, color } : ec);
    setElementColors(updated);
    saveElementColors(updated);
    const cfg = updated.find(ec => ec.id === id);
    if (cfg) applyElementColors([cfg]);
  };

  const updateSelectedColors = (color: string) => {
    if (selectedElementIds.length === 0) return;
    const updated = elementColors.map(ec => selectedElementIds.includes(ec.id) ? { ...ec, color } : ec);
    setElementColors(updated);
    saveElementColors(updated);
    applyElementColors(updated.filter(ec => selectedElementIds.includes(ec.id)));
  };

  const removeElementColor = (id: string) => {
    const cfg = elementColors.find(ec => ec.id === id);
    if (cfg) {
      const el = document.querySelector(cfg.selector) as HTMLElement | null;
      if (el) el.style.backgroundColor = "";
    }
    const updated = elementColors.filter(ec => ec.id !== id);
    setElementColors(updated);
    saveElementColors(updated);
    setSelectedElementIds(prev => prev.filter(sid => sid !== id));
  };

  const addToFavorites = () => {
    if (!favoriteName.trim()) return;
    const newScheme: FavoriteScheme = {
      id: Math.random().toString(36).slice(2),
      name: favoriteName.trim(),
      baseColor: currentColor,
      colors: derived,
      elementColors: elementColors.length > 0 ? elementColors : undefined,
      createdAt: Date.now(),
    };
    const updated = [...favorites, newScheme];
    setFavorites(updated);
    saveFavorites(updated);
    setFavoriteName("");
    setShowAddFavorite(false);
  };

  const removeFavorite = (id: string) => {
    const updated = favorites.filter(f => f.id !== id);
    setFavorites(updated);
    saveFavorites(updated);
  };

  const applyFavorite = (scheme: FavoriteScheme) => {
    setCurrentColor(scheme.baseColor);
    setDerived(scheme.colors);
    applyTheme(scheme.colors);
    saveTheme(scheme.colors);
    saveThemePresetId("custom");
    if (scheme.elementColors) {
      setElementColors(scheme.elementColors);
      saveElementColors(scheme.elementColors);
      applyElementColors(scheme.elementColors);
    }
  };

  if (embedded) {
    return (
      <div data-tag="theme.panel" className="w-full space-y-4">
        {/* Color picker + reset */}
        <div className="space-y-1.5">
          {selectedElementIds.length > 0 && (
            <span className="text-[10px] text-purple-300 uppercase">
              Coloring {selectedElementIds.length} selected element{selectedElementIds.length > 1 ? "s" : ""}
            </span>
          )}
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={selectedElementIds.length > 0 ? (elementColors.find(ec => ec.id === selectedElementIds[0])?.color || currentColor) : currentColor}
              onChange={(e) => selectedElementIds.length > 0 ? updateSelectedColors(e.target.value) : handleChange(e.target.value)}
              className="w-10 h-10 rounded-lg border border-bg-border cursor-pointer bg-transparent p-0"
            />
            <input
              type="text"
              value={selectedElementIds.length > 0 ? (elementColors.find(ec => ec.id === selectedElementIds[0])?.color || currentColor) : currentColor}
              onChange={(e) => {
                const v = e.target.value;
                if (!/^#[0-9a-fA-F]{0,6}$/.test(v)) return;
                if (selectedElementIds.length > 0 && /^#[0-9a-fA-F]{6}$/.test(v)) updateSelectedColors(v);
                else handleChange(v);
              }}
              className="flex-1 bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-xs text-white font-mono focus:border-[var(--theme-accent)]/50 outline-none"
            />
            <button onClick={handleReset} className="p-2 rounded-lg hover:bg-white/10 transition" title="Reset">
              <Undo2 className="w-4 h-4 text-white/50" />
            </button>
          </div>
        </div>

        {/* Derived colors */}
        <div className="space-y-1.5">
          <span className="text-[10px] text-white/40 uppercase">Derived</span>
          <div className="grid grid-cols-4 gap-1.5">
            {(["bg", "bgSoft", "bgCard", "bgBorder"] as const).map((key) => (
              <div key={key} className="text-center">
                <div className="w-full h-7 rounded-md border border-bg-border mb-0.5" style={{ background: derived[key] }} />
                <span className="text-[9px] text-white/40">{key}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Presets */}
        <div className="space-y-1.5">
          <span className="text-[10px] text-white/40 uppercase">Presets</span>
          <div className="grid grid-cols-10 gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => selectedElementIds.length > 0 ? updateSelectedColors(c) : handleChange(c)}
                className="w-full h-7 rounded-md border transition hover:scale-110"
                style={{
                  background: c,
                  borderColor: c === currentColor ? "var(--theme-accent)" : "var(--theme-bg-border)",
                  outline: c === currentColor ? "2px solid var(--theme-accent)" : "none",
                  outlineOffset: "1px",
                }}
              />
            ))}
          </div>
        </div>

        {/* Favorites */}
        <div className="space-y-2 pt-2 border-t border-white/10">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/40 uppercase">Favorites ({favorites.length})</span>
            <button
              onClick={() => setShowAddFavorite(!showAddFavorite)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-white/10 text-white/70 hover:bg-white/20 transition"
            >
              <Heart className="w-3 h-3" />
              {showAddFavorite ? "Cancel" : "Save"}
            </button>
          </div>
          {showAddFavorite && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Scheme name..."
                value={favoriteName}
                onChange={(e) => setFavoriteName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addToFavorites()}
                className="flex-1 bg-bg-soft/60 border border-bg-border rounded-lg px-2 py-1.5 text-xs text-white focus:border-[var(--theme-accent)]/50 outline-none"
              />
              <button
                onClick={addToFavorites}
                disabled={!favoriteName.trim()}
                className="px-2 py-1.5 rounded bg-neon-green/20 text-neon-green text-xs hover:bg-neon-green/30 disabled:opacity-40 transition"
              >Add</button>
            </div>
          )}
          {favorites.length > 0 && (
            <div className="grid grid-cols-2 gap-1">
              {favorites.map((fav) => (
                <div
                  key={fav.id}
                  onClick={() => applyFavorite(fav)}
                  className="flex items-center gap-2 p-1.5 rounded cursor-pointer transition bg-white/5 hover:bg-white/10"
                >
                  <div className="flex -space-x-1">
                    <div className="w-4 h-4 rounded-sm border border-white/20" style={{ background: fav.colors.bg }} />
                    <div className="w-4 h-4 rounded-sm border border-white/20" style={{ background: fav.colors.accent }} />
                  </div>
                  <span className="text-[11px] text-white/70 flex-1 truncate" title={fav.name}>{fav.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFavorite(fav.id); }}
                    className="p-1 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Element picker */}
        <div className="space-y-2 pt-2 border-t border-white/10">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/40 uppercase">Elements ({elementColors.length})</span>
            <div className="flex items-center gap-1">
              {selectedElementIds.length > 0 && (
                <button
                  onClick={() => setSelectedElementIds([])}
                  className="px-2 py-1 rounded text-[10px] bg-white/10 text-white/70 hover:bg-white/20 transition"
                >Clear</button>
              )}
              <button
                onClick={isPicking ? stopPicking : startPicking}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition ${isPicking ? "bg-red-500/20 text-red-400" : "bg-white/10 text-white/70 hover:bg-white/20"}`}
              >
                <MousePointer className="w-3 h-3" />
                {isPicking ? "Done (Esc)" : "Pick"}
              </button>
            </div>
          </div>
          {isPicking && (
            <div className="text-[10px] text-white/50 bg-white/5 rounded px-2 py-1">
              Click elements on the page to select them. Press Esc or Done when finished.
            </div>
          )}
          {elementColors.length > 0 && (
            <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
              {elementColors.map((ec) => (
                <div
                  key={ec.id}
                  onClick={(e) => {
                    const isSel = selectedElementIds.includes(ec.id);
                    if (e.shiftKey || e.ctrlKey || e.metaKey) {
                      setSelectedElementIds(prev => isSel ? prev.filter(id => id !== ec.id) : [...prev, ec.id]);
                    } else {
                      setSelectedElementIds(isSel && selectedElementIds.length === 1 ? [] : [ec.id]);
                    }
                  }}
                  className={`flex items-center gap-2 p-1.5 rounded cursor-pointer transition ${selectedElementIds.includes(ec.id) ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
                >
                  <div className="w-5 h-5 rounded border border-white/20 shrink-0" style={{ background: ec.color }} />
                  <span className="text-[11px] text-white/70 flex-1 truncate" title={ec.selector}>{ec.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeElementColor(ec.id); }}
                    className="p-1 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          data-tag="theme.toggle"
          onClick={() => setIsOpen(true)}
          title="Color palette"
          className="fixed bottom-24 right-4 z-[99999] w-12 h-12 rounded-full flex items-center justify-center border-2 transition shadow-2xl"
          style={{
            background: "#7c3aed",
            borderColor: "#a855f7",
            color: "#fff",
          }}
        >
          <Palette className="w-5 h-5" />
        </button>
      )}

      {isOpen && (
        <div
          data-tag="theme.panel"
          className="fixed top-[4.5rem] right-4 z-[9999] w-72 max-h-[calc(100vh-5.5rem)] overflow-y-auto glass rounded-2xl p-4 space-y-4 shadow-2xl"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-white">Color Palette</span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleReset}
                className="p-1 rounded hover:bg-white/10 transition"
                title="Reset"
              >
                <Undo2 className="w-4 h-4 text-white/50" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 rounded hover:bg-white/10 transition"
                title="Close"
              >
                <X className="w-4 h-4 text-white/50" />
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            {selectedElementIds.length > 0 && (
              <span className="text-[10px] text-purple-300 uppercase">
                Coloring {selectedElementIds.length} selected element{selectedElementIds.length > 1 ? "s" : ""}
              </span>
            )}
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={selectedElementIds.length > 0 ? (elementColors.find(ec => ec.id === selectedElementIds[0])?.color || currentColor) : currentColor}
                onChange={(e) => {
                  if (selectedElementIds.length > 0) {
                    updateSelectedColors(e.target.value);
                  } else {
                    handleChange(e.target.value);
                  }
                }}
                className="w-10 h-10 rounded-lg border border-bg-border cursor-pointer bg-transparent p-0"
              />
              <input
                type="text"
                value={selectedElementIds.length > 0 ? (elementColors.find(ec => ec.id === selectedElementIds[0])?.color || currentColor) : currentColor}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!/^#[0-9a-fA-F]{0,6}$/.test(v)) return;
                  if (selectedElementIds.length > 0 && /^#[0-9a-fA-F]{6}$/.test(v)) {
                    updateSelectedColors(v);
                  } else {
                    handleChange(v);
                  }
                }}
                className="flex-1 bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-xs text-white font-mono focus:border-[var(--theme-accent)]/50 outline-none"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-[10px] text-white/40 uppercase">Derived</span>
            <div className="grid grid-cols-4 gap-1.5">
              {(["bg", "bgSoft", "bgCard", "bgBorder"] as const).map((key) => (
                <div key={key} className="text-center">
                  <div
                    className="w-full h-7 rounded-md border border-bg-border mb-0.5"
                    style={{ background: derived[key] }}
                  />
                  <span className="text-[9px] text-white/40">{key}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-[10px] text-white/40 uppercase">Presets</span>
            <div className="grid grid-cols-6 gap-1.5">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    if (selectedElementIds.length > 0) {
                      updateSelectedColors(c);
                    } else {
                      handleChange(c);
                    }
                  }}
                  className="w-full h-7 rounded-md border transition hover:scale-110"
                  style={{
                    background: c,
                    borderColor: c === currentColor ? "var(--theme-accent)" : "var(--theme-bg-border)",
                    outline: c === currentColor ? "2px solid var(--theme-accent)" : "none",
                    outlineOffset: "1px",
                  }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-white/10">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-white/40 uppercase">Favorites ({favorites.length})</span>
              <button
                onClick={() => setShowAddFavorite(!showAddFavorite)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-white/10 text-white/70 hover:bg-white/20 transition"
              >
                <Heart className="w-3 h-3" />
                {showAddFavorite ? "Cancel" : "Save"}
              </button>
            </div>

            {showAddFavorite && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Scheme name..."
                  value={favoriteName}
                  onChange={(e) => setFavoriteName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addToFavorites()}
                  className="flex-1 bg-bg-soft/60 border border-bg-border rounded-lg px-2 py-1.5 text-xs text-white focus:border-[var(--theme-accent)]/50 outline-none"
                />
                <button
                  onClick={addToFavorites}
                  disabled={!favoriteName.trim()}
                  className="px-2 py-1.5 rounded bg-neon-green/20 text-neon-green text-xs hover:bg-neon-green/30 disabled:opacity-40 transition"
                >
                  Add
                </button>
              </div>
            )}

            {favorites.length > 0 && (
              <div className="space-y-1 max-h-28 overflow-y-auto">
                {favorites.map((fav) => (
                  <div
                    key={fav.id}
                    onClick={() => applyFavorite(fav)}
                    className="flex items-center gap-2 p-1.5 rounded cursor-pointer transition bg-white/5 hover:bg-white/10"
                  >
                    <div className="flex -space-x-1">
                      <div className="w-4 h-4 rounded-sm border border-white/20" style={{ background: fav.colors.bg }} />
                      <div className="w-4 h-4 rounded-sm border border-white/20" style={{ background: fav.colors.accent }} />
                    </div>
                    <span className="text-[11px] text-white/70 flex-1 truncate" title={fav.name}>
                      {fav.name}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFavorite(fav.id); }}
                      className="p-1 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2 pt-2 border-t border-white/10">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-white/40 uppercase">Elements ({elementColors.length})</span>
              <div className="flex items-center gap-1">
                {selectedElementIds.length > 0 && (
                  <button
                    onClick={() => setSelectedElementIds([])}
                    title="Clear selection"
                    className="px-2 py-1 rounded text-[10px] bg-white/10 text-white/70 hover:bg-white/20 transition"
                  >
                    Clear
                  </button>
                )}
                <button
                  onClick={isPicking ? stopPicking : startPicking}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition ${isPicking ? "bg-red-500/20 text-red-400" : "bg-white/10 text-white/70 hover:bg-white/20"}`}
                >
                  <MousePointer className="w-3 h-3" />
                  {isPicking ? "Done (Esc)" : "Pick"}
                </button>
              </div>
            </div>
            
            {isPicking && (
              <div className="text-[10px] text-white/50 bg-white/5 rounded px-2 py-1">
                Click multiple elements to add to selection. Press Esc or Done when finished, then pick a color.
              </div>
            )}
            {selectedElementIds.length > 1 && (
              <div className="text-[10px] text-purple-300 bg-purple-500/10 rounded px-2 py-1">
                {selectedElementIds.length} elements selected. Pick a color or preset to apply to all.
              </div>
            )}

            {elementColors.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {elementColors.map((ec) => (
                  <div
                    key={ec.id}
                    onClick={(e) => {
                      const isSel = selectedElementIds.includes(ec.id);
                      if (e.shiftKey || e.ctrlKey || e.metaKey) {
                        setSelectedElementIds(prev => isSel ? prev.filter(id => id !== ec.id) : [...prev, ec.id]);
                      } else {
                        setSelectedElementIds(isSel && selectedElementIds.length === 1 ? [] : [ec.id]);
                      }
                    }}
                    className={`flex items-center gap-2 p-1.5 rounded cursor-pointer transition ${selectedElementIds.includes(ec.id) ? "bg-white/20" : "bg-white/5 hover:bg-white/10"}`}
                  >
                    <div
                      className="w-5 h-5 rounded border border-white/20"
                      style={{ background: ec.color }}
                    />
                    <span className="text-[11px] text-white/70 flex-1 truncate" title={ec.selector}>
                      {ec.name}
                    </span>
                    {selectedElementIds.includes(ec.id) && <Check className="w-3 h-3 text-green-400" />}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeElementColor(ec.id); }}
                      className="p-1 rounded hover:bg-red-500/20 text-white/40 hover:text-red-400"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {selectedElementIds.length > 0 && (
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="color"
                  value={elementColors.find(ec => ec.id === selectedElementIds[0])?.color || currentColor}
                  onChange={(e) => updateSelectedColors(e.target.value)}
                  className="w-8 h-8 rounded border border-bg-border cursor-pointer bg-transparent p-0"
                />
                <span className="text-[10px] text-white/50">
                  {selectedElementIds.length === 1 ? "Change color for selected" : `Apply to ${selectedElementIds.length} selected`}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}