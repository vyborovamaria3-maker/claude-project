"use client";

import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, ReactNode } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";

interface Toast {
  id: string;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextType {
  toast: (t: Omit<Toast, "id">) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  const addToast = useCallback((t: Omit<Toast, "id">) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...t, id }]);
    const timeout = setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
      timeoutsRef.current.delete(id);
    }, t.duration || 4000);
    timeoutsRef.current.set(id, timeout);
  }, []);

  const removeToast = useCallback((id: string) => {
    const timeout = timeoutsRef.current.get(id);
    if (timeout) {
      clearTimeout(timeout);
      timeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      timeouts.forEach((t) => clearTimeout(t));
    };
  }, []);

  const icons = {
    success: <CheckCircle2 className="h-4 w-4 text-green-400" />,
    error: <XCircle className="h-4 w-4 text-red-400" />,
    warning: <AlertTriangle className="h-4 w-4 text-yellow-400" />,
    info: <Info className="h-4 w-4 text-blue-400" />,
  };

  const bgColors = {
    success: "border-green-500/30 bg-green-500/10",
    error: "border-red-500/30 bg-red-500/10",
    warning: "border-yellow-500/30 bg-yellow-500/10",
    info: "border-blue-500/30 bg-blue-500/10",
  };

  const contextValue = useMemo(() => ({
    toast: addToast,
    success: (title: string, message?: string) => addToast({ type: "success", title, message }),
    error: (title: string, message?: string) => addToast({ type: "error", title, message }),
    warning: (title: string, message?: string) => addToast({ type: "warning", title, message }),
    info: (title: string, message?: string) => addToast({ type: "info", title, message }),
  }), [addToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-start gap-3 p-3 rounded-xl border backdrop-blur-xl shadow-lg animate-in slide-in-from-right ${bgColors[t.type]}`}
          >
            <div className="mt-0.5">{icons[t.type]}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{t.title}</div>
              {t.message && (
                <div className="text-xs text-content-muted mt-0.5">{t.message}</div>
              )}
            </div>
            <button onClick={() => removeToast(t.id)} className="text-content-muted hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
