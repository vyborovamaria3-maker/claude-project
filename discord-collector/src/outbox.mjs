import {
  buildEvidenceRef, buildEntityRef, buildEventEnvelopeV2, buildTimelineEvent,
  formatSourceId, toUtcIso,
} from "@claude-project/contracts";
import {emitPostgres} from "@claude-project/event-outbox";

const SCHEMA_VERSION="discord-message-v1";
const EVENT_KIND={
  observed:"discord_message_observed",
  edited:"discord_message_edited",
  deleted:"discord_message_deleted",
};

export function buildDiscordOutboxEvent(observation,emittedAt,producerVersion="0.1.0"){
  const eventKind=EVENT_KIND[observation.kind];
  if(!eventKind)throw new TypeError("Unsupported Discord outbox observation kind");
  const observedAt=toUtcIso(observation.observedAt);
  const occurredAt=observation.kind==="deleted"?undefined:toUtcIso(observation.revisionAt);
  if(observation.kind!=="deleted"&&!occurredAt)
    throw new TypeError("Discord observed/edited outbox event needs revisionAt");
  const sourceId="discord:message:"+observation.guildId+":"+observation.channelId+":"+observation.messageId;
  const eventKey=observation.kind==="edited"
    ?sourceId+":edited:"+occurredAt
    :sourceId+":"+(observation.kind==="deleted"?"deleted":"observed");
  const evidenceRef=buildEvidenceRef({
    sourceKind:"discord_message",guildId:observation.guildId,
    channelId:observation.channelId,messageId:observation.messageId,
    observedAt,...(occurredAt?{occurredAt}:{}),
    provider:"discord",parserVersion:"discord-collector-v1",
  });
  const channelRef=buildEntityRef({
    kind:"source",canonicalId:formatSourceId("discord",observation.channelId),
    firstSeenAt:observedAt,lastSeenAt:observedAt,
  });
  const registryEvent={
    sourceSystem:"discord",eventKind,eventKey,schemaVersion:SCHEMA_VERSION,
    entityRefs:[channelRef],evidenceRef,
  };
  const timelineEvent=observation.kind==="deleted"?undefined:buildTimelineEvent({
    eventKey,kind:eventKind,occurredAt,observedAt,
    entityRefs:[channelRef],evidenceRef,payload:{},
  });
  const discordMessage=observation.kind==="deleted"
    ?{guildId:observation.guildId,channelId:observation.channelId,messageId:observation.messageId}
    :{guildId:observation.guildId,channelId:observation.channelId,
      messageId:observation.messageId,revisionAt:occurredAt};
  const payload={
    registryEvent,
    ...(timelineEvent?{timelineEvent}:{}),
    discordMessage,
  };
  const envelope=buildEventEnvelopeV2({
    sourceSystem:"discord",eventKind,eventKey,schemaVersion:SCHEMA_VERSION,
    producer:{name:"discord-collector",version:producerVersion},
    clocks:{occurredAt:occurredAt??null,observedAt,emittedAt:toUtcIso(emittedAt)},
    entityRefs:[{kind:"source",canonicalId:channelRef.canonicalId}],
    evidenceRefs:[evidenceRef],
    payload,
  });
  return {sourceSystem:"discord",eventKind,eventKey,schemaVersion:SCHEMA_VERSION,payload:envelope};
}

/** Called with the SAME PostgreSQL transaction as discord_messages/revisions. */
export async function emitDiscordOutbox(client,observation){
  const clock=await client.query("SELECT clock_timestamp() AS emitted_at");
  const emittedAt=toUtcIso(clock.rows[0]?.emitted_at);
  const event=buildDiscordOutboxEvent(
    observation,emittedAt,process.env.DISCORD_COLLECTOR_VERSION||"0.1.0",
  );
  await emitPostgres(client,event,emittedAt);
}
