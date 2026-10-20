import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { addresses, validMint } from "../../../lib/archive/model";
import { xIntelligenceOutboxEnabled } from "./intelligence-outbox";

const TOKEN_PROGRAMS=new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

export function xVerifiedTokenLinksEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  return xIntelligenceOutboxEnabled(env) &&
    env.X_INTELLIGENCE_TOKEN_LINKS_ENABLED==="true";
}

/**
 * No X source presently owns an on-chain-verified mint proof. This builder is
 * NOT called automatically by the tweet collector or token linker: the native
 * address registry only proves a textual match, not an initialized SPL mint.
 * Use only when an explicit verified RPC account proof is provided by a
 * separate approved integration. Never pass wallet/token-account addresses.
 */
export function buildVerifiedXTweetTokenLinkOutboxEvent(input:{
  tweetId:string; authorId:string; text:string; mint:string;
  observedAt:Date; postedAt:Date|null;
  mintVerification:{
    tokenProgram:string; provider:"alchemy-solana-rpc"; checkedAt:Date;
  };
}) {
  if(!/^[1-9][0-9]{0,24}$/.test(input.tweetId) ||
     !/^[1-9][0-9]{0,24}$/.test(input.authorId) ||
     !validMint(input.mint) ||
     !addresses(input.text).includes(input.mint) ||
     !TOKEN_PROGRAMS.has(input.mintVerification?.tokenProgram) ||
     input.mintVerification.provider!=="alchemy-solana-rpc") {
    throw new TypeError("Verified X token evidence required");
  }
  const observedAt=input.observedAt.toISOString();
  const checkedAt=input.mintVerification.checkedAt.toISOString();
  if(checkedAt>observedAt)throw new TypeError("Mint verification is in the future");
  const occurredAt=input.postedAt?.toISOString()??observedAt;
  const sourceRevisionSha256=createHash("sha256").update(JSON.stringify([
    input.text,occurredAt,
  ])).digest("hex");
  const evidenceRef={
    sourceKind:"x_tweet",sourceId:`x:tweet:${input.tweetId}`,
    observedAt,occurredAt,parserVersion:"x-mint-verifier-v1",
  };
  const entityRefs=[
    {kind:"author",canonicalId:`x:${input.authorId}`,firstSeenAt:observedAt,lastSeenAt:observedAt},
    {kind:"token",canonicalId:`solana:${input.mint}`,firstSeenAt:observedAt,lastSeenAt:observedAt},
  ];
  const eventKey=`x:tokenlink:${evidenceRef.sourceId}:${input.mint}:${sourceRevisionSha256}:${input.mintVerification.checkedAt.getTime()}`;
  return {
    sourceSystem:"x",eventKind:"token_link_verified",
    eventKey,schemaVersion:"token-link-v1",
    payload:{
      registryEvent:{
        sourceSystem:"x",eventKind:"token_link_verified",eventKey,
        schemaVersion:"token-link-v1",entityRefs,evidenceRef,
      },
      tokenLink:{
        status:"verified",canonicalTokenId:`solana:${input.mint}`,
        basis:"literal_mint_address",sourceRevisionSha256,
        mintVerification:{
          chainId:"solana-mainnet",method:"spl_mint_account",
          tokenProgram:input.mintVerification.tokenProgram,
          provider:input.mintVerification.provider,checkedAt,
        },
      },
    },
  };
}

/**
 * The caller must be in the SAME PG transaction as its verified proof.
 * No automatic RPC requests, browser actions or source migrations occur here.
 */
export async function emitXVerifiedTokenLinkOutbox(
  tx:PoolClient,input:Parameters<typeof buildVerifiedXTweetTokenLinkOutboxEvent>[0],
):Promise<boolean> {
  if(!xVerifiedTokenLinksEnabled())return false;
  const event=buildVerifiedXTweetTokenLinkOutboxEvent(input);
  await tx.query(`INSERT INTO outbox_events
    (source_system,event_kind,event_key,schema_version,payload)
    VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(source_system,event_kind,event_key) DO NOTHING`,[
    event.sourceSystem,event.eventKind,event.eventKey,event.schemaVersion,JSON.stringify(event.payload),
  ]);
  return true;
}
