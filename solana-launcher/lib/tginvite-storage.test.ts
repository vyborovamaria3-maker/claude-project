import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTGInviteStorageOwner, storage } from "./tginvite-storage";

const USER_A = "123e4567-e89b-12d3-a456-426614174000";
const USER_B = "123e4567-e89b-12d3-a456-426614174001";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    [Symbol.iterator]: () => values.keys(),
  });
});

afterEach(() => {
  bindTGInviteStorageOwner(null);
  vi.unstubAllGlobals();
});

describe("owner-scoped TGInvite browser state", () => {
  it("refuses to persist state before identity is verified", () => {
    bindTGInviteStorageOwner(null);
    storage.set("channels", [{ id: "private" }]);
    expect(storage.get("channels", [])).toEqual([]);
  });

  it("cannot read another account's channel or job state", () => {
    bindTGInviteStorageOwner(USER_A);
    storage.set("channels", [{ id: "owner-A" }]);
    storage.set("jobs", [{ id: "job-A" }]);
    bindTGInviteStorageOwner(USER_B);
    expect(storage.get("channels", [])).toEqual([]);
    expect(storage.get("jobs", [])).toEqual([]);
    storage.set("channels", [{ id: "owner-B" }]);
    bindTGInviteStorageOwner(USER_A);
    expect(storage.get("channels", [])).toEqual([{ id: "owner-A" }]);
    expect(storage.get("jobs", [])).toEqual([{ id: "job-A" }]);
  });

  it("ignores unscoped legacy storage instead of gifting it to the next user", () => {
    localStorage.setItem("tginvite_channels", JSON.stringify([{ id: "legacy" }]));
    bindTGInviteStorageOwner(USER_B);
    expect(storage.get("channels", [])).toEqual([]);
  });

  it("clears only the active owner's storage", () => {
    bindTGInviteStorageOwner(USER_A);
    storage.set("channels", [{ id: "A" }]);
    bindTGInviteStorageOwner(USER_B);
    storage.set("channels", [{ id: "B" }]);
    storage.clear();
    bindTGInviteStorageOwner(USER_A);
    expect(storage.get("channels", [])).toEqual([{ id: "A" }]);
    bindTGInviteStorageOwner(USER_B);
    expect(storage.get("channels", [])).toEqual([]);
  });

  it("rejects an invalid identity", () => {
    expect(() => bindTGInviteStorageOwner("not-an-identity")).toThrow();
  });
});
