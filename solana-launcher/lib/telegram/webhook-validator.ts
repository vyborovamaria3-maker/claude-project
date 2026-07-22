/**
 * Telegram Webhook Validation Utilities
 * Validates that webhook requests actually come from Telegram
 */

import crypto from "crypto";

/**
 * Validate Telegram webhook request using bot token hash
 * This is a simple check - for production, also verify the secret token
 */
export function validateTelegramWebhook(
  body: string,
  signature: string | null,
  botToken: string
): boolean {
  if (!signature) {
    // If no signature header, we can't verify (should reject in production)
    return false;
  }

  // Create HMAC-SHA256 of the body using bot token's secret
  const secret = crypto.createHmac("sha256", botToken).digest();
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expectedSignature, "hex")
  );
}

/**
 * Validate webhook update structure
 */
export function validateUpdateStructure(body: unknown): {
  valid: boolean;
  error?: string;
} {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Invalid update structure" };
  }

  const update = body as Record<string, unknown>;

  // Check for required fields
  if (typeof update.update_id !== "number") {
    return { valid: false, error: "Missing or invalid update_id" };
  }

  // Validate update_id is reasonable (positive integer, not too large)
  if (update.update_id < 0 || update.update_id > Number.MAX_SAFE_INTEGER) {
    return { valid: false, error: "Invalid update_id range" };
  }

  // Should have at least one update type
  const validTypes = [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "inline_query",
    "chosen_inline_result",
    "callback_query",
    "shipping_query",
    "pre_checkout_query",
    "poll",
    "poll_answer",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
  ];

  const hasValidType = validTypes.some((type) => type in update);
  if (!hasValidType) {
    return { valid: false, error: "No valid update type found" };
  }

  // Validate nested message objects if present
  if (update.message && typeof update.message === "object") {
    const msg = update.message as Record<string, unknown>;
    if (typeof msg.message_id !== "number") {
      return { valid: false, error: "Invalid message structure" };
    }
    if (typeof msg.date !== "number") {
      return { valid: false, error: "Invalid message date" };
    }
    // Unix timestamp should be reasonable (between 2020 and 2030)
    const now = Math.floor(Date.now() / 1000);
    if (msg.date < 1577836800 || msg.date > now + 86400) {
      return { valid: false, error: "Message date out of valid range" };
    }
  }

  return { valid: true };
}

/**
 * Rate limiting for webhook requests per chat
 */
const webhookRateLimits = new Map<string, { count: number; resetTime: number }>();

export function checkWebhookRateLimit(
  chatId: string | number,
  maxRequests: number = 30,
  windowSeconds: number = 60
): boolean {
  const key = String(chatId);
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  const entry = webhookRateLimits.get(key);

  if (!entry || entry.resetTime < now) {
    // New window
    webhookRateLimits.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
}
