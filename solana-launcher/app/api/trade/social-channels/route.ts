import { NextRequest } from "next/server";
import { fetchBackendSocial, passthroughJson } from "@/lib/trade/backend-social-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const query = new URLSearchParams();
  const limit = request.nextUrl.searchParams.get("limit");
  const offset = request.nextUrl.searchParams.get("offset");
  if (limit) query.set("limit", limit);
  if (offset) query.set("offset", offset);

  const upstream = await fetchBackendSocial(request, "/api/v1/telegram/channels", query);
  return passthroughJson(upstream);
}
