import { NextResponse } from "next/server";
import { proxyJsonRequest } from "@/lib/authProxy";

export const dynamic = "force-dynamic";

const ACCESS_COOKIE = "potapoff_access_token";

export async function GET(request: Request) {
  const backendResponse = await proxyJsonRequest(request, "/api/v1/auth/me");
  const text = await backendResponse.text();
  const response = new NextResponse(text, {
    status: backendResponse.status,
    headers: {
      "Content-Type": backendResponse.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store",
    },
  });
  if (backendResponse.status === 401 || backendResponse.status === 403) {
    response.cookies.delete(ACCESS_COOKIE);
  }
  return response;
}
