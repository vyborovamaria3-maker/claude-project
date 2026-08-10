import { NextResponse } from "next/server";
import { proxyJsonRequest } from "@/lib/authProxy";

const SESSION_COOKIE = "potapoff_access_token";

export async function POST(request: Request) {
  const upstream = await proxyJsonRequest(request, "/api/v1/auth/login-password");
  const text = await upstream.text();
  const response = new NextResponse(text, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    },
  });

  if (!upstream.ok) return response;

  try {
    const payload = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (payload.access_token) {
      const maxAge = Number.isFinite(payload.expires_in)
        ? Math.max(60, Math.min(Number(payload.expires_in), 24 * 60 * 60))
        : 24 * 60 * 60;
      response.cookies.set(SESSION_COOKIE, payload.access_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge,
      });
    }
  } catch {
    // Preserve the upstream response even if an unexpected success payload is returned.
  }

  return response;
}
