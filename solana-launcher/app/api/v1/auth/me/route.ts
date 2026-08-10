import { proxyJsonRequest } from "@/lib/authProxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxyJsonRequest(request, "/api/v1/auth/me");
}
