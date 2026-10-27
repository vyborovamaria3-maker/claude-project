import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { GET as getTwitterStats } from "../dev-twitter/route";
import { fetchBackendSocial } from "@/lib/trade/backend-social-proxy";
import { buildSocialSourceParams } from "@/lib/trade/social-intelligence-api";
import {
  FOMO_CAPTURE_OPTIONS,
  FOMO_SCORE_VERSION,
  buildFomoSnapshotRecord,
  fomoCaptureBucketStart,
  isSafeCaptureFailureCode,
} from "@/lib/trade/fomo-snapshot";
import {
  beginFomoCaptureAttempt,
  finishFomoCaptureAttempt,
  hasFomoSnapshotInBucket,
  insertFomoSnapshot,
  type SourceAttemptStatus,
} from "@/lib/trade/fomo-snapshot-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

function validMint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "cross_origin_request_rejected" }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "application_json_required" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }
  const mint = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { mint?: unknown }).mint
    : null;
  if (!validMint(mint)) {
    return NextResponse.json({ error: "invalid_solana_mint" }, { status: 400 });
  }

  const requestedAt = Date.now();
  const runId = beginFomoCaptureAttempt(mint, requestedAt);
  let xStatus: SourceAttemptStatus = "unknown";
  let tgStatus: SourceAttemptStatus = "unknown";

  try {
    const canonicalTokenId = "solana:" + mint;
    const bucketStartAt = fomoCaptureBucketStart(requestedAt);
    if (hasFomoSnapshotInBucket(canonicalTokenId, FOMO_SCORE_VERSION, bucketStartAt)) {
      finishFomoCaptureAttempt({
        runId,
        status: "duplicate",
        xStatus,
        tgStatus,
        completedAt: Date.now(),
      });
      return NextResponse.json({ status: "duplicate", captured: false });
    }

    const params = buildSocialSourceParams(mint, FOMO_CAPTURE_OPTIONS);
    const xUrl = new URL("/api/trade/dev-twitter", request.nextUrl.origin);
    for (const [key, value] of params.x) xUrl.searchParams.append(key, value);
    const xRequest = new NextRequest(xUrl, { method: "GET", headers: { Accept: "application/json" } });

    const [xResponse, tgResponse] = await Promise.all([
      getTwitterStats(xRequest),
      fetchBackendSocial(request, `/api/v1/social/token/${{encodeURIComponent(mint)}`, params.tg),
    ]);
    xStatus = xResponse.ok ? "available" : "unavailable";
    tgStatus = tgResponse.ok ? "available" : "unavailable";

    if (!xResponse.ok || !tgResponse.ok) {
      finishFomoCaptureAttempt({
        runId,
        status: "failed",
        xStatus,
        tgStatus,
        failureCode: !xResponse.ok ? "x_source_unavailable" : "telegram_source_unavailable",
        completedAt: Date.now(),
      });
      return NextResponse.json({ error: "fomo_source_unavailable" }, { status: 503 });
    }

    const [x, tg] = await Promise.all([responseJson(xResponse), responseJson(tgResponse)]);
    const signalAt = Date.now();
    const record = buildFomoSnapshotRecord({ mint, x, tg, signalAt });
    const inserted = insertFomoSnapshot(record);
    finishFomoCaptureAttempt({
      runId,
      status: inserted.inserted ? "captured" : "duplicate",
      xStatus,
      tgStatus,
      snapshotId: inserted.snapshotId,
      completedAt: Date.now(),
    });
    return NextResponse.json({
      status: inserted.inserted ? "captured" : "duplicate",
      captured: inserted.inserted,
      snapshotId: inserted.snapshotId,
      scoreVersion: record.scoreVersion,
      signalAt: new Date(record.signalAt).toISOString(),
      sourceCoverage: { x: record.xCoverage, telegram: record.tgCoverage },
    }, { status: inserted.inserted ? 201 : 200 });
  } catch (error) {
    finishFomoCaptureAttempt({
      runId,
      status: "failed",
      xStatus,
      tgStatus,
      failureCode: isSafeCaptureFailureCode(error),
      completedAt: Date.now(),
    });
    return NextResponse.json({ error: "fomo_capture_failed" }, { status: 503 });
  }
}
