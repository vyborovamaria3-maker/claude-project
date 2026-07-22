import { proxyJsonRequest } from "@/lib/authProxy";

export async function POST(request: Request) {
  return proxyJsonRequest(request, "/api/v1/auth/phantom/verify");
}
