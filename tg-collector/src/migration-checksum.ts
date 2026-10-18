import { createHash } from "node:crypto";

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function assertMigrationChecksum(name: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error("Applied migration checksum mismatch for " + name +
      ". Do not edit applied migrations; create a new migration.");
  }
}
