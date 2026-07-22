"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type QueryKey = readonly unknown[];
export type QueryStatus = "idle" | "pending" | "success" | "error";

export type UseQueryOptions<TData> = {
  queryKey: QueryKey;
  queryFn: () => Promise<TData>;
  initialData?: TData;
  staleTime?: number;
  gcTime?: number;
  refetchOnMount?: boolean | "always";
  refetchOnWindowFocus?: boolean;
  retry?: number;
};

export type UseQueryResult<TData> = {
  data: TData | undefined;
  error: unknown | null;
  isPending: boolean;
  isFetching: boolean;
  status: QueryStatus;
  refetch: () => Promise<{ data: TData | undefined }>;
};

type QueryState<TData> = {
  data: TData | undefined;
  error: unknown | null;
  status: QueryStatus;
  isFetching: boolean;
  updatedAt: number;
  promise: Promise<TData> | null;
  listeners: Set<() => void>;
};

function keyToString(key: QueryKey) {
  return JSON.stringify(key);
}

function isBrowser() {
  return typeof window !== "undefined";
}

export class QueryClient {
  private cache = new Map<string, QueryState<unknown>>();

  private ensureState<TData>(key: string, initialData?: TData): QueryState<TData> {
    let state = this.cache.get(key) as QueryState<TData> | undefined;
    if (!state) {
      state = {
        data: initialData,
        error: null,
        status: initialData === undefined ? "idle" : "success",
        isFetching: false,
        updatedAt: initialData === undefined ? 0 : Date.now(),
        promise: null,
        listeners: new Set(),
      };
      this.cache.set(key, state as QueryState<unknown>);
    } else if (initialData !== undefined && state.data === undefined) {
      state.data = initialData;
      state.status = "success";
      state.updatedAt = Date.now();
    }
    return state;
  }

  private notify(key: string) {
    const state = this.cache.get(key);
    if (!state) return;
    for (const listener of state.listeners) listener();
  }

  getSnapshot<TData>(key: QueryKey, initialData?: TData): QueryState<TData> {
    return this.ensureState<TData>(keyToString(key), initialData);
  }

  subscribe(key: QueryKey, listener: () => void, initialData?: unknown) {
    const keyString = keyToString(key);
    const state = this.ensureState(keyString, initialData);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
      if (state.listeners.size === 0 && state.status === "idle" && !state.promise) {
        this.cache.delete(keyString);
      }
    };
  }

  getQueryData<TData>(key: QueryKey): TData | undefined {
    return this.cache.get(keyToString(key))?.data as TData | undefined;
  }

  setQueryData<TData>(key: QueryKey, data: TData) {
    const keyString = keyToString(key);
    const state = this.ensureState<TData>(keyString);
    state.data = data;
    state.error = null;
    state.status = "success";
    state.isFetching = false;
    state.updatedAt = Date.now();
    state.promise = null;
    this.notify(keyString);
  }

  async fetchQuery<TData>(key: QueryKey, queryFn: () => Promise<TData>): Promise<TData> {
    const keyString = keyToString(key);
    const state = this.ensureState<TData>(keyString);

    if (state.promise) {
      return state.promise;
    }

    state.isFetching = true;
    state.status = state.data === undefined ? "pending" : state.status;
    state.error = null;
    this.notify(keyString);

    const promise = queryFn()
      .then((data) => {
        state.data = data;
        state.error = null;
        state.status = "success";
        state.isFetching = false;
        state.updatedAt = Date.now();
        state.promise = null;
        this.notify(keyString);
        return data;
      })
      .catch((error) => {
        state.error = error;
        state.status = state.data === undefined ? "error" : state.status;
        state.isFetching = false;
        state.promise = null;
        this.notify(keyString);
        throw error;
      });

    state.promise = promise;
    return promise;
  }

  async invalidateQueries({ queryKey }: { queryKey: QueryKey }) {
    const keyString = keyToString(queryKey);
    const state = this.cache.get(keyString);
    if (!state) return;
    state.updatedAt = 0;
    this.notify(keyString);
  }
}

const QueryClientContext = createContext<QueryClient | null>(null);

export function QueryClientProvider({ client, children }: { client: QueryClient; children: ReactNode }) {
  return React.createElement(QueryClientContext.Provider, { value: client }, children);
}

export function useQueryClient() {
  const client = useContext(QueryClientContext);
  if (!client) {
    throw new Error("useQuery must be used within QueryClientProvider");
  }
  return client;
}

export function useQuery<TData>({
  queryKey,
  queryFn,
  initialData,
  staleTime = 0,
  refetchOnMount = "always",
  refetchOnWindowFocus = false,
}: UseQueryOptions<TData>): UseQueryResult<TData> {
  const client = useQueryClient();
  const keyString = useMemo(() => keyToString(queryKey), [queryKey]);
  const queryFnRef = useRef(queryFn);
  queryFnRef.current = queryFn;

  const [snapshot, setSnapshot] = useState<QueryState<TData>>(() => client.getSnapshot<TData>(queryKey, initialData));

  useEffect(() => {
    const nextSnapshot = client.getSnapshot<TData>(queryKey, initialData);
    setSnapshot({ ...nextSnapshot, listeners: nextSnapshot.listeners });

    const unsubscribe = client.subscribe(queryKey, () => {
      setSnapshot({ ...client.getSnapshot<TData>(queryKey), listeners: client.getSnapshot<TData>(queryKey).listeners });
    }, initialData);

    const isStale = nextSnapshot.updatedAt === 0 || Date.now() - nextSnapshot.updatedAt >= staleTime;
    const shouldRefetch =
      nextSnapshot.data === undefined ||
      refetchOnMount === "always" ||
      (refetchOnMount === true && isStale);

    if (shouldRefetch) {
      void client.fetchQuery<TData>(queryKey, queryFnRef.current).catch(() => undefined);
    }

    let removeFocus: (() => void) | undefined;
    if (refetchOnWindowFocus && isBrowser()) {
      const onFocus = () => {
        const current = client.getSnapshot<TData>(queryKey, initialData);
        const currentIsStale = current.updatedAt === 0 || Date.now() - current.updatedAt >= staleTime;
        if (current.data === undefined || currentIsStale) {
          void client.fetchQuery<TData>(queryKey, queryFnRef.current).catch(() => undefined);
        }
      };
      window.addEventListener("focus", onFocus);
      removeFocus = () => window.removeEventListener("focus", onFocus);
    }

    return () => {
      unsubscribe();
      removeFocus?.();
    };
  }, [client, keyString, initialData, refetchOnMount, refetchOnWindowFocus, staleTime]);

  const refetch = useCallback(async () => {
    const data = await client.fetchQuery<TData>(queryKey, queryFnRef.current);
    return { data };
  }, [client, queryKey]);

  return {
    data: snapshot.data,
    error: snapshot.error,
    isPending: snapshot.status === "idle" || snapshot.status === "pending",
    isFetching: snapshot.isFetching,
    status: snapshot.status,
    refetch,
  };
}
