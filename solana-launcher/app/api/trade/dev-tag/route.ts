// data-tag: api.trade.dev_tag
// GET    /api/trade/dev-tag?address=...  → fetch tag
// POST   /api/trade/dev-tag              → upsert { address, tag, note? }
// DELETE /api/trade/dev-tag?address=...  → remove tag
import { NextRequest, NextResponse } from "next/server";
import { upsertDevTag, getDevTag, deleteDevTag, listDevTags } from "@/lib/trade/db";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address")?.trim();
  if (!address) {
    // List all tags
    return NextResponse.json({ tags: listDevTags() });
  }
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  const tag = getDevTag(address);
  return NextResponse.json({ tag });
}

export async function POST(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  let body: { address?: string; tag?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { address, tag, note } = body;
  if (!address || !tag) {
    return NextResponse.json({ error: "address and tag required" }, { status: 400 });
  }
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  if (tag.length > 64) {
    return NextResponse.json({ error: "tag too long (max 64)" }, { status: 400 });
  }
  const saved = upsertDevTag(address, tag.trim(), note?.trim());
  return NextResponse.json({ tag: saved });
}

export async function DELETE(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const address = req.nextUrl.searchParams.get("address")?.trim();
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  const removed = deleteDevTag(address);
  return NextResponse.json({ removed });
}
