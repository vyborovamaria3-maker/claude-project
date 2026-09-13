import { NextRequest, NextResponse } from "next/server";

const DEFAULT_BACKEND_URL = "http://localhost:8000";

function getBackendBaseUrl() {
  return process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL;
}

async function proxyHandler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const resolvedParams = await params;
    const pathSegments = resolvedParams.path || [];
    const backendPath = `/api/v1/admin/twitter-registry/${pathSegments.join("/")}`;
    const url = new URL(req.url);
    const searchString = url.search;

    const authHeader = req.headers.get("authorization") || "";
    const cookieHeader = req.headers.get("cookie") || "";

    const headers: Record<string, string> = {};
    if (authHeader) headers["Authorization"] = authHeader;
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    let body: string | undefined = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await req.text();
        headers["Content-Type"] = req.headers.get("content-type") || "application/json";
      } catch {
        // no body
      }
    }

    const targetUrl = `${getBackendBaseUrl()}${backendPath}${searchString}`;
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      cache: "no-store",
    });

    const contentType = response.headers.get("content-type") || "application/json";
    const text = await response.text();

    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (err) {
    console.error("[TwitterRegistryProxy] Error proxying request:", err);
    return NextResponse.json(
      { detail: "Twitter Registry backend service unavailable" },
      { status: 503 }
    );
  }
}

export { proxyHandler as GET, proxyHandler as POST, proxyHandler as PUT, proxyHandler as PATCH, proxyHandler as DELETE };
