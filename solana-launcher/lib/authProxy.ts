const DEFAULT_BACKEND_URL = "http://localhost:8000";
let resolvedBackendBaseUrl: string | null = null;

function getBackendBaseUrl() {
  return process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL;
}

function getCandidateBackendBaseUrls() {
  return Array.from(
    new Set([
      resolvedBackendBaseUrl,
      getBackendBaseUrl(),
      "http://127.0.0.1:8000",
      "http://localhost:8000",
    ].filter((value): value is string => Boolean(value)))
  );
}

function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const candidate =
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "";
  if (!candidate || candidate.length > 64 || /[\r\n]/.test(candidate)) return null;
  return candidate;
}

async function proxyJsonRequest(request: Request, backendPath: string) {
  const requestBody = await request.text();
  const contentType = request.headers.get("content-type") || "application/json";
  const baseUrls = getCandidateBackendBaseUrls();

  const proxiedHeaders: Record<string, string> = {
    "Content-Type": contentType,
  };
  const authorization = request.headers.get("authorization");
  if (authorization) proxiedHeaders.Authorization = authorization;

  const userAgent = request.headers.get("user-agent");
  if (userAgent) proxiedHeaders["User-Agent"] = userAgent.slice(0, 512);

  const clientIp = getClientIp(request);
  const backendApiKey = process.env.BACKEND_API_KEY?.trim();
  if (clientIp && backendApiKey) {
    proxiedHeaders["X-Potapoff-Client-IP"] = clientIp;
    proxiedHeaders["X-Potapoff-Proxy-Key"] = backendApiKey;
  }

  let lastError: unknown = null;

  for (const baseUrl of baseUrls) {
    try {
      const response = await fetch(`${baseUrl}${backendPath}`, {
        method: request.method,
        headers: proxiedHeaders,
        body: requestBody,
        cache: "no-store",
      });
      resolvedBackendBaseUrl = baseUrl;

      const responseContentType = response.headers.get("content-type") || "application/json";
      const text = await response.text();

      return new Response(text, {
        status: response.status,
        headers: {
          "Content-Type": responseContentType,
        },
      });
    } catch (error) {
      lastError = error;
    }
  }

  console.error(`[authProxy] Failed to reach backend for ${backendPath}`, lastError);
  return Response.json(
    { detail: "Authentication service unavailable. Check that the backend is running on port 8000." },
    { status: 503 }
  );
}

export { getBackendBaseUrl, proxyJsonRequest };
