import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { nanoid } from "nanoid";
import { redis } from "../lib/redis";
import { AppError } from "../utils/errors";

const WALLET_CHALLENGE_TTL_SECONDS = 300;

export async function createWalletChallenge(userId: string, publicKey: string) {
  validatePublicKey(publicKey);
  const nonce = nanoid(24);
  const message = [
    "SolSub wallet link",
    `User: ${userId}`,
    `Wallet: ${publicKey}`,
    `Nonce: ${nonce}`
  ].join("\n");

  await redis.set(`wallet-challenge:${userId}:${publicKey}`, message, "EX", WALLET_CHALLENGE_TTL_SECONDS);
  return { message, expiresIn: WALLET_CHALLENGE_TTL_SECONDS };
}

export async function verifyWalletSignature(userId: string, publicKey: string, signature: string) {
  validatePublicKey(publicKey);
  const message = await redis.get(`wallet-challenge:${userId}:${publicKey}`);
  if (!message) {
    throw new AppError(400, "Wallet challenge expired", "WALLET_CHALLENGE_EXPIRED");
  }

  const verified = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    bs58.decode(signature),
    new PublicKey(publicKey).toBytes()
  );
  if (!verified) {
    throw new AppError(401, "Invalid wallet signature", "INVALID_WALLET_SIGNATURE");
  }

  await redis.del(`wallet-challenge:${userId}:${publicKey}`);
}

export function validatePublicKey(publicKey: string) {
  try {
    new PublicKey(publicKey);
  } catch {
    throw new AppError(400, "Invalid Solana public key", "INVALID_SOLANA_PUBLIC_KEY");
  }
}
