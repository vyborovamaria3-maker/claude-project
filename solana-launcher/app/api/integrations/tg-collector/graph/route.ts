import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

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

function deny(request: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: noStore });
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(request.nextUrl.hostname.toLowerCase())) {
    return NextResponse.json({ error: "Localhost only" }, { status: 403, headers: noStore });
  }
  return null;
}

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
function errorResponse(error: unknown) {
  console.error("TG graph API:", error);
  return NextResponse.json({ error: "Не удалось загрузить граф. Проверьте подключение PostgreSQL и миграцию 002_analytics.sql." },
    { status: 503, headers: noStore });
}

export async function GET(request: NextRequest) {
  const forbidden = deny(request);
  if (forbidden) return forbidden;
  try {
    const params = request.nextUrl.searchParams;
    const selected = sourceId(params.get("source"));
    const days = daysValue(params.get("days"));
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
          AND ($5::integer=0 OR m.posted_at>=now()-($5::integer * interval '1 day'))
        ORDER BY m.posted_at DESC NULLS LAST, l.message_id DESC LIMIT 20`,
        [selected, kind, targetKind, targetKey, days]);
      return NextResponse.json({ evidence: details.rows }, { headers: noStore });
    }

    const [sourceResult, edgeResult, metricResult] = await Promise.all([
      p.query<Source>("SELECT id::text, identifier, title, peer_id FROM tg_sources ORDER BY id LIMIT 500"),
      p.query<LinkRow>(`
        SELECT l.source_id::text, s.identifier, l.kind, l.target_kind, l.target_key,
          count(*)::integer AS strength, max(m.posted_at) AS last_seen,
          min(l.message_id)::text AS sample_message_id
        FROM tg_message_links l
        JOIN tg_sources s ON s.id=l.source_id
        JOIN tg_messages m ON m.source_id=l.source_id AND m.message_id=l.message_id
        WHERE ($1::bigint IS NULL OR l.source_id=$1)
          AND ($2::integer=0 OR m.posted_at>=now()-($2::integer * interval '1 day'))
        GROUP BY l.source_id, s.identifier, l.kind, l.target_kind, l.target_key
        ORDER BY count(*) DESC, l.source_id, l.kind, l.target_key
        LIMIT 160`, [selected, days]),
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
            count(*) FILTER (WHERE posted_at >= now()-interval '7 days') posts_7d,
            count(*) FILTER (WHERE posted_at >= now()-interval '30 days') posts_30d,
            avg(views) FILTER (WHERE posted_at >= now()-interval '30 days') avg_views
          FROM tg_messages GROUP BY source_id
        ) m ON m.source_id=s.id
        LEFT JOIN (
          SELECT source_id,
            count(DISTINCT target_key) FILTER (WHERE target_kind='handle') mentioned_handles,
            count(DISTINCT (target_kind,target_key)) FILTER (WHERE kind='address') observed_addresses,
            count(*) FILTER (WHERE kind='forward') forward_events
          FROM tg_message_links GROUP BY source_id
        ) l ON l.source_id=s.id
        WHERE ($1::bigint IS NULL OR s.id=$1)
        ORDER BY coalesce(m.posts_7d,0) DESC, s.id LIMIT 100`, [selected]),
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

    for (const link of edgeResult.rows) {
      const origin = sources.find(s => s.id === link.source_id);
      if (!origin) continue;
      const from = addSource(origin);
      const known = link.target_kind === "handle" ? byHandle.get(link.target_key)
        : link.target_kind === "channel_id" ? byPeer.get(link.target_key) : undefined;
      let to: string, label: string, kind: string;
      if (known) {
        to = addSource(known);
      } else {
        kind = link.target_kind;
        to = kind + ":" + link.target_key;
        label = kind === "handle" ? "@" + link.target_key
          : kind === "channel_id" ? "Channel #" + link.target_key
          : (kind === "solana_address" ? "SOL " : "EVM ") + link.target_key.slice(0,10) + "…";
        nodes.set(to, { id: to, label, kind });
      }
      if (from === to) continue;
      graphEdges.push({
        id: [from, to, link.kind].join("|"),
        from, to, sourceId: link.source_id,
        kind: link.kind, targetKind: link.target_kind, targetKey: link.target_key,
        strength: link.strength, lastSeen: link.last_seen,
        sampleUrl: `https://t.me/${encodeURIComponent(link.identifier)}/${link.sample_message_id}`,
      });
    }

    return NextResponse.json({
      nodes: [...nodes.values()], edges: graphEdges,
      metrics: metricResult.rows,
      sampled: edgeResult.rows.length >= 160,
      days,
      legend: {
        forward: "Telegram confirmed a channel-forward origin",
        mention: "A handle or public link appeared in message text",
        address: "A chain-format address appeared in message text; ownership/token type unverified",
      },
    }, { headers: noStore });
  } catch (error) { return errorResponse(error); }
}
