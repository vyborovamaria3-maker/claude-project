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

async function proxyJsonRequest(request: Request, backendPath: string) {
  const requestBody = await request.text();
  const contentType = request.headers.get("content-type") || "application/json";
  const baseUrls = getCandidateBackendBaseUrls();

  let lastError: unknown = null;

  for (const baseUrl of baseUrls) {
    try {
      const response = await fetch(`${baseUrl}${backendPath}`, {
        method: request.method,
        headers: {
          "Content-Type": contentType,
        },
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
