import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const { spawnMock, authMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), authMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./adminAuth", () => ({ requireAdminAuth: authMock }));
import { POST } from "../app/api/integrations/x-collector/register-session/route";
afterEach(() => vi.resetAllMocks());
const request = () => new NextRequest("http://127.0.0.1/api/integrations/x-collector/register-session", {
  method: "POST", headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json" },
  body: JSON.stringify({ handle: "fixture", cookies: "synthetic-session" }),
});
it("does not launch registration when admin authorization denies access", async () => {
  authMock.mockResolvedValue(NextResponse.json({ error: "Administrator required" }, { status: 403 }));
  expect((await POST(request())).status).toBe(403);
  expect(spawnMock).not.toHaveBeenCalled();
});
it("uses installed Node/tsx on both Windows and Linux with explicit optional defaults", async () => {
  authMock.mockResolvedValue(null);
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, kill: vi.fn() });
    setImmediate(() => { child.exitCode = 0; child.emit("close", 0); });
    return child;
  });
  expect((await POST(request())).status).toBe(200);
  const [command, args, options] = spawnMock.mock.calls[0];
  expect(command).toBe(process.execPath);
  expect(args[0]).toBe(path.resolve(process.cwd(), "../x-collector/node_modules/tsx/dist/cli.mjs"));
  expect(args.slice(-3)).toEqual(["{}", "", "UTC"]);
  expect(options.shell).toBeUndefined();
  expect(options.windowsHide).toBe(true);
});
