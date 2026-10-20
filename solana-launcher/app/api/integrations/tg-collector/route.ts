import { NextRequest, NextResponse } from "next/server";
import { createConnection } from "node:net";
import { Pool } from "pg";
import { guardTgCollector } from "@/lib/tgCollectorAccess";
import { deleteTgProxy, enableTgProxy, readTgProxy, writeTgProxy } from "@/lib/tgCollectorProxyStore";

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

function proxyType(input: unknown): "socks5" | "socks4" | "mtproxy" {
  if (input === "socks5" || input === "socks4" || input === "mtproxy") return input;
  throw new ApiError("Выберите тип прокси: SOCKS5, SOCKS4 или MTProto");
}

function boundedString(input: unknown, label: string, max = 256, trim = true): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "string" || input.length > max || /[\r\n]/.test(input)) {
    throw new ApiError(`Некорректное поле: ${label}`);
  }
  return trim ? input.trim() : input;
}

async function testProxyEndpoint(host: string, port: number): Promise<number> {
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port, timeout: 4000 });
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
    socket.once("timeout", () => finish(new Error("Прокси не ответил за 4 секунды")));
  });
  return Date.now() - started;
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
    if (new URL(request.url).searchParams.get("mode") === "memecoin") {
      const [tokenStats, tokens, channels, unresolvedTickers, signals] = await Promise.all([
        p.query(`SELECT
          (SELECT count(*)::integer FROM tg_tokens WHERE chain_id='solana-mainnet'
            AND metadata_status IN ('partial','verified') AND decimals IS NOT NULL) AS tokens_total,
          (SELECT count(*)::integer FROM tg_messages
            WHERE deleted_at IS NULL AND analysis_version < 4) AS analysis_backfill_remaining,
          (SELECT count(*)::integer FROM tg_token_candidates WHERE chain_id='solana-mainnet'
            AND candidate_type='address' AND resolution_status='unresolved') AS unresolved_addresses,
          (SELECT count(*)::integer FROM tg_ticker_mentions tm
            JOIN tg_messages msg USING(source_id,message_id)
            WHERE tm.message_date>=now()-interval '24 hours' AND msg.deleted_at IS NULL
              AND tm.analysis_version=CASE WHEN msg.analysis_version>=4 THEN 4 ELSE 3 END) AS ticker_mentions_24h,
          (SELECT count(DISTINCT (tm.chain_id,tm.mint))::integer FROM tg_token_mentions tm
            JOIN tg_messages msg USING(source_id,message_id)
            WHERE tm.analysis_version=CASE WHEN msg.analysis_version>=4 THEN 4 ELSE 3 END
              AND tm.orphaned=FALSE AND msg.deleted_at IS NULL
              AND tm.message_date>=now()-interval '24 hours') AS confirmed_tokens_24h,
          (SELECT count(*)::integer FROM tg_signals WHERE detected_at>=now()-interval '24 hours'
            AND status<>'dismissed') AS signals_24h,
          (SELECT count(*)::integer FROM tg_token_market_snapshots
            WHERE observed_at>=now()-interval '24 hours' AND data_quality IN ('observed','partial')) AS market_snapshots_24h`),
        p.query(`
          SELECT t.chain_id,t.mint,t.symbol,t.name,t.first_seen_at,
            COALESCE(m.mentions_7d,0)::integer AS mentions_7d,
            COALESCE(m.sources_7d,0)::integer AS sources_7d,
            v.velocity::float8 AS velocity_5m,
            market.price_usd::text AS price_usd,
            market.liquidity_usd::text AS liquidity_usd,
            market.volume_1h::text AS volume_1h,
            market.market_cap_estimate::text AS market_cap_estimate,
            market.observed_at AS market_observed_at,
            fm.message_date AS first_mention_at,fs.identifier AS first_mention_channel,
            COALESCE(narrative.names,'{}'::text[]) AS narratives
          FROM tg_tokens t
          LEFT JOIN LATERAL (
            SELECT count(*)::integer AS mentions_7d,count(DISTINCT tm.source_id)::integer AS sources_7d
            FROM tg_token_mentions tm JOIN tg_messages msg USING(source_id,message_id)
            WHERE tm.chain_id=t.chain_id AND tm.mint=t.mint
              AND tm.analysis_version=CASE WHEN msg.analysis_version>=4 THEN 4 ELSE 3 END
              AND tm.orphaned=FALSE AND msg.deleted_at IS NULL AND tm.message_date>=now()-interval '7 days'
          ) m ON TRUE
          LEFT JOIN LATERAL (
            SELECT velocity FROM tg_token_velocity v0 WHERE v0.chain_id=t.chain_id AND v0.mint=t.mint
              AND v0.window_name='5m' ORDER BY v0.computed_at DESC LIMIT 1
          ) v ON TRUE
          LEFT JOIN LATERAL (
            SELECT price_usd,liquidity_usd,volume_1h,market_cap_estimate,observed_at
            FROM tg_token_market_snapshots snap WHERE snap.chain_id=t.chain_id AND snap.mint=t.mint
              AND snap.provider='dexscreener' ORDER BY snap.observed_at DESC LIMIT 1
          ) market ON TRUE
          LEFT JOIN tg_token_first_mentions fm ON fm.chain_id=t.chain_id AND fm.mint=t.mint
          LEFT JOIN tg_sources fs ON fs.id=fm.source_id
          LEFT JOIN LATERAL (
            SELECT array_agg(n.narrative_name ORDER BY n.narrative_name) AS names
            FROM tg_token_narratives tn JOIN tg_narratives n ON n.id=tn.narrative_id
            WHERE tn.chain_id=t.chain_id AND tn.mint=t.mint AND tn.model_version='keyword-v1'
          ) narrative ON TRUE
          WHERE t.chain_id='solana-mainnet'
            AND t.metadata_status IN ('partial','verified') AND t.decimals IS NOT NULL
          ORDER BY COALESCE(m.mentions_7d,0) DESC,v.velocity DESC NULLS LAST,t.first_seen_at DESC LIMIT 30`),
        p.query(`
          SELECT s.id::text AS source_id,s.identifier,score.discovery_score::float8,
            score.outcome_score::float8,score.originality_score::float8,score.risk_score::float8,
            score.composite_score::float8,score.sample_size,score.confidence_lower::float8,
            score.confidence_upper::float8,score.computed_at,score.features
          FROM tg_sources s JOIN LATERAL (
            SELECT * FROM tg_channel_scores cs WHERE cs.source_id=s.id
            ORDER BY cs.computed_at DESC LIMIT 1
          ) score ON TRUE
          ORDER BY score.composite_score DESC NULLS LAST,score.discovery_score DESC NULLS LAST LIMIT 20`),
        p.query(`
          SELECT ticker,evidence_count,last_seen_at FROM tg_ticker_registry
          WHERE mint IS NULL AND resolution_status='unresolved'
          ORDER BY evidence_count DESC,last_seen_at DESC LIMIT 20`),
        p.query(`
          SELECT sig.id::text,sig.signal_type,sig.chain_id,sig.mint,sig.confidence::float8,
            sig.detected_at,sig.model_version,sig.status,sig.features,src.identifier AS source_identifier
          FROM tg_signals sig LEFT JOIN tg_sources src ON src.id=sig.source_id
          WHERE sig.status<>'dismissed' ORDER BY sig.detected_at DESC LIMIT 20`)
      ]);
      return NextResponse.json({
        tokenStats: tokenStats.rows[0],
        tokens: tokens.rows,
        channels: channels.rows,
        unresolvedTickers: unresolvedTickers.rows,
        signals: signals.rows,
      }, { headers: noStore });
    }
    const params = request.nextUrl.searchParams;
    const selected = params.has("source") ? sourceId(params.get("source")) : null;
    const search = (params.get("q") || "").trim();
    if (search.length > 120) throw new ApiError("Поисковый запрос слишком длинный");
    const page = Number(params.get("page") || 0);
    if (!Number.isInteger(page) || page < 0 || page > 100) throw new ApiError("Недопустимая страница");

    const [sources, stats, runtimeState, proxy, messages] = await Promise.all([
      p.query(`SELECT s.id::text, s.identifier, s.current_username, s.peer_id, s.title, s.enabled,
        s.history_partial,s.full_history,s.history_complete,s.history_low_message_id::text, s.last_message_id::text, s.last_success_at,
        COALESCE(mc.message_count,0)::int AS message_count,
        (SELECT count(*)::int FROM tg_messages legacy
          WHERE legacy.source_id=s.id AND legacy.deleted_at IS NULL
            AND legacy.entities_observed_at IS NULL) AS entities_unverified,
        j.state, j.run_at, j.attempts, j.scanned_count, j.last_error,
        (SELECT parent.identifier FROM tg_source_discussions ds JOIN tg_sources parent ON parent.id=ds.channel_source_id WHERE ds.discussion_source_id=s.id LIMIT 1) AS discussion_for,
        (SELECT status FROM tg_source_discussions ds WHERE ds.channel_source_id=s.id) AS discussion_status
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
        collection_enabled, messages_total, messages_per_day, links_total, links_active_total, links_per_day, jobs_pending, jobs_failed,
        flood_wait_active, metrics_updated_at, worker_version, last_error_code,
        heartbeat_at > now() - interval '30 seconds' AS worker_online
        FROM tg_runtime WHERE id=1`),
      readTgProxy(p),
      p.query(`SELECT m.source_id::text, COALESCE(s.current_username,s.identifier) AS identifier, m.message_id::text,
        m.sender_id, m.posted_at, m.text, m.views, m.forwards, m.replies,m.reactions,m.engagement_observed_at
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
      collectionEnabled: runtimeState.rows[0]?.collection_enabled !== false,
      workerOnline: runtimeState.rows[0]?.worker_online === true,
      proxy,
      heartbeatAt: runtimeState.rows[0]?.heartbeat_at ?? null,
      blockReason: runtimeState.rows[0]?.block_reason ?? null,
      runtimeMetrics: {
        messages_total: Number(runtimeState.rows[0]?.messages_total ?? 0),
        messages_per_day: Number(runtimeState.rows[0]?.messages_per_day ?? 0),
        links_total: Number(runtimeState.rows[0]?.links_total ?? 0),
        links_active_total: Number(runtimeState.rows[0]?.links_active_total ?? 0),
        links_per_day: Number(runtimeState.rows[0]?.links_per_day ?? 0),
        jobs_pending: Number(runtimeState.rows[0]?.jobs_pending ?? 0),
        jobs_failed: Number(runtimeState.rows[0]?.jobs_failed ?? 0),
        flood_wait_active: runtimeState.rows[0]?.flood_wait_active === true,
        metrics_updated_at: runtimeState.rows[0]?.metrics_updated_at ?? null,
        worker_version: runtimeState.rows[0]?.worker_version ?? null,
        last_error_code: runtimeState.rows[0]?.last_error_code ?? null,
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
      if (input.fullHistory !== undefined && typeof input.fullHistory !== "boolean")
        throw new ApiError("fullHistory должен быть логическим значением");
      const fullHistory = input.fullHistory === true;
      const tx = await p.connect();
      try {
        await tx.query("BEGIN");
        // Prefer a Telegram-verified current handle over its old, mutable alias.
        // A released original username may now belong to an unrelated channel.
        const existing = await tx.query<{id:string}>(`
          SELECT id::text FROM tg_sources WHERE current_username=$1
            AND peer_id IS NOT NULL FOR UPDATE`,[username]);
        if (existing.rowCount && existing.rowCount > 1)
          throw new ApiError("Неоднозначный Telegram username: требуется проверка источников",409);
        const source = existing.rowCount
          ? await tx.query<{id:string}>(`
              UPDATE tg_sources SET enabled=TRUE,
                full_history=full_history OR $2::boolean,
                history_partial=CASE WHEN history_complete THEN FALSE ELSE history_partial OR $2::boolean END
              WHERE id=$1 RETURNING id::text`,[existing.rows[0].id,fullHistory])
          : await tx.query<{id:string}>(`
              INSERT INTO tg_sources(identifier,full_history,history_partial) VALUES($1,$2,$2)
              ON CONFLICT(identifier) DO UPDATE SET enabled=TRUE,
                full_history=tg_sources.full_history OR EXCLUDED.full_history,
                history_partial=CASE WHEN tg_sources.history_complete THEN FALSE
                  ELSE tg_sources.history_partial OR EXCLUDED.full_history END
              WHERE tg_sources.current_username IS NULL OR tg_sources.current_username=$1
              RETURNING id::text`,[username,fullHistory]);
        if (!source.rowCount)
          throw new ApiError("Старый username уже закреплён за другим Telegram ID. Проверьте источник по peer_id.",409);
        await tx.query(`
          INSERT INTO tg_jobs(source_id) VALUES($1)
          ON CONFLICT (source_id) DO NOTHING`, [source.rows[0].id]);
        // Re-adding an existing source must not lose either history/fresh
        // checkpoint. Existing pending/delayed jobs keep their run_at and
        // Telegram FloodWait. Manual retry resumes a failed job in place.
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
    if (action === "history") {
      const id = sourceId(input.sourceId);
      const tx = await p.connect();
      try {
        await tx.query("BEGIN");
        const source = await tx.query<{id: string}>(`
          SELECT s.id::text AS id FROM tg_sources s
          JOIN tg_jobs j ON j.source_id=s.id
          WHERE s.id=$1 AND j.state<>'running' FOR UPDATE OF s,j`, [id]);
        if (!source.rowCount) throw new ApiError("Источник не найден или задание уже выполняется", 409);
        await tx.query(`UPDATE tg_sources SET full_history=TRUE,history_complete=FALSE,history_partial=TRUE,
          enabled=TRUE WHERE id=$1`, [id]);
        await tx.query(`UPDATE tg_jobs SET state='pending',attempts=0,
          base_message_id=NULL,high_message_id=NULL,cursor_before_id=NULL,
          scanned_count=0,locked_until=NULL,last_error=NULL,run_at=now(),updated_at=now()
          WHERE source_id=$1 AND state IN ('pending','failed')`, [id]);
        await tx.query("COMMIT");
        return NextResponse.json({ok:true}, {headers:noStore});
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally { tx.release(); }
    }

    if (action === "start" || action === "stop") {
      if (action === "start") {
        const state = await p.query<{block_reason: string | null}>("SELECT block_reason FROM tg_runtime WHERE id=1");
        if (state.rows[0]?.block_reason) throw new ApiError(`Сборщик заблокирован: ${state.rows[0].block_reason}. Сначала снимите ограничение вручную.`, 409);
        await p.query("UPDATE tg_runtime SET collection_enabled=TRUE WHERE id=1");
        // Keep each job's run_at: resetting every pending job causes a burst of Telegram requests.
      } else {
        await p.query("UPDATE tg_runtime SET collection_enabled=FALSE WHERE id=1");
      }
      return NextResponse.json({ ok: true, collectionEnabled: action === "start" }, { headers: noStore });
    }

    if (action === "proxy-save") {
      const type = proxyType(input.proxyType);
      const host = boundedString(input.host, "host", 253);
      if (!host) throw new ApiError("Укажите адрес прокси");
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError("Укажите корректный порт");
      const username = boundedString(input.username, "username");
      const password = boundedString(input.password, "password", 256, false);
      const secret = boundedString(input.secret, "secret");
      await writeTgProxy(p, { proxyType: type, host, port, username, password, secret });
      return NextResponse.json({ ok: true, proxy: await readTgProxy(p) }, { headers: noStore });
    }

    if (action === "proxy-enable" || action === "proxy-disable") {
      await enableTgProxy(p, action === "proxy-enable");
      return NextResponse.json({ ok: true, proxy: await readTgProxy(p) }, { headers: noStore });
    }

    if (action === "proxy-clear") {
      await deleteTgProxy(p);
      return NextResponse.json({ ok: true, proxy: await readTgProxy(p) }, { headers: noStore });
    }

    if (action === "proxy-test") {
      const configured = await readTgProxy(p);
      if (!configured.configured || !configured.host || !configured.port) {
        throw new ApiError("Прокси ещё не настроен", 409);
      }
      const latencyMs = await testProxyEndpoint(configured.host, configured.port);
      return NextResponse.json({ ok: true, latencyMs, message: "TCP-порт прокси доступен. Реальный Telegram handshake выполнит worker при следующем подключении." }, { headers: noStore });
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
        await p.query("UPDATE tg_jobs SET run_at=now() WHERE source_id=$1 AND state='pending'", [id]);
      }
      return NextResponse.json({ ok: true, enabled }, { headers: noStore });
    }
    if (action === "sync" || action === "retry") {
      const result = await p.query(`
        UPDATE tg_jobs SET state='pending', attempts=0, run_at=now(),
          locked_until=NULL, last_error=NULL, updated_at=now()
        WHERE source_id=$1 AND state IN ('pending','failed')
          AND EXISTS(SELECT 1 FROM tg_sources WHERE id=$1 AND enabled)
        RETURNING id`, [id]);
      if (!result.rowCount) throw new ApiError("Задание выполняется, отложено Telegram (FloodWait), источник приостановлен или не найден", 409);
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
