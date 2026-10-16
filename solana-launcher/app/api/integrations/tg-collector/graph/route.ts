import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { guardTgCollector } from "@/lib/tgCollectorAccess";
import type { TgGraphResponse } from "@/lib/tgCollectorTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalPools = globalThis as typeof globalThis & { __tgCollectorPool?: Pool };
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
type Source = { id: string; identifier: string; title: string | null; peer_id: string | null };
type LinkRow = {
  source_id: string; identifier: string; kind: "mention" | "forward" | "address";
  target_kind: "handle" | "channel_id" | "solana_address" | "evm_address";
  target_key: string; strength: number; last_seen: string | null; sample_message_id: string;
};

function database(): Pool {
  const connectionString = process.env.TG_COLLECTOR_DATABASE_URL?.trim();
  if (!connectionString) throw Error("TG_COLLECTOR_DATABASE_URL is missing");
  if (!globalPools.__tgCollectorPool) {
    globalPools.__tgCollectorPool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 4000 });
  }
  return globalPools.__tgCollectorPool;
}
function sourceId(value: string | null): string | null {
  if (!value) return null;
  if (!/^[1-9][0-9]{0,17}$/.test(value)) throw Error("Invalid source ID");
  return value;
}
function daysValue(value: string | null): number {
  const days = Number(value ?? "90");
  if (![0, 7, 30, 90, 365].includes(days)) throw Error("Invalid lookback");
  return days;
}
function boundedInt(value: string | null, fallback: number, min: number, max: number, label: string): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw Error("Invalid " + label);
  return parsed;
}
function errorResponse(error: unknown) {
  console.error("TG graph API:", error);
  return NextResponse.json({ error: "Не удалось загрузить граф. Проверьте подключение PostgreSQL и миграцию 002_analytics.sql." },
    { status: 503, headers: noStore });
}

export async function GET(request: NextRequest) {
  const forbidden = guardTgCollector(request);
  if (forbidden) return forbidden;
  try {
    const params = request.nextUrl.searchParams;
    const selected = sourceId(params.get("source"));
    const days = daysValue(params.get("days"));
    const nodeLimit = boundedInt(params.get("nodeLimit"), 500, 50, 500, "node limit");
    const edgeLimit = boundedInt(params.get("edgeLimit"), 2000, 50, 2000, "edge limit");
    const edgeOffset = boundedInt(params.get("edgeOffset"), 0, 0, 20000, "edge offset");
    const p = database();

    if (params.get("mode") === "evidence") {
      const kind = params.get("kind");
      const targetKind = params.get("targetKind");
      const targetKey = params.get("targetKey");
      if (!selected || !["mention","forward","address"].includes(kind || "") ||
          !["handle","channel_id","solana_address","evm_address"].includes(targetKind || "") ||
          !targetKey || targetKey.length > 128) {
        return NextResponse.json({ error: "Invalid evidence selector" }, { status: 400, headers: noStore });
      }
      const details = await p.query(`
        SELECT s.identifier, l.message_id::text, m.posted_at, left(m.text,1500) AS text
        FROM tg_message_links l
        JOIN tg_messages m USING(source_id,message_id)
        JOIN tg_sources s ON s.id=l.source_id
        WHERE l.source_id=$1 AND l.kind=$2 AND l.target_kind=$3 AND l.target_key=$4
          AND m.deleted_at IS NULL
          AND ($5::integer=0 OR (m.posted_at AT TIME ZONE 'UTC')::date >= (now() AT TIME ZONE 'UTC')::date - ($5::integer - 1))
        ORDER BY m.posted_at DESC NULLS LAST, l.message_id DESC LIMIT 20`,
        [selected, kind, targetKind, targetKey, days]);
      return NextResponse.json({ evidence: details.rows }, { headers: noStore });
    }

    const [sourceResult, edgeResult, metricResult, overlapResult, addressResult] = await Promise.all([
      p.query<Source>("SELECT id::text, identifier, title, peer_id FROM tg_sources ORDER BY id"),
      p.query<LinkRow>(`
        SELECT e.source_id::text, s.identifier, e.kind, e.target_kind, e.target_key,
          sum(e.evidence_count)::integer AS strength, max(e.last_seen) AS last_seen,
          min(e.sample_message_id)::text AS sample_message_id
        FROM tg_graph_daily_edges e JOIN tg_sources s ON s.id=e.source_id
        WHERE ($1::bigint IS NULL OR e.source_id=$1)
          AND ($2::integer=0 OR e.day >= (now() AT TIME ZONE 'UTC')::date - ($2::integer - 1))
        GROUP BY e.source_id, s.identifier, e.kind, e.target_kind, e.target_key
        ORDER BY sum(e.evidence_count) DESC, e.source_id, e.kind, e.target_key
        LIMIT $3 OFFSET $4
      `, [selected, days, edgeLimit, edgeOffset]),
      p.query(`
        SELECT s.id::text AS source_id, s.identifier,
          coalesce(m.posts_7d,0)::integer AS posts_7d,
          coalesce(m.posts_30d,0)::integer AS posts_30d,
          m.avg_views::integer AS avg_views_snapshot,
          coalesce(l.mentioned_handles,0)::integer AS mentioned_handles,
          coalesce(l.observed_addresses,0)::integer AS observed_addresses,
          coalesce(l.forward_events,0)::integer AS forward_events
        FROM tg_sources s
        LEFT JOIN (
          SELECT source_id,
            sum(posts_count) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 6) posts_7d,
            sum(posts_count) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29) posts_30d,
            (sum(views_total) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29))::numeric
            / NULLIF(sum(views_count) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29),0) avg_views
          FROM tg_source_daily_metrics GROUP BY source_id
        ) m ON m.source_id=s.id
        LEFT JOIN (
          SELECT source_id,
            count(DISTINCT target_key) FILTER (WHERE target_kind='handle') mentioned_handles,
            count(DISTINCT (target_kind,target_key)) FILTER (WHERE kind='address') observed_addresses,
            coalesce(sum(evidence_count) FILTER (WHERE kind='forward'), 0) forward_events
          FROM tg_graph_daily_edges GROUP BY source_id
        ) l ON l.source_id=s.id
        WHERE ($1::bigint IS NULL OR s.id=$1)
        ORDER BY coalesce(m.posts_7d,0) DESC, s.id LIMIT 100`, [selected]),
      p.query(`
        WITH observed AS (
          SELECT DISTINCT l.source_id, l.target_kind, l.target_key
          FROM tg_graph_daily_edges l
          WHERE l.kind='address'
            AND ($2::integer=0 OR l.day >= (now() AT TIME ZONE 'UTC')::date - ($2::integer - 1))
        ),
        pairs AS (
          SELECT a.source_id AS left_id, b.source_id AS right_id,
                 count(*)::integer AS shared_addresses
          FROM observed a JOIN observed b
            ON a.target_kind=b.target_kind AND a.target_key=b.target_key
           AND a.source_id<b.source_id
          WHERE ($1::bigint IS NULL OR a.source_id=$1 OR b.source_id=$1)
          GROUP BY a.source_id,b.source_id
          ORDER BY shared_addresses DESC LIMIT 20
        )
        SELECT a.identifier AS left_channel, b.identifier AS right_channel, p.shared_addresses
        FROM pairs p
        JOIN tg_sources a ON a.id=p.left_id
        JOIN tg_sources b ON b.id=p.right_id
        ORDER BY p.shared_addresses DESC, a.identifier, b.identifier`, [selected, days]),
      p.query(`
        SELECT l.target_kind, l.target_key,
          count(DISTINCT l.source_id)::integer AS observed_in_sources,
          sum(l.evidence_count)::integer AS occurrences,
          min(l.first_seen) AS first_observed_at,
          max(l.last_seen) AS last_observed_at
        FROM tg_graph_daily_edges l
        WHERE l.kind='address'
          AND ($1::bigint IS NULL OR l.source_id=$1)
          AND ($2::integer=0 OR l.day >= (now() AT TIME ZONE 'UTC')::date - ($2::integer - 1))
        GROUP BY l.target_kind,l.target_key
        ORDER BY observed_in_sources DESC, occurrences DESC, l.target_key LIMIT 20`,
        [selected, days]),
    ]);

    const sources = sourceResult.rows;
    const byHandle = new Map(sources.map(s => [s.identifier.toLowerCase(), s]));
    const byPeer = new Map(sources.filter(s => s.peer_id).map(s => [s.peer_id!, s]));
    const nodes = new Map<string, { id: string; label: string; kind: string }>();
    const graphEdges: Array<{
      id: string; from: string; to: string; sourceId: string;
      kind: string; targetKind: string; targetKey: string; strength: number;
      sampleUrl: string; lastSeen: string | null;
    }> = [];
    const addSource = (s: Source) => {
      const id = "source:" + s.id;
      nodes.set(id, { id, label: s.title || "@" + s.identifier, kind: "source" });
      return id;
    };

    const sourceById = new Map(sources.map(s => [s.id, s]));
    let nodeTruncated = false;
    for (const link of edgeResult.rows) {
      const origin = sourceById.get(link.source_id) ?? {
        id: link.source_id, identifier: link.identifier, title: null, peer_id: null,
      };
      const from = "source:" + origin.id;
      const known = link.target_kind === "handle" ? byHandle.get(link.target_key)
        : link.target_kind === "channel_id" ? byPeer.get(link.target_key) : undefined;
      if (known && known.id === origin.id) continue;
      const to = known ? "source:" + known.id : link.target_kind + ":" + link.target_key;
      const neededNodes = (nodes.has(from) ? 0 : 1) + (nodes.has(to) ? 0 : 1);
      if (nodes.size + neededNodes > nodeLimit) {
        nodeTruncated = true;
        continue;
      }
      addSource(origin);
      if (!known) {
        const kind = link.target_kind;
        const label = kind === "handle" ? "@" + link.target_key
          : kind === "channel_id" ? "Channel #" + link.target_key
          : (kind === "solana_address" ? "SOL " : "EVM ") + link.target_key.slice(0,10) + "…";
        nodes.set(to, { id: to, label, kind });
      } else {
        addSource(known);
      }
      graphEdges.push({
        id: [from, to, link.kind].join("|"),
        from, to, sourceId: link.source_id,
        kind: link.kind, targetKind: link.target_kind, targetKey: link.target_key,
        strength: link.strength, lastSeen: link.last_seen,
        sampleUrl: `https://t.me/${encodeURIComponent(link.identifier)}/${link.sample_message_id}`,
      });
    }

    const response: TgGraphResponse = {
      nodes: [...nodes.values()], edges: graphEdges,
      metrics: metricResult.rows,
      sharedAddresses: overlapResult.rows,
      observedAddresses: addressResult.rows,
      sampled: edgeResult.rows.length >= edgeLimit,
      truncated: nodeTruncated || edgeResult.rows.length >= edgeLimit,
      nodeLimit, edgeLimit, edgeOffset,
      nextEdgeOffset: edgeResult.rows.length >= edgeLimit ? edgeOffset + edgeLimit : null,
      days,
    };
    return NextResponse.json(response, { headers: noStore });
  } catch (error) { return errorResponse(error); }
}
