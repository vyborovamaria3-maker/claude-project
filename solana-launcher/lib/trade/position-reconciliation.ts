export type TokenBalanceLike = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
    uiAmount?: number | null;
    uiAmountString?: string;
  };
};

export type TransactionMetaLike = {
  preTokenBalances?: TokenBalanceLike[] | null;
  postTokenBalances?: TokenBalanceLike[] | null;
};

export type ReconciledTokenDelta = {
  mint: string;
  owner: string | null;
  decimals: number;
  preRaw: string;
  postRaw: string;
  deltaRaw: string;
  deltaUi: number | null;
};

function rawAmount(balance: TokenBalanceLike | undefined) {
  try {
    return BigInt(String(balance?.uiTokenAmount?.amount ?? "0"));
  } catch {
    return 0n;
  }
}

export function extractOwnerTokenDelta(
  meta: TransactionMetaLike | null | undefined,
  { mint, owner }: { mint: string; owner?: string | null },
): ReconciledTokenDelta | null {
  if (!meta || !mint) return null;
  const pre = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
  const post = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];

  const matches = (row: TokenBalanceLike) => {
    if (row?.mint !== mint) return false;
    return !owner || !row.owner || row.owner === owner;
  };

  const postRow = post.find(matches);
  const preRow = pre.find(matches);
  if (!postRow && !preRow) return null;

  const decimals = Number(postRow?.uiTokenAmount?.decimals ?? preRow?.uiTokenAmount?.decimals ?? 0);
  const preRaw = rawAmount(preRow);
  const postRaw = rawAmount(postRow);
  const deltaRaw = postRaw - preRaw;
  const scale = 10 ** Math.max(0, Math.min(30, decimals));
  const deltaUi = Number.isSafeInteger(Number(deltaRaw)) && Number.isFinite(scale)
    ? Number(deltaRaw) / scale
    : null;

  return {
    mint,
    owner: postRow?.owner || preRow?.owner || owner || null,
    decimals,
    preRaw: preRaw.toString(),
    postRaw: postRaw.toString(),
    deltaRaw: deltaRaw.toString(),
    deltaUi,
  };
}

export function reconcileExpectedCredit({
  expectedRaw,
  txDelta,
  observedBalanceRaw,
  tolerancePct = 2,
}: {
  expectedRaw: string;
  txDelta?: ReconciledTokenDelta | null;
  observedBalanceRaw?: string | null;
  tolerancePct?: number;
}) {
  let expected = 0n;
  let observed = 0n;
  try { expected = BigInt(expectedRaw); } catch { expected = 0n; }
  try { observed = BigInt(observedBalanceRaw || "0"); } catch { observed = 0n; }
  const delta = (() => {
    try { return BigInt(txDelta?.deltaRaw || "0"); } catch { return 0n; }
  })();
  const credited = delta > observed ? delta : observed;
  if (expected <= 0n) return { reconciled: credited > 0n, creditedRaw: credited.toString(), ratio: null };

  const basis = 10_000n;
  const tolerance = BigInt(Math.max(0, Math.min(10_000, Math.floor(Number(tolerancePct || 0) * 100))));
  const minExpected = (expected * (basis - tolerance)) / basis;
  const ratio = Number(credited * 10_000n / expected) / 100;
  return {
    reconciled: credited >= minExpected,
    creditedRaw: credited.toString(),
    ratio,
  };
}
