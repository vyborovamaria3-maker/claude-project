import { NextRequest, NextResponse } from 'next/server';
import { getBot } from '../../../../telegram-bot/index';
import { validateUpdateStructure, checkWebhookRateLimit } from '../../../../lib/telegram/webhook-validator';
import type { Update } from 'telegraf/types';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

export async function POST(req: NextRequest) {
  try {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const receivedSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (process.env.NODE_ENV === 'production' && !expectedSecret) {
      console.error('[Telegram Webhook] TELEGRAM_WEBHOOK_SECRET is not configured');
      return NextResponse.json(
        { ok: false, error: 'Webhook is not configured' },
        { status: 503 }
      );
    }
    if (!expectedSecret || receivedSecret !== expectedSecret) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Validate Content-Type
    const contentType = req.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return NextResponse.json(
        { ok: false, error: 'Invalid Content-Type' },
        { status: 415 }
      );
    }

    // Read and parse body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    // Validate update structure
    const validation = validateUpdateStructure(body);
    if (!validation.valid) {
      console.warn(`[Telegram Webhook] Invalid update: ${validation.error}`);
      return NextResponse.json(
        { ok: false, error: 'Invalid update format' },
        { status: 400 }
      );
    }

    const update = body as { update_id: number; message?: { chat?: { id?: number }; from?: { id?: number } } };
    
    // Check rate limit per chat
    const chatId = update.message?.chat?.id || update.message?.from?.id;
    if (chatId && !checkWebhookRateLimit(chatId, 30, 60)) {
      console.warn(`[Telegram Webhook] Rate limit exceeded for chat ${chatId}`);
      return NextResponse.json(
        { ok: false, error: 'Rate limit exceeded' },
        { status: 429 }
      );
    }

    // Process the update with Telegraf
    await getBot().handleUpdate(body as Update);
    
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[Telegram Webhook] Error:', error);
    // Don't expose internal error details
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  // Health checks always authenticate; Host is client-controlled through the proxy.
  const secretToken = req.headers.get('x-webhook-secret');
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret || secretToken !== expectedSecret) {
    return NextResponse.json(
      { status: 'error', message: 'Unauthorized' },
      { status: 401 }
    );
  }
  
  return NextResponse.json({ status: 'ok', message: 'Telegram webhook endpoint is running' });
}
