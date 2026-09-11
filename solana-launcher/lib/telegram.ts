import { Telegraf } from "telegraf";

let bot: Telegraf | null = null;
let currentToken: string | null = null;

export function getBot(token?: string): Telegraf | null {
  const botToken = token || process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return null;

  if (!bot || botToken !== currentToken) {
    if (bot) {
      try { bot.stop(); } catch {}
    }
    bot = new Telegraf(botToken);
    currentToken = botToken;
  }
  return bot;
}

export async function verifyBotToken(token: string): Promise<{
  valid: boolean;
  botInfo?: { id: number; username: string; firstName: string };
  error?: string;
}> {
  // verifyBotToken tests an arbitrary token, so we can't reuse the singleton
  const testBot = new Telegraf(token);
  try {
    const info = await testBot.telegram.getMe();
    try { await testBot.stop(); } catch {}
    return {
      valid: true,
      botInfo: {
        id: info.id,
        username: info.username || "",
        firstName: info.first_name,
      },
    };
  } catch (err: unknown) {
    try { await testBot.stop(); } catch {}
    const error = err as { response?: { description?: string }; message?: string };
    return {
      valid: false,
      error: error.response?.description || error.message || "Invalid token",
    };
  }
}

export async function getChatInfo(
  token: string,
  chatId: string
): Promise<{
  success: boolean;
  chat?: {
    id: number;
    title: string;
    username?: string;
    type: string;
    memberCount?: number;
    description?: string;
  };
  error?: string;
}> {
  const botInstance = getBot(token);
  if (!botInstance) return { success: false, error: "No bot token" };
  try {
    const chat = await botInstance.telegram.getChat(chatId);
    let memberCount: number | undefined;
    try {
      memberCount = await botInstance.telegram.getChatMembersCount(chatId);
    } catch {}
    const chatData = chat as unknown as Record<string, unknown>;
    return {
      success: true,
      chat: {
        id: chat.id,
        title: (chatData.title as string) || (chatData.username as string) || "Unknown",
        username: chatData.username as string | undefined,
        type: chat.type,
        memberCount,
        description: chatData.description as string | undefined,
      },
    };
  } catch (err: unknown) {
    const error = err as { response?: { description?: string }; message?: string };
    return {
      success: false,
      error: error.response?.description || error.message || "Failed to get chat",
    };
  }
}

export async function createInviteLink(
  token: string,
  chatId: string,
  options?: { name?: string; expireDate?: number; memberLimit?: number }
): Promise<{
  success: boolean;
  link?: string;
  inviteLink?: { name?: string; inviteLink: string; expireDate?: number; memberLimit?: number };
  error?: string;
}> {
  const botInstance = getBot(token);
  if (!botInstance) return { success: false, error: "No bot token" };
  try {
    const linkResult = await botInstance.telegram.createChatInviteLink(chatId, {
      name: options?.name,
      expire_date: options?.expireDate,
      member_limit: options?.memberLimit,
    });
    return {
      success: true,
      link: linkResult.invite_link,
      inviteLink: {
        name: linkResult.name || undefined,
        inviteLink: linkResult.invite_link,
        expireDate: linkResult.expire_date,
        memberLimit: linkResult.member_limit,
      },
    };
  } catch (err: unknown) {
    const error = err as { response?: { description?: string }; message?: string };
    return {
      success: false,
      error: error.response?.description || error.message || "Failed to create invite link",
    };
  }
}

export async function getBotCommands(token: string): Promise<string[]> {
  const botInstance = getBot(token);
  if (!botInstance) return [];
  try {
    const commands = await botInstance.telegram.getMyCommands();
    return commands.map((c) => c.command);
  } catch {
    return [];
  }
}

export async function sendLocalizedMessage(
  token: string,
  chatId: string,
  message: string
): Promise<boolean> {
  const botInstance = getBot(token);
  if (!botInstance) return false;
  try {
    await botInstance.telegram.sendMessage(chatId, message);
    return true;
  } catch {
    return false;
  }
}
