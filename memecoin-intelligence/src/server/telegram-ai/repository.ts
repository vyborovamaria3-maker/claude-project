import type pg from 'pg';
import { pool, withTransaction } from '@/server/db/pool.js';
import { extractPostFeatures } from '@/server/xanalysis/features.js';
import { TELEGRAM_PROMPT_VERSION } from './prompts.js';
import type { TelegramAiCompletion } from './qwenClient.js';
import type { TelegramAnalysisContext, TelegramMessageInput } from './schemas.js';
import { env } from '@/server/config/env.js';

type StoredRef = { id: string; sentAt: Date; ordinal: number };

async function upsertChannels(client: pg.PoolClient, messages: TelegramMessageInput[]) {
  const unique = new Map<string, TelegramMessageInput>();
  for (const message of messages) unique.set(message.channelId, message);
  const rows = [...unique.values()];
  const result = new Map<string, string>();
  if (!rows.length) return result;
  const query = await client.query<{ id: string; telegram_id: string }>(`
    INSERT INTO telegram_channels(telegram_id,username,title,last_seen_at)
    SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::timestamptz[])
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=COALESCE(EXCLUDED.username,telegram_channels.username),
      title=COALESCE(EXCLUDED.title,telegram_channels.title),
      last_seen_at=GREATEST(telegram_channels.last_seen_at,EXCLUDED.last_seen_at)
    RETURNING id,telegram_id`, [
    rows.map((message) => message.channelId),
    rows.map((message) => message.channelUsername ?? null),
    rows.map((message) => message.channelTitle ?? null),
    rows.map((message) => new Date(message.sentAt)),
  ]);
  for (const row of query.rows) result.set(row.telegram_id, row.id);
  return result;
}

async function upsertMessages(client: pg.PoolClient, messages: TelegramMessageInput[], channels: Map<string, string>): Promise<StoredRef[]> {
  const valid = messages.filter((message) => channels.has(message.channelId));
  if (!valid.length) return [];
  const query = await client.query<{ id: string; sent_at: Date; channel_id: string; message_id: string }>(`
    INSERT INTO telegram_messages(channel_id,message_id,sent_at,sender_id,text,edited_at,reply_to_message_id,views,forwards,reactions,links,raw)
    SELECT * FROM unnest($1::uuid[],$2::text[],$3::timestamptz[],$4::text[],$5::text[],$6::timestamptz[],$7::text[],$8::bigint[],$9::bigint[],$10::bigint[],$11::text[][],$12::jsonb[])
    ON CONFLICT(channel_id,message_id,sent_at) DO UPDATE SET
      sender_id=EXCLUDED.sender_id,text=EXCLUDED.text,edited_at=EXCLUDED.edited_at,
      reply_to_message_id=EXCLUDED.reply_to_message_id,views=EXCLUDED.views,forwards=EXCLUDED.forwards,
      reactions=EXCLUDED.reactions,links=EXCLUDED.links,raw=EXCLUDED.raw
    RETURNING id,sent_at,channel_id,message_id`, [
    valid.map((message) => channels.get(message.channelId)),
    valid.map((message) => message.id),
    valid.map((message) => new Date(message.sentAt)),
    valid.map((message) => message.senderId ?? null),
    valid.map((message) => message.text),
    valid.map((message) => message.editedAt ? new Date(message.editedAt) : null),
    valid.map((message) => message.replyToMessageId ?? null),
    valid.map((message) => message.views),
    valid.map((message) => message.forwards),
    valid.map((message) => message.reactions),
    valid.map((message) => message.links),
    valid.map((message) => JSON.stringify(message.raw ?? {})),
  ]);
  const order = new Map(valid.map((message, index) => [`${channels.get(message.channelId)}|${message.id}|${new Date(message.sentAt).toISOString()}`, index]));
  return query.rows.map((row) => ({ id: row.id, sentAt: new Date(row.sent_at), ordinal: order.get(`${row.channel_id}|${row.message_id}|${new Date(row.sent_at).toISOString()}`) ?? 0 })).sort((a, b) => a.ordinal - b.ordinal);
}

async function upsertFeatures(client: pg.PoolClient, messages: TelegramMessageInput[], refs: StoredRef[]) {
  if (!refs.length) return;
  const ordered = [...messages];
  const features = refs.map((ref) => extractPostFeatures(ordered[ref.ordinal]?.text ?? ''));
  await client.query(`
    INSERT INTO telegram_message_features(message_id,message_sent_at,contracts,tickers,accounts,links,normalized_text,text_fingerprint,feature_version)
    SELECT * FROM unnest($1::uuid[],$2::timestamptz[],$3::text[][],$4::text[][],$5::text[][],$6::text[][],$7::text[],$8::text[],$9::smallint[])
    ON CONFLICT(message_id,message_sent_at) DO UPDATE SET
      contracts=EXCLUDED.contracts,tickers=EXCLUDED.tickers,accounts=EXCLUDED.accounts,links=EXCLUDED.links,
      normalized_text=EXCLUDED.normalized_text,text_fingerprint=EXCLUDED.text_fingerprint,
      feature_version=EXCLUDED.feature_version,extracted_at=now()`, [
    refs.map((ref) => ref.id), refs.map((ref) => ref.sentAt), features.map((feature) => feature.contracts),
    features.map((feature) => feature.tickers), features.map((feature) => feature.mentions),
    features.map((feature) => feature.links), features.map((feature) => feature.normalizedText),
    features.map((feature) => feature.textFingerprint), refs.map(() => 1),
  ]);
}

export async function createTelegramAiRun(messages: TelegramMessageInput[], context: TelegramAnalysisContext, inputHash: string, status: 'queued' | 'running' = 'queued', ownerId: string | null = null) {
  return withTransaction(async (client) => {
    const channels = await upsertChannels(client, messages);
    const refs = await upsertMessages(client, messages, channels);
    await upsertFeatures(client, messages, refs);
    const run = await client.query<{ id: string }>(`
      INSERT INTO telegram_ai_runs(status,mode,model,prompt_version,input_hash,input_context,message_count,started_at,owner_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [
      status, env.TELEGRAM_AI_MODE, env.TELEGRAM_AI_MODEL, TELEGRAM_PROMPT_VERSION, inputHash, context,
      refs.length, status === 'running' ? new Date() : null, ownerId,
    ]);
    const runId = run.rows[0]!.id;
    if (refs.length) await client.query(`
      INSERT INTO telegram_ai_run_messages(run_id,message_id,message_sent_at,ordinal)
      SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::timestamptz[],$4::integer[])`, [
      refs.map(() => runId), refs.map((ref) => ref.id), refs.map((ref) => ref.sentAt), refs.map((ref) => ref.ordinal),
    ]);
    return runId;
  });
}

export async function markTelegramAiRunRunning(runId: string) {
  const result = await pool.query(
    `UPDATE telegram_ai_runs SET status='running',started_at=COALESCE(started_at,now()),error=NULL
     WHERE id=$1 AND status IN ('queued','running')`,
    [runId],
  );
  return result.rowCount === 1;
}

export async function loadTelegramAiRun(runId: string): Promise<{ messages: TelegramMessageInput[]; context: TelegramAnalysisContext } | null> {
  const run = await pool.query<{ input_context: TelegramAnalysisContext }>(`SELECT input_context FROM telegram_ai_runs WHERE id=$1`, [runId]);
  if (!run.rowCount) return null;
  const query = await pool.query<{
    message_id: string; telegram_id: string; username: string | null; title: string | null; sender_id: string | null;
    text: string; sent_at: Date; edited_at: Date | null; views: string; forwards: string; reactions: string;
    reply_to_message_id: string | null; links: string[]; raw: Record<string, unknown>;
  }>(`
    SELECT m.message_id,c.telegram_id,c.username,c.title,m.sender_id,m.text,m.sent_at,m.edited_at,
      m.views,m.forwards,m.reactions,m.reply_to_message_id,m.links,m.raw
    FROM telegram_ai_run_messages rm
    JOIN telegram_messages m ON m.id=rm.message_id AND m.sent_at=rm.message_sent_at
    JOIN telegram_channels c ON c.id=m.channel_id
    WHERE rm.run_id=$1 ORDER BY rm.ordinal`, [runId]);
  return {
    context: run.rows[0]!.input_context ?? {},
    messages: query.rows.map((row) => ({
      id: row.message_id, channelId: row.telegram_id, channelUsername: row.username, channelTitle: row.title,
      senderId: row.sender_id, text: row.text, sentAt: new Date(row.sent_at).toISOString(),
      editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
      views: Number(row.views), forwards: Number(row.forwards), reactions: Number(row.reactions),
      replyToMessageId: row.reply_to_message_id, links: row.links ?? [], raw: row.raw ?? {},
    })),
  };
}

export async function completeTelegramAiRun(runId: string, completion: TelegramAiCompletion) {
  await withTransaction(async (client) => {
    await client.query(`
      INSERT INTO telegram_ai_results(run_id,provider,model,prompt_version,result,latency_ms,input_tokens,output_tokens)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(run_id) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model,prompt_version=EXCLUDED.prompt_version,
        result=EXCLUDED.result,latency_ms=EXCLUDED.latency_ms,input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens`, [
      runId, completion.provider, completion.model, TELEGRAM_PROMPT_VERSION, completion.result,
      completion.latencyMs, completion.inputTokens, completion.outputTokens,
    ]);
    await client.query(
      `UPDATE telegram_ai_runs SET status='completed',completed_at=now(),error=NULL
       WHERE id=$1 AND status NOT IN ('completed','failed')`,
      [runId],
    );
  });
}

export async function failTelegramAiRun(runId: string, error: unknown) {
  await pool.query(
    `UPDATE telegram_ai_runs SET status='failed',error=$2,completed_at=now()
     WHERE id=$1 AND status NOT IN ('completed','failed')`,
    [runId, error instanceof Error ? error.message : String(error)],
  );
}

export async function getTelegramAiRun(runId: string, access?: { ownerId: string; isAdmin: boolean }) {
  const ownerFilter = access ? ` AND ($2::boolean OR r.owner_id=$3)` : '';
  const query = await pool.query(`
    SELECT r.id,r.status,r.mode,r.model,r.prompt_version,r.input_hash,r.input_context,r.message_count,
      r.error,r.created_at,r.started_at,r.completed_at,
      a.provider,a.result,a.latency_ms,a.input_tokens,a.output_tokens
     FROM telegram_ai_runs r LEFT JOIN telegram_ai_results a ON a.run_id=r.id WHERE r.id=$1${ownerFilter}`,
    access ? [runId, access.isAdmin, access.ownerId] : [runId],
  );
  return query.rows[0] ?? null;
}
