// data-tag: api.trade.dev-stream
// GET /api/trade/dev-stream?creator=... → NDJSON stream with incremental progress
// Events: {type:"progress", loaded, total, partialTokens}, {type:"complete", ...analysis}

import { NextRequest } from "next/server";
import { getCreatorForMint } from "@/lib/trade/dev";
import { getDevTag, getCache } from "@/lib/trade/db";
import { HELIUS_API_KEY, heliusFetch, SOL_MINT } from "@/lib/trade/dev-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface TxItem {
  signature: string;
  source: string;
  type: string;
  timestamp: number;
  tokenTransfers?: Array<{ mint: string; fromUserAccount: string; toUserAccount: string; tokenAmount: number }>;
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint")?.trim();
  let creator = req.nextUrl.searchParams.get("creator")?.trim() || null;
  const skipCache = req.nextUrl.searchParams.get("refresh") === "1";
  const quick = req.nextUrl.searchParams.get("quick") === "1"; // return after first batch

  if (!mint && !creator) {
    return new Response(
      JSON.stringify({ error: "mint or creator required" }) + "\n",
      { status: 400, headers: { "Content-Type": "application/x-ndjson" } }
    );
  }

  if (mint && !ADDR_RE.test(mint)) {
    return new Response(JSON.stringify({ error: "invalid mint" }) + "\n", {
      status: 400,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }

  if (!creator && mint) {
    creator = await getCreatorForMint(mint);
    if (!creator) {
      return new Response(
        JSON.stringify({ type: "error", message: "Creator not found" }) + "\n",
        { headers: { "Content-Type": "application/x-ndjson" } }
      );
    }
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      // Check cache first
      if (!skipCache) {
        const cached = getCache<{ totalTokensCreated: number; tokens: unknown[] }>("dev_tokens_cache", `v2:${creator}`);
        if (cached) {
          send({ type: "complete", fromCache: true, ...cached });
          controller.close();
          return;
        }
      }

      // Stream progress as we fetch
      const seen = new Set<string>();
      const tokens: Array<{
        mint: string;
        symbol: string;
        name: string;
        createdAt: number | null;
        marketCapUsd: null;
        athUsd: null;
        isMigrated: false;
        reached300k: false;
      }> = [];

      const BATCH_SIZE = 5;
      const MAX_BATCHES = 10;
      let before: string | undefined;

      const fetchPage = async (before?: string): Promise<TxItem[]> => {
        let path = `/v0/addresses/${creator}/transactions?limit=100`;
        if (before) path += `&before=${before}`;
        try {
          return await heliusFetch<TxItem[]>(path);
        } catch {
          return [];
        }
      };

      try {
        for (let batch = 0; batch < MAX_BATCHES; batch++) {
          const first = await fetchPage(before);
          if (!first || first.length === 0) break;

          const parallel: Promise<TxItem[]>[] = [];
          let cursor = first[first.length - 1]?.signature;
          for (let i = 1; i < BATCH_SIZE && cursor; i++) {
            parallel.push(fetchPage(cursor));
          }

          const rest = await Promise.all(parallel);
          const allPages = [first, ...rest];

          for (const page of allPages) {
            if (!page || page.length === 0) continue;
            for (const tx of page) {
              if (tx.source !== "PUMP_FUN") continue;
              for (const tt of tx.tokenTransfers ?? []) {
                if (tt.mint === SOL_MINT || seen.has(tt.mint)) continue;
                seen.add(tt.mint);
                tokens.push({
                  mint: tt.mint,
                  symbol: "",
                  name: "",
                  createdAt: tx.timestamp,
                  marketCapUsd: null,
                  athUsd: null,
                  isMigrated: false,
                  reached300k: false,
                });
              }
            }
          }

          // Send progress update
          const isLast = allPages[allPages.length - 1]?.length ?? 0 < 100;
          const estimatedTotal = isLast ? tokens.length : Math.min(tokens.length * 2, 5000);
          
          send({
            type: "progress",
            loaded: tokens.length,
            total: estimatedTotal,
            batch: batch + 1,
            partialTokens: quick ? tokens.slice(0, 100) : undefined,
          });

          // Quick mode: return after first batch
          if (quick && batch === 0) {
            break;
          }

          const lastPage = allPages[allPages.length - 1];
          if (!lastPage || lastPage.length < 100) break;
          before = lastPage[lastPage.length - 1]?.signature;
          if (!before) break;
        }

        // Send complete
        const tag = getDevTag(creator!);
        send({
          type: "complete",
          address: creator,
          totalTokensCreated: tokens.length,
          tokens,
          userTag: tag?.tag ?? null,
          userNote: tag?.note ?? null,
        });

        controller.close();
        closed = true;
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
        controller.close();
        closed = true;
      }
    },

    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
