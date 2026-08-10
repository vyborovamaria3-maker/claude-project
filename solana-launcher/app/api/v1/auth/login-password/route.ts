import { NextResponse } from "next/server";
import { proxyJsonRequest } from "@/lib/authProxy";

const ACCESS_COOKIE = "potapoff_access_token";

export async function POST(request: Request) {
  const backendResponse = await proxyJsonRequest(request, "/api/v1/auth/login-password");
  const text = await backendResponse.text();
  const contentType = backendResponse.headers.get("content-type") || "application/json";
  const response = new NextResponse(text, {
    status: backendResponse.status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });

  if (!backendResponse.ok) {
    if (backendResponse.status === 401 || backendResponse.status === 403) {
      response.cookies.delete(ACCESS_COOKIE);
    }
    return response;
  }

  let data: { access_token?: unknown; expires_in?: unknown } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ detail: "Authentication service returned invalid JSON" }, { status: 502 });
  }

  if (typeof data.access_token !== "string" || !data.access_token) {
    return NextResponse.json({ detail: "Authentication service did not return a token" }, { status: 502 });
  }

  const expiresIn = Number(data.expires_in);
  const maxAge = Number.isFinite(expiresIn) && expiresIn > 0
    ? Math.max(1, Math.min(Math.floor(expiresIn), 30 * 24 * 60 * 60))
    : 60 * 60;

  response.cookies.set({
    name: ACCESS_COOKIE,
    value: data.access_token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  return response;
}
