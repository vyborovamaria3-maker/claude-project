import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";

type Client=Pick<PoolClient,"query">;

export class AuditError extends Error{}

export type AuditEntry={
 id:string;
 actor:string;
 action:string;
 entity_id:string|null;
 payload:Record<string,unknown>;
 created_at:Date;
};

export type RecordAuditInput={
 action:string;
 actor?:string;
 entityId?:string|null;
 payload?:Record<string,unknown>;
};

export type AuditFilter={
 action?:string;
 entityId?:string;
 since?:Date;
 limit?:number;
 offset?:number;
};

function requireText(value:string|undefined,fallback:string,maxLength:number,label:string):string{
 const text=(value??fallback).trim();
 if(!text)throw new AuditError(`${label} is required`);
 if(text.length>maxLength)throw new AuditError(`${label} must be at most ${maxLength} characters`);
 return text;
}

function serialise(payload:Record<string,unknown>|undefined):string{
 const value=payload??{};
 if(Array.isArray(value)||typeof value!=="object"||value===null)throw new AuditError("payload must be an object");
 try{
  const json=JSON.stringify(value);
  if(json===undefined)throw new AuditError("payload is not serialisable");
  return json;
 }catch(error){
  if(error instanceof AuditError)throw error;
  throw new AuditError("payload is not serialisable");
 }
}

export async function recordAudit(c:Client,input:RecordAuditInput):Promise<AuditEntry>{
 const action=requireText(input.action,"",100,"action");
 const actor=requireText(input.actor,"agent",100,"actor");
 const entity=input.entityId??null;
 if(entity){
  const exists=await c.query<{id:string}>("SELECT id FROM ip_entities WHERE id=$1",[entity]);
  if(!exists.rows.length)throw new AuditError("Audited entity does not exist");
 }
 const r=await c.query<AuditEntry>(
  `INSERT INTO ip_audit_log(id,actor,action,entity_id,payload) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,actor,action,entity_id,payload,created_at`,
  [randomUUID(),actor,action,entity,serialise(input.payload)]);
 return r.rows[0];
}

export async function listAudit(c:Client,filter:AuditFilter={}):Promise<AuditEntry[]>{
 const limit=filter.limit??100,offset=filter.offset??0;
 if(!Number.isInteger(limit)||limit<1||limit>500)throw new AuditError("limit must be within [1, 500]");
 if(!Number.isInteger(offset)||offset<0)throw new AuditError("offset must be non-negative");
 const action=filter.action?requireText(filter.action,"",100,"action"):null;
 const entity=filter.entityId??null;
 if(entity&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entity))
  throw new AuditError("entityId must be a uuid");
 const since=filter.since??null;
 if(since!==null&&Number.isNaN(since.getTime()))throw new AuditError("since must be a valid date");
 const r=await c.query<AuditEntry>(
  `SELECT id,actor,action,entity_id,payload,created_at FROM ip_audit_log
   WHERE ($1::text IS NULL OR action=$1) AND ($2::uuid IS NULL OR entity_id=$2) AND ($3::timestamptz IS NULL OR created_at>=$3)
   ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,[action,entity,since,limit,offset]);
 return r.rows;
}
