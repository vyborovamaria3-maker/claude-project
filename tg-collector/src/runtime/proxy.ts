import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

export type TgProxyType = "socks5" | "socks4" | "mtproxy";

export type TgProxyConfig = {
  proxyType: TgProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  secret?: string;
};

export type TgProxyTransport =
  | { ip: string; port: number; MTProxy: true; secret: string; timeout?: number }
  | { ip: string; port: number; MTProxy: false; socksType: 4 | 5; username?: string; password?: string; timeout?: number };

export type TgProxyStatus = {
  enabled: boolean;
  configured: boolean;
  proxyType: TgProxyType | null;
  host: string | null;
  port: number | null;
  usernameConfigured: boolean;
  passwordConfigured: boolean;
  secretConfigured: boolean;
  updatedAt: string | null;
};

function key(): Buffer {
  const configured = process.env.TG_PROXY_ENCRYPTION_KEY?.trim();
  const source = configured || process.env.TG_API_HASH?.trim();
  if (!source) throw new Error("TG_API_HASH or TG_PROXY_ENCRYPTION_KEY is required to encrypt proxy credentials");
  if (/^[0-9a-fA-F]{64}$/.test(source)) return Buffer.from(source, "hex");
  return createHash("sha256").update(source, "utf8").digest();
}

function encrypt(value: string | undefined): string | null {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(part => part.toString("base64url")).join(".");
}

function decrypt(value: string | null): string | undefined {
  if (!value) return undefined;
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted TG proxy credential");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function validate(input: TgProxyConfig): void {
  if (!["socks5", "socks4", "mtproxy"].includes(input.proxyType)) throw new Error("Unsupported Telegram proxy type");
  if (!input.host || input.host.length > 253 || /[\r\n]/.test(input.host)) throw new Error("Invalid proxy host");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("Invalid proxy port");
  if (input.proxyType === "mtproxy" && !input.secret) throw new Error("MTProxy requires a secret");
  if (input.proxyType !== "mtproxy" && input.secret) throw new Error("MTProxy secret is only valid for MTProxy");
}

export async function getProxyStatus(client: PoolClient | typeof pool = pool): Promise<TgProxyStatus> {
  const { rows } = await client.query<{
    enabled: boolean; proxy_type: TgProxyType; host: string; port: number;
    username_enc: string | null; password_enc: string | null; secret_enc: string | null; updated_at: Date | string;
  }>("SELECT enabled,proxy_type,host,port,username_enc,password_enc,secret_enc,updated_at FROM tg_proxy_config WHERE id=1");
  const row = rows[0];
  if (!row) return {
    enabled: false, configured: false, proxyType: null, host: null, port: null,
    usernameConfigured: false, passwordConfigured: false, secretConfigured: false, updatedAt: null,
  };
  return {
    enabled: row.enabled, configured: true, proxyType: row.proxy_type, host: row.host, port: Number(row.port),
    usernameConfigured: Boolean(row.username_enc), passwordConfigured: Boolean(row.password_enc),
    secretConfigured: Boolean(row.secret_enc), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function loadProxy(): Promise<TgProxyTransport | undefined> {
  const { rows } = await pool.query<{
    enabled: boolean; proxy_type: TgProxyType; host: string; port: number;
    username_enc: string | null; password_enc: string | null; secret_enc: string | null;
  }>("SELECT enabled,proxy_type,host,port,username_enc,password_enc,secret_enc FROM tg_proxy_config WHERE id=1");
  const row = rows[0];
  if (!row || !row.enabled) return undefined;
  const settings: TgProxyConfig = {
    proxyType: row.proxy_type, host: row.host, port: Number(row.port),
    username: decrypt(row.username_enc), password: decrypt(row.password_enc), secret: decrypt(row.secret_enc),
  };
  validate(settings);
  if (settings.proxyType === "mtproxy") {
    if (!settings.secret) throw new Error("MTProxy secret is missing");
    return { ip: settings.host, port: settings.port, MTProxy: true, secret: settings.secret, timeout: 5 };
  }
  return {
    ip: settings.host,
    port: settings.port,
    MTProxy: false,
    socksType: settings.proxyType === "socks4" ? 4 : 5,
    ...(settings.username ? { username: settings.username } : {}),
    ...(settings.password ? { password: settings.password } : {}),
    timeout: 5,
  };
}

export async function saveProxy(input: TgProxyConfig, preserveSecrets = true): Promise<void> {
  const current = preserveSecrets ? await pool.query<{
    username_enc: string | null; password_enc: string | null; secret_enc: string | null;
  }>("SELECT username_enc,password_enc,secret_enc FROM tg_proxy_config WHERE id=1") : { rows: [] };
  const previous = current.rows[0];
  const effective: TgProxyConfig = {
    ...input,
    username: input.username || undefined,
    password: input.password || undefined,
    secret: input.secret || undefined,
  };
  if (preserveSecrets && previous) {
    if (!effective.username && input.proxyType !== "mtproxy") effective.username = decrypt(previous.username_enc);
    if (!effective.password && input.proxyType !== "mtproxy") effective.password = decrypt(previous.password_enc);
    if (!effective.secret && input.proxyType === "mtproxy") effective.secret = decrypt(previous.secret_enc);
  }
  validate(effective);
  const usernameEnc = effective.proxyType === "mtproxy" ? null : encrypt(effective.username);
  const passwordEnc = effective.proxyType === "mtproxy" ? null : encrypt(effective.password);
  const secretEnc = effective.proxyType === "mtproxy" ? encrypt(effective.secret) : null;
  await pool.query(
    `INSERT INTO tg_proxy_config
      (id,proxy_type,host,port,username_enc,password_enc,secret_enc,enabled,updated_at)
      VALUES (1,$1,$2,$3,$4,$5,$6,TRUE,now())
      ON CONFLICT (id) DO UPDATE SET
        proxy_type=EXCLUDED.proxy_type,host=EXCLUDED.host,port=EXCLUDED.port,
        username_enc=EXCLUDED.username_enc,password_enc=EXCLUDED.password_enc,
        secret_enc=EXCLUDED.secret_enc,enabled=TRUE,updated_at=now()`,
    [effective.proxyType,effective.host,effective.port,usernameEnc,passwordEnc,secretEnc],
  );
}

export async function setProxyEnabled(enabled: boolean): Promise<void> {
  await pool.query("UPDATE tg_proxy_config SET enabled=$1,updated_at=now() WHERE id=1",[enabled]);
}

export async function clearProxy(): Promise<void> {
  await pool.query("DELETE FROM tg_proxy_config WHERE id=1");
}
