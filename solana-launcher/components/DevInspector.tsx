"use client";

import { useEffect, useRef, useState } from "react";
import { Crosshair, X } from "lucide-react";
import { notifyElementSelected } from "./ChatWidget";

// data-tag: dev.inspector
export default function DevInspector() {
  const [active, setActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) return;

    let highlighted: HTMLElement | null = null;

    const getTagInfo = (el: HTMLElement): string => {
      const tag = el.getAttribute("data-tag");
      const comp = el.getAttribute("data-component-name");
      const parts: string[] = [];
      if (tag) parts.push(`data-tag: "${tag}"`);
      if (comp) parts.push(`component: <${comp}>`);
      if (!tag && !comp) parts.push(`<${el.tagName.toLowerCase()}> (no tag)`);
      return parts.join("  •  ");
    };

    const onMove = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target === highlighted) return;
      if (highlighted) {
        highlighted.style.outline = "";
        highlighted.style.outlineOffset = "";
        highlighted.style.cursor = "";
      }
      highlighted = target;
      target.style.outline = "2px solid #00B894";
      target.style.outlineOffset = "2px";
      target.style.cursor = "pointer";
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Allow toggle button to work — don't capture its click
      if (target.closest("[data-tag='dev.inspector.toggle']")) return;
      e.preventDefault();
      e.stopPropagation();
      const info = getTagInfo(target);
      navigator.clipboard.writeText(info).catch(() => {});
      
      // Send to chat widget
      notifyElementSelected(info);
      
      showToast(info + " → отправлено в чат");
      // Exit inspector after a successful pick
      setActive(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(false);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
      if (highlighted) {
        highlighted.style.outline = "";
        highlighted.style.outlineOffset = "";
        highlighted.style.cursor = "";
      }
    };
  }, [active]);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  return (
    <>
      {/* Toggle button — fixed bottom-right */}
      <button
        type="button"
        data-tag="dev.inspector.toggle"
        onClick={() => setActive((a) => !a)}
        title={active ? "Выключить инспектор" : "Включить инспектор элементов"}
        className={[
          "fixed bottom-6 right-6 z-[9999] w-11 h-11 rounded-full flex items-center justify-center border transition shadow-lg",
          active
            ? "bg-neon-green text-bg border-neon-green shadow-neon-green"
            : "bg-bg-card border-bg-border text-white/60 hover:border-white/30 hover:text-white",
        ].join(" ")}
      >
        {active ? <X className="w-5 h-5" /> : <Crosshair className="w-5 h-5" />}
      </button>

      {/* Banner while active */}
      {active && (
        <div
          data-tag="dev.inspector.banner"
          className="fixed top-0 left-0 right-0 z-[9998] bg-neon-green/90 text-bg text-xs font-semibold text-center py-1.5 pointer-events-none"
        >
          Режим инспектора активен — кликни на любой блок чтобы скопировать его тег
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          data-tag="dev.inspector.toast"
          className="fixed bottom-20 right-6 z-[9999] max-w-sm rounded-xl border border-neon-green/40 bg-bg-card shadow-neon-green px-4 py-3 text-sm font-mono text-neon-green break-all"
        >
          <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Скопировано и отправлено в чат</div>
          {toast}
        </div>
      )}
    </>
  );
}
