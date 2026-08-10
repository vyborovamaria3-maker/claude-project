import { NextRequest, NextResponse } from "next/server";
import {
  listMigrationTokenRows,
  listMigrationWalletRows,
  listMigrationXlsxFiles,
} from "@/lib/trade/db";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { requireProdAuth } from "@/lib/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60;

function sortDescending<T>(rows: T[], value: (row: T) => number | null | undefined) {
  return [...rows].sort((a, b) => (value(b) ?? -Infinity) - (value(a) ?? -Infinity));
}

function omitFilePath<T extends { filePath: string }>(row: T): Omit<T, "filePath"> {
  const { filePath: _filePath, ...safe } = row;
  return safe;
}

export async function GET(req: NextRequest) {
  const authError = await requireProdAuth(req);
  if (authError) return authError;

  const clientIp = getClientIp(req as unknown as Request);
  const rateLimit = checkRateLimit(clientIp, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);

  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later.", retryAfter: rateLimit.retryAfter },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimit.limit),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Reset": String(rateLimit.reset),
          "Retry-After": String(rateLimit.retryAfter || 60),
        },
      },
    );
  }

  const { searchParams } = req.nextUrl;
  const parsedLimit = Number(searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(Math.trunc(parsedLimit), 1000)) : 100;
  const filePath = searchParams.get("filePath")?.trim() || null;

  const files = listMigrationXlsxFiles(limit);
  const resolvedFilePath = filePath || files[0]?.filePath || null;

  const tokenRows = resolvedFilePath ? listMigrationTokenRows(resolvedFilePath, limit) : [];
  const walletRows = resolvedFilePath ? listMigrationWalletRows(resolvedFilePath, limit) : [];

  const walletLeaderboard = sortDescending(walletRows, (row) => row.pnl ?? null).slice(0, Math.min(limit, 50));
  const tokenByMarketCap = sortDescending(tokenRows, (row) => row.marketCapMax ?? row.currentMc ?? null).slice(0, Math.min(limit, 50));
  const tokenByBuyers = sortDescending(tokenRows, (row) => row.totalUniqueBuyers ?? null).slice(0, Math.min(limit, 50));

  return NextResponse.json({
    files: files.map(omitFilePath),
    selectedFile: files.find((row) => row.filePath === resolvedFilePath)?.fileName ?? null,
    tokenRows: tokenRows.map(omitFilePath),
    walletRows: walletRows.map(omitFilePath),
    leaderboards: {
      topWalletsByPnl: walletLeaderboard.map(omitFilePath),
      worstWalletsByPnl: walletRows.length > 0
        ? [...walletRows]
            .sort((a, b) => (a.pnl ?? Infinity) - (b.pnl ?? Infinity))
            .slice(0, Math.min(limit, 50))
            .map(omitFilePath)
        : [],
      topTokensByMarketCap: tokenByMarketCap.map(omitFilePath),
      topTokensByBuyers: tokenByBuyers.map(omitFilePath),
    },
    counts: {
      files: files.length,
      tokenRows: tokenRows.length,
      walletRows: walletRows.length,
    },
  });
}
