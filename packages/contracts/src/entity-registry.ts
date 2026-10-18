import {
  parseAuthorId, parseSourceId, parseTokenId, parseWalletId,
  type AuthorId, type SourceId, type TokenId, type WalletId,
} from "./canonical-ids.js";
import { toUtcIso } from "./time.js";

export type EntityKind = "token" | "wallet" | "author" | "source";
type IdByKind = {
  token: TokenId;
  wallet: WalletId;
  author: AuthorId;
  source: SourceId;
};
export type EntityRef<K extends EntityKind = EntityKind> = {
  kind: K;
  canonicalId: IdByKind[K];
  firstSeenAt: string;
  lastSeenAt: string;
};

export function buildEntityRef<K extends EntityKind>(input: {
  kind: K;
  canonicalId: string;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
}): EntityRef<K> {
  const firstSeenAt = toUtcIso(input.firstSeenAt);
  const lastSeenAt = toUtcIso(input.lastSeenAt);
  if (firstSeenAt > lastSeenAt) throw new TypeError("firstSeenAt is later than lastSeenAt");

  let canonicalId: string | undefined;
  switch (input.kind) {
    case "token": canonicalId = parseTokenId(input.canonicalId)?.id; break;
    case "wallet": canonicalId = parseWalletId(input.canonicalId)?.id; break;
    case "author": canonicalId = parseAuthorId(input.canonicalId)?.id; break;
    case "source": canonicalId = parseSourceId(input.canonicalId)?.id; break;
    default: throw new TypeError("Unknown entity kind");
  }
  if (!canonicalId || canonicalId !== input.canonicalId) {
    throw new TypeError("Noncanonical or invalid entity ID");
  }
  return {
    kind: input.kind,
    canonicalId: canonicalId as IdByKind[K],
    firstSeenAt,
    lastSeenAt,
  };
}
