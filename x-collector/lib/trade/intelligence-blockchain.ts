import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {resolveEntity,link} from './intelligence-store';
import {normalizeAddress,normalizeTransactionHash} from '../intelligence/chain-adapter';
const Transaction=z.object({chain:z.enum(['ethereum','solana','bitcoin']),hash:z.string().min(1).max(200),from:z.string(),to:z.string(),token:z.string().nullable(),amount:z.string().regex(/^\d+(\.\d+)?$/).max(100),timestamp:z.string().datetime(),source:z.string().url(),payload:z.record(z.unknown())});
function decimal(value:string){const [whole,fraction='']=value.split('.');return whole.replace(/^0+(?=\d)/,'')+(fraction.replace(/0+$/,'')?'.'+fraction.replace(/0+$/,''):'');}
// Caller supplies a confirmed chain observation, not a wallet string from a bio.
export async function ingestTransaction(c:Pick<PoolClient,'query'>,input:unknown){
 const t=Transaction.parse(input);
 const hash=normalizeTransactionHash(t.chain,t.hash);
 const from=normalizeAddress(t.chain,t.from),to=normalizeAddress(t.chain,t.to),token=t.token?normalizeAddress(t.chain,t.token):null;
 const payload=JSON.stringify(t),payloadHash=createHash('sha256').update(payload).digest('hex');
 const r=await c.query<{id:string}>(`INSERT INTO ip_raw_events(id,source,event_type,external_id,payload,payload_hash,collected_at,normalized_at)
 VALUES($1,$2,'TRANSACTION',$3,$4::jsonb,$5,$6,now()) ON CONFLICT(source,event_type,external_id,payload_hash,collected_at) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id`,[randomUUID(),t.source,t.chain+':'+hash,payload,payloadHash,new Date()]);
 const raw=r.rows[0].id,a=await resolveEntity(c,'WALLET',t.chain,from,from),b=await resolveEntity(c,'WALLET',t.chain,to,to),asset=token?await resolveEntity(c,'TOKEN',t.chain,token,token):null;
 await c.query(`INSERT INTO ip_blockchain_transactions(hash,chain,from_entity,to_entity,token_entity,amount,timestamp,raw_event_id)
 VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8) ON CONFLICT(chain,hash) DO NOTHING`,[hash,t.chain,a,b,asset,t.amount,new Date(t.timestamp),raw]);
 const saved=(await c.query<{from_entity:string;to_entity:string;token_entity:string|null;amount:string}>(`SELECT from_entity,to_entity,token_entity,amount::text FROM ip_blockchain_transactions WHERE chain=$1 AND hash=$2`,[t.chain,hash])).rows[0];
 if(saved.from_entity!==a||saved.to_entity!==b||saved.token_entity!==asset||decimal(saved.amount)!==decimal(t.amount))throw Error('Conflicting transaction observation; multi-transfer transactions require separate transfer identifiers');
 await link(c,a,b,'TRANSFERRED',raw,new Date(t.timestamp));
 return {raw_event_id:raw,from_entity:a,to_entity:b};
}
export async function putEmbedding(c:Pick<PoolClient,'query'>,entity:string,model:string,vector:number[]){
 if(!model||model.length>200||!vector.length||vector.length>4096||vector.some(v=>!Number.isFinite(v))||!vector.some(v=>v!==0))throw Error('Invalid embedding');
 await c.query(`INSERT INTO ip_entity_embeddings(entity_id,model,vector,dimensions) VALUES($1,$2,$3::double precision[],$4)
 ON CONFLICT(entity_id,model) DO UPDATE SET vector=EXCLUDED.vector,dimensions=EXCLUDED.dimensions,created_at=now()`,[entity,model,vector,vector.length]);
}
