import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";
import { guardTgCollector } from "@/lib/tgCollectorAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class ApiError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const poolGlobal = globalThis as typeof globalThis & { __tgCollectorPool?: Pool };
const noStore = { "Cache-Control": "private, no-store, max-age=0" };

function pool(): Pool {
  const connectionString = process.env.TG_COLLECTOR_DATABASE_URL?.trim();
  if (!connectionString) throw new ApiError("В solana-launcher/.env.local отсутствует TG_COLLECTOR_DATABASE_URL.", 503);
  if (!poolGlobal.__tgCollectorPool) {
    poolGlobal.__tgCollectorPool = new Pool({
      connectionString, max: 4, connectionTimeoutMillis: 4000, idleTimeoutMillis: 30000,
    });
  }
  return poolGlobal.__tgCollectorPool;
}

function errorResponse(error: unknown) {
  const status = error instanceof ApiError ? error.status : 503;
  if (!(error instanceof ApiError)) console.error("TG Collector API error", error);
  return NextResponse.json({
    error: error instanceof ApiError
      ? error.message
      : "Нет доступа к базе TG Collector или миграция не выполнена. Проверьте настройки и npm run migrate.",
  }, { status, headers: noStore });
}

function publicUsername(input: unknown): string {
  if (typeof input !== "string" || input.length > 128) throw new ApiError("Укажите публичный @username канала");
  const value = input.trim().replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "").split(/[/?#]/)[0].toLowerCase();
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(value) || /^(joinchat|addlist|share|proxy|login|boost)$/.test(value)) {
    throw new ApiError("Поддерживаются публичные каналы и супергруппы: @username или t.me/username");
  }
  return value;
}

function sourceId(input: unknown): string {
  if (typeof input !== "string" || !/^[1-9][0-9]{0,17}$/.test(input)) throw new ApiError("Некорректный ID источника");
  return input;
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("Отсутствует тело запроса");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new ApiError("Слишком большой запрос", 413);
    }
    chunks.push(part.value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError("Некорректный JSON");
  }
}

export async function GET(request: NextRequest) {
  const forbidden = guardTgCollector(request);
  if (forbidden) return forbidden;
  try {
    const p = pool();
    const params = request.nextUrl.searchParams;
    const selected = params.has("source") ? sourceId(params.get("source")) : null;
    const search = (params.get("q") || "").trim();
    if (search.length > 120) throw new ApiError("Поисковый запрос слишком длинный");
    const page = Number(params.get("page") || 0);
    if (!Number.isInteger(page) || page < 0 || page > 100) throw new ApiError("Недопустимая страница");

    const [sources, stats, runtimeState, messages] = await Promise.all([
      p.query(`SELECT s.id::text, s.identifier, s.peer_id, s.title, s.enabled,
        s.history_partial, s.last_message_id::text, s.last_success_at,
        COALESCE(mc.message_count,0)::int AS message_count,
        j.state, j.run_at, j.attempts, j.scanned_count, j.last_error
        FROM tg_sources s
        LEFT JOIN tg_source_message_counters mc ON mc.source_id=s.id
        LEFT JOIN tg_jobs j ON j.source_id=s.id
        ORDER BY s.created_at DESC LIMIT 500`),
      p.query(`SELECT
          (SELECT count(*)::int FROM tg_sources) AS sources,
          (SELECT COALESCE(sum(message_count),0)::int FROM tg_source_message_counters) AS messages,
          (SELECT count(*)::int FROM tg_jobs WHERE state='running') AS running,
          (SELECT count(*)::int FROM tg_jobs WHERE state='failed') AS failed`),
      p.query(`SELECT pause_until, heartbeat_at, worker_started_at, block_reason, blocked_at,
        messages_total, messages_per_day, links_total, links_per_day, jobs_pending, jobs_failed,
        flood_wait_active, metrics_updated_at,
        heartbeat_at > now() - interval '20 seconds' AS worker_online
        FROM tg_runtime WHERE id=1`),
      p.query(`SELECT m.source_id::text, s.identifier, m.message_id::text,
        m.sender_id, m.posted_at, m.text, m.views, m.forwards, m.replies
        FROM tg_messages m JOIN tg_sources s ON s.id=m.source_id
        WHERE ($1::bigint IS NULL OR m.source_id=$1)
          AND m.deleted_at IS NULL
          AND ($2::text = '' OR m.text ILIKE '%' || $2 || '%')
        ORDER BY m.posted_at DESC NULLS LAST, m.message_id DESC
        LIMIT 40 OFFSET $3`, [selected, search, page*40]),
    ]);
    return NextResponse.json({
      configured: true,
      stats: stats.rows[0],
      pausedUntil: runtimeState.rows[0]?.pause_until ?? null,
      workerOnline: runtimeState.rows[0]?.worker_online === true,
      heartbeatAt: runtimeState.rows[0]?.heartbeat_at ?? null,
      blockReason: runtimeState.rows[0]?.block_reason ?? null,
      runtimeMetrics: {
        messages_total: Number(runtimeState.rows[0]?.messages_total ?? 0),
        messages_per_day: Number(runtimeState.rows[0]?.messages_per_day ?? 0),
        links_total: Number(runtimeState.rows[0]?.links_total ?? 0),
        links_per_day: Number(runtimeState.rows[0]?.links_per_day ?? 0),
        jobs_pending: Number(runtimeState.rows[0]?.jobs_pending ?? 0),
        jobs_failed: Number(runtimeState.rows[0]?.jobs_failed ?? 0),
        flood_wait_active: runtimeState.rows[0]?.flood_wait_active === true,
        metrics_updated_at: runtimeState.rows[0]?.metrics_updated_at ?? null,
      },
      sources: sources.rows,
      messages: messages.rows,
      page,
    }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const forbidden = guardTgCollector(request, true);
  if (forbidden) return forbidden;
  try {
    const input = await readBody(request);
    const action = input.action;
    const p = pool();
    if (action === "add") {
      const username = publicUsername(input.username);
      const tx = await p.connect();
      try {
        await tx.query("BEGIN");
        const source = await tx.query<{id: string}>(`
          INSERT INTO tg_sources(identifier) VALUES($1)
          ON CONFLICT(identifier) DO UPDATE SET enabled=TRUE
          RETURNING id::text`, [username]);
        await tx.query(`
          INSERT INTO tg_jobs(source_id) VALUES($1)
          ON CONFLICT (source_id) DO NOTHING`, [source.rows[0].id]);
        await tx.query(`UPDATE tg_jobs SET state='pending', attempts=0,
          run_at=now(), locked_until=NULL, last_error=NULL, updated_at=now()
          WHERE source_id=$1 AND state='failed'`, [source.rows[0].id]);
        await tx.query("COMMIT");
        return NextResponse.json({ ok: true, sourceId: source.rows[0].id }, { headers: noStore });
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally { tx.release(); }
    }
    const id = sourceId(input.sourceId);
    if (action === "pause" || action === "resume") {
      const enabled = action === "resume";
      const result = await p.query(
        "UPDATE tg_sources SET enabled=$2 WHERE id=$1 RETURNING id", [id, enabled]);
      if (!result.rowCount) throw new ApiError("Источник не найден", 404);
      if (enabled) {
        await p.query(`UPDATE tg_jobs SET state='pending', run_at=now(), locked_until=NULL,
          attempts=0, last_error=NULL WHERE source_id=$1 AND state='failed'`, [id]);
        await p.query("UPDATE tg_jobs SET run_at=now() WHERE source_id=$1 AND state IN ('pending','delayed')", [id]);
      }
      return NextResponse.json({ ok: true, enabled }, { headers: noStore });
    }
    if (action === "sync" || action === "retry") {
      const result = await p.query(`
        UPDATE tg_jobs SET state='pending', attempts=0, run_at=now(),
          locked_until=NULL, last_error=NULL, updated_at=now()
        WHERE source_id=$1 AND state IN ('pending','delayed','failed')
          AND EXISTS(SELECT 1 FROM tg_sources WHERE id=$1 AND enabled)
        RETURNING id`, [id]);
      if (!result.rowCount) throw new ApiError("Задание активно, источник приостановлен или не найден", 409);
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    if (action === "remove") {
      if (typeof input.confirm !== "string") throw new ApiError("Для удаления требуется подтверждение");
      const result = await p.query(`
        DELETE FROM tg_sources WHERE id=$1 AND identifier=$2
          AND NOT EXISTS (SELECT 1 FROM tg_jobs WHERE source_id=$1 AND state='running')
        RETURNING id`, [id, input.confirm.toLowerCase()]);
      if (!result.rowCount) throw new ApiError("Не удалось удалить: источник активен либо подтверждение неверное", 409);
      return NextResponse.json({ ok: true }, { headers: noStore });
    }
    throw new ApiError("Неизвестное действие");
  } catch (error) {
    return errorResponse(error);
  }
}
