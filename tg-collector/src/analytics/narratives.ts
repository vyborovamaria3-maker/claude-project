import type { PoolClient } from "pg";

export const NARRATIVE_MODEL_VERSION = "keyword-v1";

const RULES: Record<string, string[]> = {
  frog: ["frog", "pepe", "ribbit", "feels good man"],
  cat: ["cat", "kitty", "meow", "feline"],
  dog: ["doge", "shiba", "puppy", "dog coin"],
  ai_agent: ["ai agent", "ai-agent", "agentic", "llm", "autonomous agent"],
  politics_us: ["trump", "maga", "election", "biden"],
  gaming: ["gaming", "gamefi", "cs2", "steam game"],
  defi: ["defi", "yield", "staking", "liquidity pool"],
  celebrity: ["celebrity", "influencer", "viral star"],
  animal_meme: ["bear", "bull", "frog", "cat", "dog", "penguin", "monkey"],
};

export type NarrativeMatch = { name: string; terms: string[]; confidence: number };

function normalizeWords(text: string): string {
  return " " + text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
}

export function classifyNarratives(text: string): NarrativeMatch[] {
  const normalized = normalizeWords(text);
  const matches: NarrativeMatch[] = [];
  for (const [name, terms] of Object.entries(RULES)) {
    const found = terms.filter((term) => normalized.includes(normalizeWords(term)));
    if (found.length) matches.push({
      name,
      terms: found,
      confidence: Math.min(0.95, 0.55 + Math.min(found.length, 4) * 0.08),
    });
  }
  return matches;
}

/** Store message-level narrative evidence and rebuild the aggregate for one token. */
export async function syncTokenNarratives(
  tx: PoolClient, sourceId: string, messageId: string, chainId: string, mint: string, text: string,
): Promise<void> {
  const matches = classifyNarratives(text);
  const names = matches.map((match) => match.name);
  const narratives = names.length
    ? await tx.query<{ id: string; narrative_name: string }>(
      "SELECT id::text,narrative_name FROM tg_narratives WHERE narrative_name=ANY($1::text[]) AND model_version=$2",
      [names, NARRATIVE_MODEL_VERSION],
    )
    : { rows: [] as { id: string; narrative_name: string }[] };
  const idByName = new Map(narratives.rows.map((row) => [row.narrative_name, row.id]));
  const currentIds = matches.map((match) => idByName.get(match.name)).filter((id): id is string => Boolean(id));

  await tx.query(
    "DELETE FROM tg_message_narratives WHERE source_id=$1 AND message_id=$2 AND chain_id=$3 AND mint=$4 " +
    "AND model_version=$5 AND NOT(narrative_id=ANY($6::bigint[]))",
    [sourceId, messageId, chainId, mint, NARRATIVE_MODEL_VERSION, currentIds],
  );
  for (const match of matches) {
    const narrativeId = idByName.get(match.name);
    if (!narrativeId) continue;
    await tx.query(
      "INSERT INTO tg_message_narratives(source_id,message_id,chain_id,mint,narrative_id,confidence,evidence_terms,model_version) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8) " +
      "ON CONFLICT(source_id,message_id,chain_id,mint,narrative_id,model_version) " +
      "DO UPDATE SET confidence=EXCLUDED.confidence,evidence_terms=EXCLUDED.evidence_terms,analyzed_at=now()",
      [sourceId, messageId, chainId, mint, narrativeId, match.confidence, match.terms, NARRATIVE_MODEL_VERSION],
    );
  }

  await tx.query(
    "DELETE FROM tg_token_narratives tn WHERE tn.chain_id=$1 AND tn.mint=$2 AND tn.model_version=$3 " +
    "AND NOT EXISTS (SELECT 1 FROM tg_message_narratives mn JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE mn.chain_id=tn.chain_id AND mn.mint=tn.mint AND mn.narrative_id=tn.narrative_id " +
    "AND mn.model_version=tn.model_version AND m.deleted_at IS NULL)",
    [chainId, mint, NARRATIVE_MODEL_VERSION],
  );
  await tx.query(
    "INSERT INTO tg_token_narratives(chain_id,mint,narrative_id,confidence,evidence_count,first_seen_at,last_seen_at,model_version) " +
    "SELECT mn.chain_id,mn.mint,mn.narrative_id,avg(mn.confidence)::numeric,count(*)::integer," +
    "min(COALESCE(m.posted_at,mn.analyzed_at)),max(COALESCE(m.posted_at,mn.analyzed_at)),mn.model_version " +
    "FROM tg_message_narratives mn JOIN tg_messages m USING(source_id,message_id) " +
    "WHERE mn.chain_id=$1 AND mn.mint=$2 AND mn.model_version=$3 AND m.deleted_at IS NULL " +
    "GROUP BY mn.chain_id,mn.mint,mn.narrative_id,mn.model_version " +
    "ON CONFLICT(chain_id,mint,narrative_id,model_version) DO UPDATE SET confidence=EXCLUDED.confidence," +
    "evidence_count=EXCLUDED.evidence_count,first_seen_at=EXCLUDED.first_seen_at,last_seen_at=EXCLUDED.last_seen_at",
    [chainId, mint, NARRATIVE_MODEL_VERSION],
  );
}
