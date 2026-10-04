import { RawMember } from "./tginvite-filter";

const SOLANA_CANDIDATE_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const EVM_CONTRACT_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const SOLANA_CONTEXT_RE = /\b(?:solana|\$sol|raydium|jupiter|orca|phantom|solscan|spl\s*token|pump\.fun|pumpfun|dexscreener|birdeye|gmgn|photon|bullx)\b/i;
const MEME_CONTEXT_RE = /\b(?:memecoin|meme\s*coin|meme\s*token|bonk|dogwifhat|\$wif|pepe|degen|ape|cto|moonshot|shitcoin)\b/i;
const CALL_CONTEXT_RE = /\b(?:call|calling|caller|gem|alpha|entry|buy|send(?:ing)?|ape|aping|moon|100x|50x|20x|10x|launch|market\s*cap|mcap|ca|contract)\b/i;
const PUMPFUN_RE = /(?:pump\.fun|pumpfun)/i;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

let client: Record<string, unknown> | null = null;
let pendingAuth:
  | {
      apiId: number;
      apiHash: string;
      phoneNumber: string;
      phoneCodeHash: string;
      isCodeViaApp: boolean;
      client: Record<string, unknown>;
    }
  | null = null;

export interface MTProtoConfig {
  apiId: number;
  apiHash: string;
  sessionString?: string;
  phoneNumber?: string;
}

export interface RecentChannelAnalysis {
  channel: string;
  messagesAnalyzed: number;
  signalMessages: number;
  solanaMessages: number;
  memecoinMessages: number;
  callMessages: number;
  contractMessages: number;
  pumpfunMessages: number;
  solanaContracts: string[];
  evmContracts: string[];
  essenceScore: number;
  verdict: "strong" | "medium" | "weak" | "reject";
  reasons: string[];
}

export function normalizeChannelInput(input: string): string | null {
  const parsed = parseChannelInput(input);
  if (!parsed) return null;
  return parsed.kind === "invite" ? `https://t.me/+${parsed.hash}` : parsed.value;
}

type ParsedChannelInput =
  | { kind: "username"; value: string }
  | { kind: "invite"; hash: string };

function parseChannelInput(input: string): ParsedChannelInput | null {
  const raw = input.trim();
  if (!raw) return null;

  const withoutProtocol = raw.replace(/^https?:\/\//i, "").replace(/^tg:\/\//i, "");
  const inviteMatch = withoutProtocol.match(/^(?:www\.)?t\.me\/(?:joinchat\/|\+)([^/?#\s]+)/i);
  if (inviteMatch) return { kind: "invite", hash: inviteMatch[1] };

  const usernameMatch = withoutProtocol.match(/^(?:www\.)?(?:t\.me|telegram\.me)\/([^/?#\s]+)/i);
  const candidate = (usernameMatch ? usernameMatch[1] : withoutProtocol).replace(/^@/, "").trim();
  if (!candidate || candidate.includes(" ")) return null;

  return { kind: "username", value: candidate };
}

function getString(user: Record<string, unknown>, snake: string, camel: string): string | undefined {
  const value = user[snake] ?? user[camel];
  return value === undefined || value === null ? undefined : String(value);
}

function getBoolean(user: Record<string, unknown>, snake: string, camel: string): boolean {
  return Boolean(user[snake] ?? user[camel]);
}

function getNumber(user: Record<string, unknown>, snake: string, camel: string): number | undefined {
  const value = user[snake] ?? user[camel];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "value" in value) return Number((value as { value: unknown }).value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeBase58(value: string): Uint8Array {
  let bytes = [0];
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base58");
    let carry = index;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char === "1") bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

function isSolanaAddress(value: string): boolean {
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function analyzeMessageText(text: string): {
  signal: boolean;
  solana: boolean;
  memecoin: boolean;
  call: boolean;
  contract: boolean;
  pumpfun: boolean;
  solanaContracts: string[];
  evmContracts: string[];
} {
  const solanaContracts = unique((text.match(SOLANA_CANDIDATE_RE) || []).filter(isSolanaAddress));
  const evmContracts = unique((text.match(EVM_CONTRACT_RE) || []).map((item) => item.toLowerCase()));
  const solana = SOLANA_CONTEXT_RE.test(text) || solanaContracts.length > 0;
  const memecoin = MEME_CONTEXT_RE.test(text);
  const call = CALL_CONTEXT_RE.test(text) && (solana || memecoin || solanaContracts.length > 0 || evmContracts.length > 0);
  const pumpfun = PUMPFUN_RE.test(text);
  const contract = solanaContracts.length > 0 || evmContracts.length > 0;
  return {
    signal: solana || memecoin || call || pumpfun || contract,
    solana,
    memecoin,
    call,
    contract,
    pumpfun,
    solanaContracts,
    evmContracts,
  };
}

function scoreRecentAnalysis(analysis: Omit<RecentChannelAnalysis, "essenceScore" | "verdict" | "reasons">): Pick<RecentChannelAnalysis, "essenceScore" | "verdict" | "reasons"> {
  const score = Math.min(
    100,
    Math.log1p(analysis.solanaContracts.length) / Math.log1p(5) * 32
      + Math.log1p(analysis.pumpfunMessages) / Math.log1p(3) * 18
      + Math.log1p(analysis.callMessages) / Math.log1p(8) * 18
      + Math.log1p(analysis.memecoinMessages) / Math.log1p(12) * 14
      + Math.log1p(analysis.solanaMessages) / Math.log1p(10) * 12
      + (analysis.messagesAnalyzed > 0 ? (analysis.contractMessages / analysis.messagesAnalyzed) * 6 : 0)
  );
  const rounded = Math.round(score * 10) / 10;
  const reasons: string[] = [];
  if (analysis.solanaContracts.length) reasons.push(`${analysis.solanaContracts.length} Solana contract(s) in last 100`);
  if (analysis.pumpfunMessages) reasons.push(`${analysis.pumpfunMessages} pump.fun signal(s)`);
  if (analysis.callMessages) reasons.push(`${analysis.callMessages} call/entry signal(s)`);
  if (analysis.memecoinMessages) reasons.push(`${analysis.memecoinMessages} meme coin signal(s)`);
  if (!reasons.length) reasons.push("No strong Solana meme contract behavior in last 100 messages");
  return {
    essenceScore: rounded,
    verdict: rounded >= 70 ? "strong" : rounded >= 45 ? "medium" : rounded >= 20 ? "weak" : "reject",
    reasons,
  };
}

function toRawMember(user: Record<string, unknown>): RawMember | null {
  const type = String(user._ || user.className || "");
  if (type && !/^(user|User)$/i.test(type)) return null;

  const id = getNumber(user, "id", "id");
  if (!id) return null;

  const photo = user.photo as Record<string, unknown> | undefined;
  const member: RawMember = {
    id,
    username: getString(user, "username", "username"),
    firstName: getString(user, "first_name", "firstName"),
    lastName: getString(user, "last_name", "lastName"),
    phone: getString(user, "phone", "phone"),
    isBot: getBoolean(user, "bot", "bot"),
    isPremium: getBoolean(user, "premium", "premium"),
    isScam: getBoolean(user, "scam", "scam"),
    isFake: getBoolean(user, "fake", "fake"),
    isRestricted: getBoolean(user, "restricted", "restricted"),
    photo: photo ? { isPersonal: Boolean(photo.personal) } : undefined,
    langCode: getString(user, "lang_code", "langCode"),
    restrictionReason: undefined,
    accessHash: getString(user, "access_hash", "accessHash"),
    lastSeen: undefined,
    createdAt: undefined,
  };

  const status = user.status as Record<string, unknown> | undefined;
  if (status) {
    const statusType = String(status._ || status.className || "");
    if (/userStatusOnline/i.test(statusType)) {
      member.lastSeen = new Date();
    } else if (/userStatusOffline/i.test(statusType)) {
      const wasOnline = getNumber(status, "was_online", "wasOnline");
      if (wasOnline) member.lastSeen = new Date(wasOnline * 1000);
    } else if (/userStatusRecently/i.test(statusType)) {
      member.lastSeen = new Date(Date.now() - 3 * 86400000);
    } else if (/userStatusLastWeek/i.test(statusType)) {
      member.lastSeen = new Date(Date.now() - 7 * 86400000);
    } else if (/userStatusLastMonth/i.test(statusType)) {
      member.lastSeen = new Date(Date.now() - 30 * 86400000);
    }
  }

  const createdAt = getNumber(user, "date", "date");
  if (createdAt) {
    member.createdAt = new Date(createdAt * 1000);
  }

  return member;
}

type TelegramClientLike = Record<string, unknown> & {
  connected?: boolean;
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  checkAuthorization?: () => Promise<boolean>;
};

async function ensureConnected(tgClient: TelegramClientLike): Promise<void> {
  if (!tgClient.connected && typeof tgClient.connect === "function") {
    await tgClient.connect();
  }
}

async function resolveChannelEntity(
  tgClient: {
    getEntity: (input: string) => Promise<unknown>;
    invoke: (query: unknown) => Promise<unknown>;
  },
  channelInput: string
): Promise<unknown> {
  const parsed = parseChannelInput(channelInput);
  if (!parsed) {
    throw new Error("Invalid channel link or username");
  }

  if (parsed.kind === "username") {
    return tgClient.getEntity(parsed.value);
  }

  const { Api } = await import("telegram");
  const checked = await tgClient.invoke(new Api.messages.CheckChatInvite({ hash: parsed.hash }));
  const checkedObj = checked as { chat?: unknown; className?: string; _: string };
  if (checkedObj.chat) {
    return checkedObj.chat;
  }

  const imported = await tgClient.invoke(new Api.messages.ImportChatInvite({ hash: parsed.hash }));
  const importedObj = imported as { chats?: unknown[] };
  const [chat] = importedObj.chats || [];
  if (chat) {
    return chat;
  }

  throw new Error("Invite link does not expose a channel. Join it in Telegram first or use a public @username.");
}

export async function createClient(config: MTProtoConfig): Promise<Record<string, unknown>> {
  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions");

  const session = new StringSession(config.sessionString || "");
  const tgClient = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
  });

  const clientInstance = tgClient as unknown as Record<string, unknown>;
  setClient(clientInstance);
  return clientInstance;
}

export async function startClient(
  tgClient: Record<string, unknown>,
  phoneNumber: string
): Promise<string> {
  const client = tgClient as { start: (opts: Record<string, unknown>) => Promise<void>; session: { save: () => string } };
  await client.start({
    phoneNumber: async () => phoneNumber,
    phoneCode: async () => {
      throw new Error("Phone code required — implement interactive input");
    },
    onError: (err: unknown) => console.error("MTProto error:", err),
  });

  return client.session.save();
}

export async function sendLoginCode(config: MTProtoConfig & { phoneNumber: string }): Promise<{ isCodeViaApp: boolean }> {
  const tgClient = await createClient(config);
  const typedClient = tgClient as TelegramClientLike & {
    sendCode: (
      credentials: { apiId: number; apiHash: string },
      phoneNumber: string
    ) => Promise<{ phoneCodeHash: string; isCodeViaApp: boolean }>;
  };

  await ensureConnected(typedClient);
  const result = await typedClient.sendCode(
    { apiId: config.apiId, apiHash: config.apiHash },
    config.phoneNumber
  );

  pendingAuth = {
    apiId: config.apiId,
    apiHash: config.apiHash,
    phoneNumber: config.phoneNumber,
    phoneCodeHash: result.phoneCodeHash,
    isCodeViaApp: result.isCodeViaApp,
    client: tgClient,
  };
  setClient(tgClient);

  return { isCodeViaApp: result.isCodeViaApp };
}

export async function completeLogin(params: {
  phoneCode?: string;
  password?: string;
}): Promise<string> {
  if (!pendingAuth) {
    throw new Error("No pending Telegram login. Send code first.");
  }

  const { Api } = await import("telegram");
  const typedClient = pendingAuth.client as TelegramClientLike & {
    invoke: (query: unknown) => Promise<unknown>;
    signInWithPassword: (
      credentials: { apiId: number; apiHash: string },
      authParams: { password?: () => Promise<string>; onError: (err: Error) => void }
    ) => Promise<unknown>;
    session: { save: () => string };
  };

  await ensureConnected(typedClient);

  try {
    if (params.password?.trim()) {
      await typedClient.signInWithPassword(
        { apiId: pendingAuth.apiId, apiHash: pendingAuth.apiHash },
        {
          password: async () => params.password || "",
          onError: (err: Error) => console.error("MTProto password error:", err),
        }
      );
    } else {
      if (!params.phoneCode?.trim()) {
        throw new Error("Telegram login code required");
      }

      await typedClient.invoke(
        new Api.auth.SignIn({
          phoneNumber: pendingAuth.phoneNumber,
          phoneCodeHash: pendingAuth.phoneCodeHash,
          phoneCode: params.phoneCode.trim(),
        })
      );
    }

    const sessionString = typedClient.session.save();
    pendingAuth = null;
    setClient(typedClient);
    return sessionString;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("SESSION_PASSWORD_NEEDED")) {
      throw new Error("TWO_FACTOR_PASSWORD_REQUIRED");
    }
    throw err;
  }
}

export async function fetchChannelMembers(
  tgClient: Record<string, unknown>,
  channelUsername: string,
  options: {
    limit?: number;
    searchQuery?: string;
  } = {}
): Promise<RawMember[]> {
  const members: RawMember[] = [];
  const limit = options.limit || 10000;
  let offset = 0;
  const batchSize = 100;

  const client = tgClient as {
    connected?: boolean;
    connect?: () => Promise<void>;
    getEntity: (input: string) => Promise<unknown>;
    invoke: (query: unknown) => Promise<unknown>;
  };

  try {
    await ensureConnected(client);
    const entity = await resolveChannelEntity(client, channelUsername);

    while (members.length < limit) {
      // Dynamic import to avoid type issues at compile time
      const { Api } = await import("telegram");

      const result = await client.invoke(
        new Api.channels.GetParticipants({
          channel: entity as never,
          filter: new Api.ChannelParticipantsSearch({ q: options.searchQuery || "" }) as never,
          offset,
          limit: batchSize,
          hash: 0 as never,
        })
      );

      const resultObj = result as { users?: Array<Record<string, unknown>> };
      if (!resultObj?.users || resultObj.users.length === 0) break;

      for (const userData of resultObj.users) {
        const member = toRawMember(userData);
        if (!member) continue;

        members.push(member);
        if (members.length >= limit) break;
      }

      offset += resultObj.users.length;
    }
  } catch (err: unknown) {
    const error = err as { message?: string };
    throw new Error(`Failed to fetch members: ${error.message || "Unknown error"}`);
  }

  return members;
}

export async function fetchVisibleMembersFromHistory(
  tgClient: Record<string, unknown>,
  channelUsername: string,
  options: {
    limit?: number;
  } = {}
): Promise<RawMember[]> {
  const membersById = new Map<number, RawMember>();
  const limit = options.limit || 1000;
  let offsetId = 0;
  const batchSize = Math.min(100, limit);

  const client = tgClient as {
    connected?: boolean;
    connect?: () => Promise<void>;
    getEntity: (input: string) => Promise<unknown>;
    invoke: (query: unknown) => Promise<unknown>;
  };

  try {
    await ensureConnected(client);
    const entity = await resolveChannelEntity(client, channelUsername);
    const { Api } = await import("telegram");

    while (membersById.size < limit) {
      const result = await client.invoke(
        new Api.messages.GetHistory({
          peer: entity as never,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit: batchSize,
          maxId: 0,
          minId: 0,
          hash: 0 as never,
        })
      );

      const resultObj = result as {
        users?: Array<Record<string, unknown>>;
        messages?: Array<Record<string, unknown>>;
      };

      for (const userData of resultObj.users || []) {
        const member = toRawMember(userData);
        if (member && !membersById.has(member.id)) {
          membersById.set(member.id, member);
        }
        if (membersById.size >= limit) break;
      }

      const messages = resultObj.messages || [];
      if (messages.length === 0) break;

      const lastMessageId = getNumber(messages[messages.length - 1], "id", "id");
      if (!lastMessageId || lastMessageId === offsetId) break;
      offsetId = lastMessageId;
    }
  } catch (err: unknown) {
    const error = err as { message?: string };
    throw new Error(`Failed to fetch visible members from history: ${error.message || "Unknown error"}`);
  }

  return Array.from(membersById.values());
}

export async function analyzeChannelRecentMessages(
  tgClient: Record<string, unknown>,
  channelUsername: string,
  options: {
    limit?: number;
  } = {}
): Promise<RecentChannelAnalysis> {
  const limit = Math.min(100, Math.max(1, options.limit || 100));
  const client = tgClient as {
    connected?: boolean;
    connect?: () => Promise<void>;
    getEntity: (input: string) => Promise<unknown>;
    invoke: (query: unknown) => Promise<unknown>;
  };

  try {
    await ensureConnected(client);
    const entity = await resolveChannelEntity(client, channelUsername);
    const { Api } = await import("telegram");
    const result = await client.invoke(
      new Api.messages.GetHistory({
        peer: entity as never,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: 0 as never,
      })
    );
    const resultObj = result as { messages?: Array<Record<string, unknown>> };
    const messages = resultObj.messages || [];
    const solanaContracts = new Set<string>();
    const evmContracts = new Set<string>();
    let signalMessages = 0;
    let solanaMessages = 0;
    let memecoinMessages = 0;
    let callMessages = 0;
    let contractMessages = 0;
    let pumpfunMessages = 0;

    for (const message of messages) {
      const text = String(message.message || "");
      const signals = analyzeMessageText(text);
      if (signals.signal) signalMessages += 1;
      if (signals.solana) solanaMessages += 1;
      if (signals.memecoin) memecoinMessages += 1;
      if (signals.call) callMessages += 1;
      if (signals.contract) contractMessages += 1;
      if (signals.pumpfun) pumpfunMessages += 1;
      signals.solanaContracts.forEach((address) => solanaContracts.add(address));
      signals.evmContracts.forEach((address) => evmContracts.add(address));
    }

    const base = {
      channel: channelUsername,
      messagesAnalyzed: messages.length,
      signalMessages,
      solanaMessages,
      memecoinMessages,
      callMessages,
      contractMessages,
      pumpfunMessages,
      solanaContracts: Array.from(solanaContracts),
      evmContracts: Array.from(evmContracts),
    };
    return { ...base, ...scoreRecentAnalysis(base) };
  } catch (err: unknown) {
    const error = err as { message?: string };
    throw new Error(`Failed to analyze recent messages: ${error.message || "Unknown error"}`);
  }
}

export async function inviteUsers(
  tgClient: Record<string, unknown>,
  channelUsername: string,
  users: { id: number; accessHash: string }[]
): Promise<{ invited: number; failed: number; errors: string[] }> {
  let invited = 0;
  let failed = 0;
  const errors: string[] = [];

  const client = tgClient as {
    connected?: boolean;
    connect?: () => Promise<void>;
    getEntity: (input: string) => Promise<unknown>;
    invoke: (query: unknown) => Promise<unknown>;
  };

  try {
    await ensureConnected(client);
    const entity = await resolveChannelEntity(client, channelUsername);
    const { Api } = await import("telegram");

    // Invite in batches of 10 (Telegram limit)
    for (let i = 0; i < users.length; i += 10) {
      const batch = users.slice(i, i + 10);
      try {
        const inputUsers = batch.map((u) => new Api.InputUser({ userId: u.id as never, accessHash: u.accessHash as never }));
        await client.invoke(
          new Api.channels.InviteToChannel({
            channel: entity as never,
            users: inputUsers as never,
          })
        );
        invited += batch.length;
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
      } catch (err: unknown) {
        const error = err as { message?: string };
        failed += batch.length;
        errors.push(error.message || "Batch invite failed");

        if (error.message?.includes("FLOOD_WAIT")) {
          const waitMatch = error.message.match(/FLOOD_WAIT_(\d+)/);
          const waitSec = waitMatch ? parseInt(waitMatch[1]) : 60;
          await new Promise((r) => setTimeout(r, waitSec * 1000));
        }
      }
    }
  } catch (err: unknown) {
    const error = err as { message?: string };
    failed = users.length;
    errors.push(error.message || "Channel entity not found");
  }

  return { invited, failed, errors };
}

export function isConnected(): boolean {
  return Boolean(client && (client as TelegramClientLike).connected);
}

export async function isAuthorized(tgClient: Record<string, unknown>): Promise<boolean> {
  const typedClient = tgClient as TelegramClientLike;
  await ensureConnected(typedClient);
  if (typeof typedClient.checkAuthorization !== "function") return true;
  return typedClient.checkAuthorization();
}

export function getClient(): Record<string, unknown> | null {
  return client;
}

export function setClient(c: Record<string, unknown>): void {
  client = c;
}

export async function clearClient(): Promise<void> {
  const existingClient = client as TelegramClientLike | null;
  client = null;
  pendingAuth = null;
  if (existingClient && typeof existingClient.disconnect === "function") {
    try {
      await existingClient.disconnect();
    } catch {
      // Ignore disconnect cleanup errors.
    }
  }
}
