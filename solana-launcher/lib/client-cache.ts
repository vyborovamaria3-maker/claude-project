import { useMemo, useSyncExternalStore } from "react";

export type CachedEnvelope<T> = {
  value: T;
  savedAt: number;
  expiresAt: number;
};

function isBrowser() {
  return typeof window !== "undefined";
}

function readRawEnvelope(key: string): string | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEnvelope<unknown>;
    if (!parsed || typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) {
      window.localStorage.removeItem(key);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function readCachedValue<T>(key: string): T | null {
  if (!isBrowser()) return null;
  const raw = readRawEnvelope(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedEnvelope<T>;
    return parsed.value;
  } catch {
    return null;
  }
}

export function writeCachedValue<T>(key: string, value: T, ttlMs: number) {
  if (!isBrowser()) return;
  try {
    const now = Date.now();
    const envelope: CachedEnvelope<T> = {
      value,
      savedAt: now,
      expiresAt: now + ttlMs,
    };
    window.localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // ignore quota / serialization issues
  }
}

export function removeCachedValue(key: string) {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function subscribeToKey(key: string, callback: () => void) {
  if (!isBrowser()) return () => undefined;

  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === window.localStorage && event.key === key) {
      callback();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function useCachedValue<T>(key: string): T | null {
  const raw = useSyncExternalStore(
    (callback) => subscribeToKey(key, callback),
    () => readRawEnvelope(key),
    () => null,
  );

  return useMemo(() => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CachedEnvelope<T>;
      return parsed.value;
    } catch {
      return null;
    }
  }, [raw]);
}
