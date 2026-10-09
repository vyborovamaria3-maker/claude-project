import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { requireProdAuth } from "@/lib/routeAuth";

const X_COLLECTOR_DIR_REL = "..\\x-collector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getXCollectorDir() {
  return path.resolve(process.cwd(), X_COLLECTOR_DIR_REL);
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireProdAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const { handle, cookies, proxy, user_agent, timezone } = body;

    if (!handle || !cookies) {
      return NextResponse.json({ error: "handle и cookies обязательны" }, { status: 400 });
    }

    const dir = getXCollectorDir();
    const script = path.join(dir, "scripts", "register.ts");

    return new Promise<NextResponse>((resolve) => {
      const child = spawn("npx", ["tsx", script, handle, cookies, JSON.stringify(proxy), user_agent, timezone], {
        cwd: dir,
        env: { ...process.env },
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      child.on("close", (code) => {
        if (code === 0) {
          resolve(NextResponse.json({ ok: true, output: stdout }));
        } else {
          resolve(NextResponse.json({ error: stderr || "Register failed" }, { status: 500 }));
        }
      });

      child.on("error", (error) => {
        resolve(NextResponse.json({ error: error.message }, { status: 500 }));
      });

      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill();
          resolve(NextResponse.json({ error: "Registration timeout" }, { status: 504 }));
        }
      }, 30_000);
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to register session" },
      { status: 500 },
    );
  }
}
