import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';

type Client = Pick<PoolClient,'query'>;

export async function addAlias(
 c: Client,
 entityId: string,
 alias: string,
 aliasType: string,
 source: string,
 confidence = 0.5,
){
 await c.query(
  `INSERT INTO ip_entity_aliases(id,entity_id,alias,alias_type,source,confidence)
   VALUES($1,$2,$3,$4,$5,$6)`,
  [randomUUID(),entityId,alias,aliasType,source,confidence]
 );
}

export async function createIdentityCandidate(
 c: Client,
 entityA: string,
 entityB: string,
 matchType: string,
 confidence: number,
 evidence: unknown = {},
){
 const id=randomUUID();
 await c.query(
  `INSERT INTO ip_identity_candidates(id,entity_a,entity_b,match_type,confidence,evidence_json)
   VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
  [id,entityA,entityB,matchType,confidence,JSON.stringify(evidence)]
 );
 return id;
}
