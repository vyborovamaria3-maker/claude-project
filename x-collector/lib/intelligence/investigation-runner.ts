import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import {recordAudit} from "./audit-log";

type Client=Pick<PoolClient,"query">;

export const STEP_KINDS=["OBSERVATION","HYPOTHESIS","EVIDENCE","CONCLUSION","TASK"] as const;
export type StepKind=(typeof STEP_KINDS)[number];

export const INVESTIGATION_STATUSES=["OPEN","ACTIVE","CLOSED","ARCHIVED"] as const;
export type InvestigationStatus=(typeof INVESTIGATION_STATUSES)[number];

export const INVESTIGATION_PRIORITIES=["NORMAL","IMPORTANT","URGENT"] as const;
export type InvestigationPriority=(typeof INVESTIGATION_PRIORITIES)[number];

export class InvestigationError extends Error{
 readonly status:number;
 constructor(message:string,status=400){
  super(message);this.status=status;
 }
}

export type Investigation={
 id:string;
 subject_entity_id:string|null;
 title:string;
 status:InvestigationStatus;
 priority:InvestigationPriority;
 hypothesis:string;
 summary:string;
 created_by:string;
 created_at:Date;
 updated_at:Date;
 started_at:Date|null;
 closed_at:Date|null;
};

export type InvestigationStep={
 id:string;
 investigation_id:string;
 kind:StepKind;
 content:string;
 source_event_id:string|null;
 entity_id:string|null;
 confidence:number;
 created_at:Date;
};

export type OpenInvestigationInput={
 title:string;
 subjectEntityId?:string|null;
 hypothesis?:string;
 priority?:InvestigationPriority;
 createdBy?:string;
};

export type AppendStepInput={
 kind:StepKind;
 content:string;
 sourceEventId?:string|null;
 entityId?:string|null;
 confidence?:number;
};

export type InvestigationFilter={
 status?:InvestigationStatus;
 subjectEntityId?:string;
 limit?:number;
 offset?:number;
};

function requireTitle(title:string):string{
 const trimmed=(title??"").trim();
 if(!trimmed)throw new InvestigationError("Investigation requires a title");
 if(trimmed.length>300)throw new InvestigationError("Investigation title is too long");
 return trimmed;
}

function requireStepKind(kind:string):StepKind{
 if(!(STEP_KINDS as readonly string[]).includes(kind))throw new InvestigationError(`Unknown step kind ${JSON.stringify(kind)}`);
 return kind as StepKind;
}

function requireStatus(status:string):InvestigationStatus{
 if(!(INVESTIGATION_STATUSES as readonly string[]).includes(status))throw new InvestigationError(`Unknown status ${JSON.stringify(status)}`);
 return status as InvestigationStatus;
}

function requirePriority(priority:string):InvestigationPriority{
 if(!(INVESTIGATION_PRIORITIES as readonly string[]).includes(priority))throw new InvestigationError(`Unknown priority ${JSON.stringify(priority)}`);
 return priority as InvestigationPriority;
}

async function existingEntity(c:Client,id:string):Promise<boolean>{
 const r=await c.query<{id:string}>("SELECT id FROM ip_entities WHERE id=$1",[id]);
 return r.rows.length>0;
}

async function existingEvent(c:Client,id:string):Promise<boolean>{
 const r=await c.query<{id:string}>("SELECT id FROM ip_raw_events WHERE id=$1",[id]);
 return r.rows.length>0;
}

async function loadInvestigation(c:Client,id:string):Promise<Investigation>{
 const r=await c.query<Investigation>("SELECT * FROM ip_investigations WHERE id=$1",[id]);
 const row=r.rows[0];
 if(!row)throw new InvestigationError("Investigation not found",404);
 return row;
}

export async function openInvestigation(c:Client,input:OpenInvestigationInput):Promise<Investigation>{
 const title=requireTitle(input.title);
 const priority=requirePriority(input.priority??"NORMAL");
 const subject=input.subjectEntityId??null;
 if(subject&&!(await existingEntity(c,subject)))throw new InvestigationError("Subject entity does not exist",404);
 const id=randomUUID();
 const r=await c.query<Investigation>(
  `INSERT INTO ip_investigations(id,subject_entity_id,title,status,priority,hypothesis,created_by)
   VALUES($1,$2,$3,'OPEN',$4,$5,$6) RETURNING *`,
  [id,subject,title,priority,input.hypothesis??"",input.createdBy??"agent"]);
 const row=r.rows[0];
 await recordAudit(c,{action:"investigation.open",actor:input.createdBy,entityId:subject,payload:{id:row.id,title,priority}});
 return row;
}

export async function appendStep(c:Client,investigationId:string,input:AppendStepInput):Promise<InvestigationStep>{
 const investigation=await loadInvestigation(c,investigationId);
 if(investigation.status==="CLOSED"||investigation.status==="ARCHIVED")
  throw new InvestigationError(`Cannot append to a ${investigation.status} investigation`,409);
 const kind=requireStepKind(input.kind);
 const content=(input.content??"").trim();
 if(!content)throw new InvestigationError("Step requires content");
 const confidence=input.confidence??1;
 if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new InvestigationError("Confidence must be within [0, 1]");
 const sourceEvent=input.sourceEventId??null;
 if(kind==="EVIDENCE"&&!sourceEvent)throw new InvestigationError("EVIDENCE steps require sourceEventId");
 if(sourceEvent&&!(await existingEvent(c,sourceEvent)))
  throw new InvestigationError("Evidence raw event does not exist",404);
 const entity=input.entityId??null;
 if(entity&&!(await existingEntity(c,entity)))throw new InvestigationError("Step entity does not exist",404);
 const id=randomUUID();
 const r=await c.query<InvestigationStep>(
  `INSERT INTO ip_investigation_steps(id,investigation_id,kind,content,source_event_id,entity_id,confidence)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,investigation_id,kind,content,source_event_id,entity_id,confidence,created_at`,
  [id,investigationId,kind,content,sourceEvent,entity,confidence]);
 const step=r.rows[0];
 await c.query(
  `UPDATE ip_investigations SET status=CASE WHEN status='OPEN' THEN 'ACTIVE' ELSE status END,updated_at=now(),started_at=COALESCE(started_at,now()) WHERE id=$1`,
  [investigationId]);
 await recordAudit(c,{action:"investigation.step",entityId:entity,payload:{investigation_id:investigationId,kind,step_id:step.id}});
 return step;
}

export async function getInvestigation(c:Client,id:string):Promise<{investigation:Investigation;steps:InvestigationStep[]}>{
 const investigation=await loadInvestigation(c,id);
 const steps=await c.query<InvestigationStep>(
  `SELECT id,investigation_id,kind,content,source_event_id,entity_id,confidence,created_at
   FROM ip_investigation_steps WHERE investigation_id=$1 ORDER BY created_at,id`,[id]);
 return{investigation,steps:steps.rows};
}

export async function listInvestigations(c:Client,filter:InvestigationFilter={}):Promise<Investigation[]>{
 const limit=filter.limit??50,offset=filter.offset??0;
 if(!Number.isInteger(limit)||limit<1||limit>200)throw new InvestigationError("limit must be within [1, 200]");
 if(!Number.isInteger(offset)||offset<0)throw new InvestigationError("offset must be non-negative");
 const status=filter.status?requireStatus(filter.status):null;
 const subject=filter.subjectEntityId??null;
 if(subject&&!(await existingEntity(c,subject)))throw new InvestigationError("Subject entity does not exist",404);
 const r=await c.query<Investigation>(
  `SELECT * FROM ip_investigations
   WHERE ($1::text IS NULL OR status=$1) AND ($2::uuid IS NULL OR subject_entity_id=$2)
   ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,[status,subject,limit,offset]);
 return r.rows;
}

export async function closeInvestigation(c:Client,id:string,summary:string,status:InvestigationStatus="CLOSED"):Promise<Investigation>{
 const investigation=await loadInvestigation(c,id);
 requireStatus(status);
 if(status!=="CLOSED"&&status!=="ARCHIVED")throw new InvestigationError("Investigations can only be closed as CLOSED or ARCHIVED");
 if(investigation.status==="CLOSED"||investigation.status==="ARCHIVED")
  throw new InvestigationError(`Investigation is already ${investigation.status}`,409);
 const text=(summary??"").trim();
 if(!text)throw new InvestigationError("Closing an investigation requires a summary");
 const r=await c.query<Investigation>(
  `UPDATE ip_investigations SET status=$2,summary=$3,started_at=COALESCE(started_at,now()),closed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,
  [id,status,text]);
 const closed=r.rows[0];
 await recordAudit(c,{action:"investigation.close",entityId:investigation.subject_entity_id,payload:{id,status:closed.status}});
 return closed;
}

export type InvestigationReport={
 investigation:Investigation;
 steps:InvestigationStep[];
 observations:string[];
 evidenceEvents:string[];
};

export type RunInvestigationOptions={
 title?:string;
 hypothesis?:string;
 priority?:InvestigationPriority;
 createdBy?:string;
 maxEvidence?:number;
};

export async function runInvestigation(
 c:Client,
 subjectEntityId:string,
 options:RunInvestigationOptions={},
):Promise<InvestigationReport>{
 if(!(await existingEntity(c,subjectEntityId)))throw new InvestigationError("Subject entity does not exist",404);
 const maxEvidence=options.maxEvidence??5;
 if(!Number.isInteger(maxEvidence)||maxEvidence<0||maxEvidence>50)
  throw new InvestigationError("maxEvidence must be within [0, 50]");

 const [relations,profile,clusters]=await Promise.all([
  c.query<{relation_type:string;count:string;peers:string[]}>(
   `SELECT r.relation_type,count(*)::text count,array_agg(DISTINCT e.name ORDER BY e.name) peers
    FROM ip_entity_relations r JOIN ip_entities e
      ON e.id=CASE WHEN r.source_entity_id=$1 THEN r.target_entity_id ELSE r.source_entity_id END
    WHERE (r.source_entity_id=$1 OR r.target_entity_id=$1) AND r.valid_to IS NULL
    GROUP BY r.relation_type ORDER BY r.relation_type`,[subjectEntityId]),
  c.query<{influence_score:number|null;risk_score:number|null;metadata:Record<string,unknown>}>(
   "SELECT influence_score,risk_score,metadata FROM ip_entity_profiles WHERE entity_id=$1",[subjectEntityId]),
  c.query<{cluster_id:string}>(
   `SELECT m.cluster_id FROM ip_cluster_members m JOIN ip_graph_clusters c ON c.id=m.cluster_id
    WHERE m.entity_id=$1 ORDER BY c.computed_at DESC NULLS LAST,m.cluster_id`,[subjectEntityId]),
 ]);
 const evidenceRows=maxEvidence>0
  ?(await c.query<{id:string;source:string;event_type:string;external_id:string;collected_at:Date;relation_type:string}>(
    `SELECT DISTINCT ON (r.source_event_id) r.source_event_id id,raw.source,raw.event_type,raw.external_id,raw.collected_at,r.relation_type
     FROM ip_entity_relations r JOIN ip_raw_events raw ON raw.id=r.source_event_id
     WHERE (r.source_entity_id=$1 OR r.target_entity_id=$1) AND r.valid_to IS NULL
     ORDER BY r.source_event_id,raw.collected_at DESC LIMIT $2`,[subjectEntityId,maxEvidence])).rows
  :[];
 const profileRow=profile.rows[0]??null;
 const observations:string[]=[
  `active_relations=${relations.rows.length}`,
  relations.rows.map((row)=>`${row.relation_type}:${row.count}`).join(",")||"no active relations",
  profileRow
   ? `profile risk=${profileRow.risk_score??"n/a"} influence=${profileRow.influence_score??"n/a"}`
   : "no profile",
  clusters.rows.length?`clusters=${clusters.rows.map((row)=>row.cluster_id).join(",")}`:"no cluster membership",
  `evidence_events=${evidenceRows.length}`,
 ];

 const subject=await c.query<{name:string;type:string;platform:string;external_id:string}>(
  "SELECT name,type,platform,external_id FROM ip_entities WHERE id=$1",[subjectEntityId]);
 const subjectRow=subject.rows[0];
 const investigation=await openInvestigation(c,{
  title:options.title??`Investigation: ${subjectRow?.name??subjectEntityId}`,
  subjectEntityId,
  hypothesis:options.hypothesis??"",
  priority:options.priority,
  createdBy:options.createdBy??"agent",
 });

 const steps:InvestigationStep[]=[];
 const record=async(input:AppendStepInput)=>{
  steps.push(await appendStep(c,investigation.id,{...input,entityId:input.entityId??subjectEntityId}));
 };
 await record({
  kind:"OBSERVATION",
  content:`subject=${subjectRow?.type??"?"} ${subjectRow?.platform??"?"}/${subjectRow?.external_id??"?"}`,
  confidence:1,
 });
 for(const observation of observations)await record({kind:"OBSERVATION",content:observation,confidence:1});
 for(const row of relations.rows){
  const peers=row.peers.filter(Boolean).slice(0,5);
  await record({kind:"OBSERVATION",content:`${row.relation_type} peers sample: ${peers.join(", ")||"unknown"}`,confidence:1});
 }
 const evidenceEvents:string[]=[];
 for(const row of evidenceRows){
  await record({
   kind:"EVIDENCE",
   content:`${row.source} ${row.event_type} ${row.external_id} via ${row.relation_type}`,
   sourceEventId:row.id,
   confidence:1,
  });
  evidenceEvents.push(row.id);
 }
 const summary=`subject=${subjectEntityId} relations=${relations.rows.length} evidence=${evidenceEvents.length} clusters=${clusters.rows.length}`;
 await record({kind:"CONCLUSION",content:summary,confidence:1});
 await closeInvestigation(c,investigation.id,summary);

 return{investigation:await loadInvestigation(c,investigation.id),steps,observations,evidenceEvents};
}
