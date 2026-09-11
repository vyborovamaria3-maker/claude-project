"use client";

import { useState, useCallback, useRef } from "react";
import { useToast } from "./Toast";

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  silent?: boolean;
}

export function useApi() {
  const loadingCountRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const { error: toastError } = useToast();

  const call = useCallback(
    async <T>(url: string, options?: ApiOptions): Promise<T | null> => {
      loadingCountRef.current++;
      setLoading(true);
      try {
        const res = await fetch(url, {
          method: options?.method || "POST",
          headers: { "Content-Type": "application/json" },
          body: options?.body ? JSON.stringify(options.body) : undefined,
        });

        const data = await res.json();

        if (!res.ok) {
          const errMsg = data.error || `HTTP ${res.status}`;
          if (!options?.silent) {
            toastError("API Error", errMsg);
          }
          return null;
        }

        return data as T;
      } catch (err: unknown) {
        if (!options?.silent) {
          const error = err as { message?: string };
          toastError("Request Failed", error.message || "Unknown error");
        }
        return null;
      } finally {
        loadingCountRef.current--;
        if (loadingCountRef.current === 0) {
          setLoading(false);
        }
      }
    },
    [toastError]
  );

  return { call, loading };
}
