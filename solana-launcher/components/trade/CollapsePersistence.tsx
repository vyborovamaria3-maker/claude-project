"use client";

import { useEffect } from "react";

const ROOT_SELECTOR = '[data-tag="trade.live_intelligence.v2"]';

function stableKey(details: HTMLDetailsElement, index: number) {
  const explicit = details.dataset.collapse?.trim();
  if (explicit) return explicit;
  const summary = details.querySelector("summary")?.textContent
    ?.trim()
    .replace(/\d+(?:[.,]\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return summary ? `auto-${index}-${summary}` : `auto-${index}`;
}

export default function CollapsePersistence() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(ROOT_SELECTOR);
    if (!root) return;

    const mint = new URLSearchParams(window.location.search).get("mint")?.trim() || "unknown";
    const bound = new Map<HTMLDetailsElement, () => void>();

    const bind = () => {
      const details = Array.from(root.querySelectorAll<HTMLDetailsElement>("details"));
      details.forEach((element, index) => {
        if (bound.has(element)) return;
        const key = `trade.live-intelligence.collapse:${mint}:${stableKey(element, index)}`;
        let saved: string | null = null;
        try { saved = window.localStorage.getItem(key); } catch { saved = null; }
        if (saved === "1" || saved === "0") element.open = saved === "1";
        else if (element.dataset.defaultOpen === "true") element.open = true;
        else if (element.dataset.defaultOpen === "false") element.open = false;

        const onToggle = () => {
          try { window.localStorage.setItem(key, element.open ? "1" : "0"); } catch { /* localStorage can be unavailable */ }
        };
        element.addEventListener("toggle", onToggle);
        bound.set(element, () => element.removeEventListener("toggle", onToggle));
      });
    };

    bind();
    const observer = new MutationObserver(bind);
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      bound.forEach((cleanup) => cleanup());
      bound.clear();
    };
  }, []);

  return null;
}
