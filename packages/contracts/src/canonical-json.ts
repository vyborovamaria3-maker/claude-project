import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | string
  | number
  | boolean
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/**
 * Deterministic JSON serialization for event identities and SHA-256.
 * Object keys are sorted; arrays retain order. Values JSON.stringify would
 * silently drop or rewrite (undefined, sparse arrays, accessors, custom
 * prototypes, non-finite numbers, cycles) are rejected instead.
 */
export function canonicalJsonStringify(value: unknown): string {
  const active = new Set<object>();

  const serialize = (current: unknown, path: string): string => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError("Non-finite number at " + path);
      }
      return JSON.stringify(current);
    }
    if (typeof current !== "object") {
      throw new TypeError("Non-JSON value at " + path);
    }
    if (active.has(current)) {
      throw new TypeError("Circular JSON value at " + path);
    }
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Object.keys(current);
        const ownNames = Object.getOwnPropertyNames(current);
        if (keys.length !== current.length ||
            ownNames.length !== current.length + 1 ||
            keys.some((key, index) => key !== String(index)) ||
            Object.getOwnPropertySymbols(current).length > 0) {
          throw new TypeError("Sparse or extended array at " + path);
        }
        const values: string[] = [];
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            throw new TypeError("Accessor or invalid array element at " + path + "[" + index + "]");
          }
          values.push(serialize(descriptor.value, path + "[" + index + "]"));
        }
        return "[" + values.join(",") + "]";
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Non-plain object at " + path);
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new TypeError("Symbol key at " + path);
      }
      const ownNames = Object.getOwnPropertyNames(current);
      const keys = Object.keys(current).sort();
      if (ownNames.length !== keys.length) {
        throw new TypeError("Non-enumerable property at " + path);
      }
      const entries: string[] = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("Accessor or invalid property at " + path + "." + key);
        }
        entries.push(
          JSON.stringify(key) + ":" + serialize(descriptor.value, path + "." + key),
        );
      }
      return "{" + entries.join(",") + "}";
    } finally {
      active.delete(current);
    }
  };

  return serialize(value, "$");
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(value), "utf8")
    .digest("hex");
}
