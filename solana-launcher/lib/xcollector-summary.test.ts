import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { getXCollectorSummary } from "./xcollector";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("checks the explicitly configured collector installation instead of the UI checkout", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "x-installation-"));
  try {
    fs.mkdirSync(path.join(directory, "node_modules"));
    fs.mkdirSync(path.join(directory, "migrations"));
    vi.stubEnv("X_COLLECTOR_DIR", directory);
    vi.stubEnv("X_COLLECTOR_ENV", path.join(directory, ".env"));
    vi.stubEnv("X_COLLECTOR_DATABASE_URL", "");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const result = await getXCollectorSummary();
    expect(result.installed).toBe(true);
    expect(result.nodeModulesPresent).toBe(true);
    expect(result.migrations.path).toBe(path.join(directory, "migrations"));
    expect(result.migrations.complete).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
it("does not mistake the product database for a missing collector configuration", async () => {
  vi.stubEnv("X_COLLECTOR_ENV", path.join(os.tmpdir(), "missing-x-summary-config", ".env"));
  vi.stubEnv("X_COLLECTOR_DATABASE_URL", "");
  vi.stubEnv("X_COLLECTOR_MASTER_KEY", "");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:synthetic@127.0.0.1:1/product");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  const result = await getXCollectorSummary();
  expect(result.env).toEqual({ databaseUrlConfigured: false, masterKeyConfigured: false });
  expect(result.db).toEqual({ reachable: false, detail: "DATABASE_URL не задан" });
});
it("uses X_COLLECTOR_ENV and a real AbortSignal without reporting a false timeout", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "x-summary-"));
  const server = net.createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as net.AddressInfo).port;
    const filename = path.join(directory, ".env");
    fs.writeFileSync(filename, `DATABASE_URL=postgresql://fixture:synthetic@127.0.0.1:${port}/fixture\nMASTER_KEY=fixture-only`);
    vi.stubEnv("X_COLLECTOR_ENV", filename);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const result = await getXCollectorSummary();
    expect(result.env).toEqual({ databaseUrlConfigured: true, masterKeyConfigured: true });
    expect(result.db.reachable).toBe(true);
    expect(result.db.detail).toContain("TCP only");
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(JSON.stringify(result)).not.toContain("fixture-only");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  }
});
