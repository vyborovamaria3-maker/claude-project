"use client";
// data-tag: components.trade.search_bar

import { useEffect, useRef, useState } from "react";
import { Search, Loader2, History, ClipboardPaste } from "lucide-react";

const HISTORY_KEY = "trade.search.history";
const MAX_HISTORY = 5;

// Solana base58 mint validation: 32-44 chars, base58 alphabet
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Props {
  onSearch: (mint: string) => void;
  isLoading: boolean;
  initialValue?: string;
}

export default function SearchBar({ onSearch, isLoading, initialValue = "" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const [history, setHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {}
  }, []);

  const submit = (mint: string) => {
    const trimmed = mint.trim();
    if (!trimmed) {
      setError("Поле пустое — введи mint адрес");
      return;
    }
    if (!MINT_RE.test(trimmed)) {
      setError(`Некорректный mint (длина: ${trimmed.length}, нужно 32-44 base58 символа)`);
      return;
    }
    setError(null);

    // Save to history
    try {
      const next = [trimmed, ...history.filter((m) => m !== trimmed)].slice(0, MAX_HISTORY);
      setHistory(next);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {}

    setShowHistory(false);
    onSearch(trimmed);
  };

  // Off-screen textarea for clipboard fallback. It can receive programmatic
  // focus, so keep it out of the tab order but not hidden from accessibility APIs.
  const clipboardRef = useRef<HTMLTextAreaElement>(null);

  const pasteFromClipboard = async () => {
    try {
      
      // Method 1: Modern Clipboard API
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text.trim()) {
          setValue(text.trim());
          setError(null);
          return;
        }
      }
    } catch (e) {
    }
    
    // Method 2: execCommand fallback
    try {
      const el = clipboardRef.current;
      if (el) {
        el.value = '';
        el.focus();
        document.execCommand('paste');
        const text = el.value;
        if (text.trim()) {
          setValue(text.trim());
          setError(null);
          inputRef.current?.focus();
          return;
        }
      }
    } catch (e) {
    }
    
    // Clipboard access can be blocked in embedded browsers, so keep the UI inline.
    setError('Clipboard blocked. Focus the field and press Ctrl+V.');
    inputRef.current?.focus();
  };

  return (
    <div className="relative w-full" data-tag="trade.search_bar">
      {/* Off-screen clipboard fallback; programmatic focus is restored to the visible input. */}
      <textarea
        ref={clipboardRef}
        style={{ position: 'absolute', left: '-9999px', opacity: 0 }}
        tabIndex={-1}
        aria-label="Буфер обмена для вставки"
      />
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onPaste={(e) => {
              // Auto-submit on paste if valid mint
              const pasted = e.clipboardData.getData('text');
              if (MINT_RE.test(pasted.trim())) {
                setTimeout(() => submit(pasted.trim()), 0);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit(inputRef.current?.value ?? value);
              if (e.key === "Escape") setShowHistory(false);
            }}
            onFocus={() => setShowHistory(history.length > 0)}
            onBlur={() => setTimeout(() => setShowHistory(false), 150)}
            placeholder="Введи или вставь mint адрес токена..."
            disabled={isLoading}
            className="w-full pl-10 pr-24 py-3 rounded-lg bg-white/5 border border-bg-border text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-[color-mix(in_srgb,var(--theme-secondary)_50%,transparent)] disabled:opacity-50"
            data-tag="trade.search_input"
          />
          {/* Paste button inside input */}
          <button
            type="button"
            disabled={isLoading}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              pasteFromClipboard();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1.5 rounded-md bg-white/5 hover:bg-[color-mix(in_srgb,var(--theme-secondary)_20%,transparent)] text-white/60 hover:text-[color:var(--theme-secondary)] text-xs flex items-center gap-1 border border-bg-border hover:border-[color-mix(in_srgb,var(--theme-secondary)_40%,transparent)] transition disabled:opacity-40 z-10"
            data-tag="trade.paste_btn"
            title="Вставить из буфера обмена"
          >
            <ClipboardPaste className="w-3.5 h-3.5 pointer-events-none" />
            <span className="hidden sm:inline">Paste</span>
          </button>
          {showHistory && history.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 rounded-lg bg-bg/95 backdrop-blur-md border border-bg-border z-20 overflow-hidden">
              <div className="px-3 py-2 text-xs text-white/40 flex items-center gap-1.5 border-b border-bg-border">
                <History className="w-3 h-3" /> Недавние поиски
              </div>
              {history.map((h) => (
                <button
                  key={h}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setValue(h);
                    submit(h);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-white/70 font-mono hover:bg-white/5 truncate"
                >
                  {h}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            submit(value);
          }}
          disabled={isLoading || !value.trim()}
          className="px-5 py-3 rounded-lg bg-[color:var(--theme-secondary)] text-[color:var(--theme-content-inverted)] text-sm font-semibold hover:brightness-110 disabled:bg-white/5 disabled:text-white/30 disabled:shadow-none disabled:cursor-not-allowed transition flex items-center gap-2"
          data-tag="trade.search_submit"
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Анализировать
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-[color:var(--theme-danger)]">{error}</div>}
    </div>
  );
}
