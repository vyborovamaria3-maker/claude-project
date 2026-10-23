import {randomBytes,createCipheriv,createDecipheriv,createHash} from "node:crypto";
import type {PgTransaction} from "./entity-registry.js";
import {toUtcIso} from "@claude-project/contracts";

type SocialSource="x"|"tg";
type SnapshotIdentity=Readonly<{sourceSystem:SocialSource;sourceEventKind:string;eventKey:string}>;
function identity(input:SnapshotIdentity):SnapshotIdentity{
  if(!["x","tg"].includes(input.sourceSystem)||
     !/^[a-z_]{1,64}$/.test(input.sourceEventKind)||
     typeof input.eventKey!=="string"||!input.eventKey||input.eventKey.length>512)
    throw new TypeError("Invalid text snapshot identity");
  return input;
}
export function parseSnapshotEncryptionKey(encoded:string):Buffer{
  if(typeof encoded!=="string"||!new RegExp("^[A-Za-z0-9+/]{43}=$").test(encoded))
    throw new TypeError("Invalid encrypted snapshot key configuration");
  const key=Buffer.from(encoded,"base64");
  if(key.length!==32||key.toString("base64")!==encoded)
    throw new TypeError("Invalid encrypted snapshot key configuration");
  return key;
}
function aad(input:SnapshotIdentity,sha256:string):Buffer{
  return Buffer.from(JSON.stringify([input.sourceSystem,input.sourceEventKind,input.eventKey,sha256]),"utf8");
}
export function sealEventText(key:Buffer,input:SnapshotIdentity,text:string):{sha256:string;ciphertext:Buffer}{
  identity(input);
  if(!Buffer.isBuffer(key)||key.length!==32||typeof text!=="string"||!text.trim()||text.length>20_000)
    throw new TypeError("Invalid encrypted text input");
  const sha256=createHash("sha256").update(text,"utf8").digest("hex");
  const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(aad(input,sha256));
  const ciphertext=Buffer.concat([cipher.update(text,"utf8"),cipher.final()]);
  return {sha256,ciphertext:Buffer.concat([Buffer.from([1]),nonce,cipher.getAuthTag(),ciphertext])};
}
export function unsealEventText(key:Buffer,input:SnapshotIdentity,sha256:string,ciphertext:Buffer):string{
  identity(input);
  if(!Buffer.isBuffer(key)||key.length!==32||!Buffer.isBuffer(ciphertext)||ciphertext.length<29||
     ciphertext[0]!==1||!/^[a-f0-9]{64}$/.test(sha256))
    throw new TypeError("Invalid encrypted text payload");
  const decipher=createDecipheriv("aes-256-gcm",key,ciphertext.subarray(1,13));
  decipher.setAAD(aad(input,sha256));
  decipher.setAuthTag(ciphertext.subarray(13,29));
  const text=Buffer.concat([decipher.update(ciphertext.subarray(29)),decipher.final()]).toString("utf8");
  if(createHash("sha256").update(text).digest("hex")!==sha256)
    throw new Error("text_snapshot_integrity_failed");
  return text;
}
/** Ingests only ciphertext; caller must verify the exact source event revision. */
export async function storeEncryptedEventText(tx:PgTransaction,input:SnapshotIdentity&Readonly<{
  observedAt:Date|string;text:string;key:Buffer;keyRef:string;retentionDays?:number;
}>):Promise<boolean>{
  identity(input);
  const observedAt=toUtcIso(input.observedAt),days=input.retentionDays??7;
  if(!Number.isSafeInteger(days)||days<1||days>30||
     !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.keyRef))
    throw new TypeError("Invalid encrypted text retention or key reference");
  const sealed=sealEventText(input.key,input,input.text);
  const result=await tx.query(`INSERT INTO event_text_snapshots
    (source_system,source_event_kind,event_key,revision_sha256,observed_at,
     text_ciphertext,encryption_key_ref,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8::integer*INTERVAL '1 day'))
    ON CONFLICT(source_system,source_event_kind,event_key,revision_sha256) DO NOTHING
    RETURNING event_key`,[
    input.sourceSystem,input.sourceEventKind,input.eventKey,sealed.sha256,observedAt,
    sealed.ciphertext,input.keyRef,days,
  ]);
  return result.rows.length>0;
}
export async function readEncryptedEventText(tx:PgTransaction,key:Buffer,input:SnapshotIdentity&{keyRef:string}):Promise<string|null>{
  identity(input);
  const result=await tx.query(`SELECT revision_sha256,text_ciphertext,encryption_key_ref FROM event_text_snapshots
    WHERE source_system=$1 AND source_event_kind=$2 AND event_key=$3 AND purged_at IS NULL
      AND expires_at>clock_timestamp() AND available_at<=clock_timestamp()
    ORDER BY available_at DESC LIMIT 2`,[input.sourceSystem,input.sourceEventKind,input.eventKey]);
  if(result.rows.length===0)return null;
  if(result.rows.length!==1||result.rows[0]?.encryption_key_ref!==input.keyRef)
    throw new Error("text_snapshot_revision_or_key_ambiguous");
  const row=result.rows[0]!;
  return unsealEventText(key,input,String(row.revision_sha256),row.text_ciphertext as Buffer);
}
/** Expired or revoked text is destroyed, not retained in a secondary raw archive. */
export async function purgeEncryptedEventText(tx:PgTransaction,limit=100):Promise<number>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new TypeError("Invalid purge batch");
  const result=await tx.query(`WITH selected AS (
    SELECT source_system,source_event_kind,event_key,revision_sha256
    FROM event_text_snapshots WHERE expires_at<=clock_timestamp() OR purged_at IS NOT NULL
    ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
  ) DELETE FROM event_text_snapshots e USING selected s
    WHERE e.source_system=s.source_system AND e.source_event_kind=s.source_event_kind
      AND e.event_key=s.event_key AND e.revision_sha256=s.revision_sha256
    RETURNING e.event_key`,[limit]);
  return result.rows.length;
}
