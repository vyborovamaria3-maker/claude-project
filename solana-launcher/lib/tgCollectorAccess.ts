import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export function guardTgCollector(request: NextRequest, mutation = false): NextResponse | null {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({error:"Not found"}, {status:404,headers:noStore});
  }
  const host = request.nextUrl.hostname.toLowerCase();
  const incomingHost = (request.headers.get("host") ?? "").toLowerCase();
  const headerIsLoopback = /^(?:localhost|127\\.0\\.0\\.1)(?::\\d{1,5})?$|^\\[::1\\](?::\\d{1,5})?$/.test(incomingHost);
  if (!["localhost","127.0.0.1","::1","[::1]"].includes(host) ||
      !headerIsLoopback) {
    return NextResponse.json({error:"Localhost only"}, {status:403,headers:noStore});
  }
  if (mutation && request.headers.get("origin") !== request.nextUrl.origin) {
    return NextResponse.json({error:"Same-origin request required"}, {status:403,headers:noStore});
  }
  const secret = process.env.TG_COLLECTOR_ADMIN_TOKEN;
  if (!secret || secret.length < 24) {
    return NextResponse.json({
      error:"Configure TG_COLLECTOR_ADMIN_TOKEN (at least 24 characters) in solana-launcher/.env.local",
    }, {status:503,headers:noStore});
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Hash both inputs to avoid leaking matching prefix or secret length.
  const expectedHash = createHash("sha256").update(secret,"utf8").digest();
  const providedHash = createHash("sha256").update(provided,"utf8").digest();
  if (!provided || !timingSafeEqual(expectedHash,providedHash)) {
    return NextResponse.json({error:"TG Collector access key required"}, {status:401,headers:noStore});
  }
  return null;
}
