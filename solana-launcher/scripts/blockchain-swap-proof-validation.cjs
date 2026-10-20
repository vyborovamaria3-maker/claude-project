"use strict";
/**
 * ARCH-06b2a: OFFLINE validation of externally supplied Solana RPC receipts.
 * Does not call RPC, change the source DB, emit a verified event, or assert
 * cryptographic finality, mint existence at swap time, trades or PnL.
 *
 * Caller MUST bind a response to the exact request and trusted endpoint.
 * These checks can establish only what that endpoint REPORTED at probe time.
 */
const {decodedBytes}=require("./blockchain-intelligence-outbox.cjs");
const TOKEN_PROGRAM="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MAX_MINT_BYTES=64*1024;
const fail=reason=>({status:"insufficient_evidence",reason});

function sourceIdentity(event){
  if(!event||event.sourceSystem!=="blockchain"||
    event.eventKind!=="token_swap_evidence_revision"||
    event.schemaVersion!=="chain-token-revision-v1"||
    event.payload?.timelineEvent!==undefined)throw new TypeError("Not a Blockchain revision event");
  const proof=event.payload?.swapRevision;
  const registry=event.payload?.registryEvent;
  if(!proof||proof.status!=="supported"||
    typeof proof.walletId!=="string"||!proof.walletId.startsWith("solana:")||
    typeof proof.canonicalTokenId!=="string"||!proof.canonicalTokenId.startsWith("solana:")||
    decodedBytes(proof.walletId.slice(7))!==32||
    decodedBytes(proof.canonicalTokenId.slice(7))!==32||
    decodedBytes(proof.signature)!==64||
    !Number.isSafeInteger(proof.slot)||proof.slot<=0||
    !Number.isSafeInteger(proof.rawRevision)||proof.rawRevision<1||
    typeof proof.rawSha256!=="string"||!/^[a-f0-9]{64}$/.test(proof.rawSha256))
    throw new TypeError("Revision does not contain attributable supported evidence");
  const key="chain:wallet:"+proof.walletId.slice(7)+":signature:"+proof.signature+
    ":raw-revision:"+proof.rawRevision+":sha256:"+proof.rawSha256+":parser:1";
  if(event.eventKey!==key||
    registry?.eventKey!==key||
    registry?.eventKind!==event.eventKind||
    registry?.sourceSystem!=="blockchain"||
    registry?.schemaVersion!==event.schemaVersion||
    registry?.evidenceRef?.sourceId!=="chain:tx:solana:"+proof.signature||
    registry?.evidenceRef?.parserVersion!=="chain-swap-revision-1"||
    registry?.entityRefs?.length!==1||
    registry.entityRefs[0]?.canonicalId!==proof.walletId)
    throw new TypeError("Unbound or inconsistent revision identity");
  return proof;
}

function buildVerificationPlan(event){
  const proof=sourceIdentity(event);
  return {
    signature:{
      method:"getSignatureStatuses",
      params:[[proof.signature],{searchTransactionHistory:true}],
    },
    mint:{
      method:"getAccountInfo",
      params:[proof.canonicalTokenId.slice(7),{
        commitment:"finalized",encoding:"base64",minContextSlot:proof.slot,
      }],
    },
  };
}

function parseMintAccount(account){
  if(!account||typeof account!=="object"||Array.isArray(account))
    return fail("mint_account_missing");
  if(account.executable!==false||
     !Number.isSafeInteger(account.lamports)||account.lamports<=0)
    return fail("mint_account_not_usable");
  if(account.owner!==TOKEN_PROGRAM&&account.owner!==TOKEN_2022_PROGRAM)
    return fail("mint_wrong_program_owner");
  const data=account.data;
  if(!Array.isArray(data)||data.length!==2||data[1]!=="base64"||
    typeof data[0]!=="string"||data[0].length>Math.ceil(MAX_MINT_BYTES/3)*4+8||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data[0]))
    return fail("mint_data_not_canonical_base64");
  const bytes=Buffer.from(data[0],"base64");
  if(bytes.toString("base64")!==data[0]||bytes.length>MAX_MINT_BYTES||
     !Number.isSafeInteger(account.space)||account.space!==bytes.length)
    return fail("mint_data_size_mismatch");
  const is2022=account.owner===TOKEN_2022_PROGRAM;
  if(bytes.length!==82 && (!is2022||bytes.length<166))
    return fail("mint_wrong_base_length");
  if(bytes.readUInt32LE(0)>1||bytes.readUInt32LE(46)>1||bytes[45]!==1)
    return fail("mint_base_layout_invalid");
  if(is2022&&bytes.length>82){
    // Token-2022 Mint (not a Token Account) is zero-padded to 165; its
    // account-type discriminator at offset 165 MUST equal Mint (1).
    if(bytes.subarray(82,165).some(x=>x!==0)||bytes[165]!==1)
      return fail("token_2022_not_mint");
    let p=166;
    const seen=new Set();
    while(p<bytes.length){
      if(bytes.subarray(p).every(x=>x===0))break;
      if(p+4>bytes.length)return fail("token_2022_truncated_tlv");
      const type=bytes.readUInt16LE(p),length=bytes.readUInt16LE(p+2);
      if(type===0||seen.has(type)||p+4+length>bytes.length)
        return fail("token_2022_malformed_tlv");
      seen.add(type);p+=4+length;
    }
  }
  return {status:"mint_account_layout_supported",
    program:is2022?"spl-token-2022":"spl-token"};
}

function verifyOfflineSwapProof(event,receipts){
  const plan=buildVerificationPlan(event);
  const revision=sourceIdentity(event);
  if(!receipts||typeof receipts!=="object"||Array.isArray(receipts))
    return fail("no_rpc_receipts");
  // Exact request binding is mandatory: responses without a traceable
  // request are not independent evidence. Endpoint authentication/cluster
  // attestation still belongs to the future trusted RPC acquisition layer.
  if(JSON.stringify(receipts.signatureRequest)!==JSON.stringify(plan.signature))
    return fail("wrong_signature_request");
  if(JSON.stringify(receipts.mintRequest)!==JSON.stringify(plan.mint))
    return fail("wrong_mint_request");
  const sr=receipts.signatureResponse?.result;
  if(!sr||!Number.isSafeInteger(sr.context?.slot)||
    sr.context.slot<revision.slot||
    !Array.isArray(sr.value)||sr.value.length!==1||!sr.value[0])
    return fail("signature_status_unavailable");
  const status=sr.value[0];
  if(status.err!==null)return fail("signature_failed_or_unknown_error");
  // Solana exposes BOTH err and the legacy Result-shaped status field.
  // A contradictory/missing status is untrustworthy, not finalized proof.
  if(!status.status||typeof status.status!=="object"||
     Array.isArray(status.status)||
     Object.keys(status.status).length!==1||
     !Object.hasOwn(status.status,"Ok")||status.status.Ok!==null)
    return fail("signature_status_fields_disagree");
  if(status.confirmationStatus!=="finalized")
    return fail("transaction_not_reported_finalized");
  if(status.slot!==revision.slot)
    return fail("transaction_slot_mismatch");
  const mr=receipts.mintResponse?.result;
  if(!mr||!Number.isSafeInteger(mr.context?.slot)||
    mr.context.slot<revision.slot)
    return fail("mint_read_context_too_old");
  const result=parseMintAccount(mr.value);
  if(result.status!=="mint_account_layout_supported")return result;
  // No claim that the mint existed AT revision.slot: this is a later
  // finalized account snapshot, not a historical state proof.
  return {
    status:"rpc_reported_finalized_tx_and_current_mint",
    signature:revision.signature,mint:revision.canonicalTokenId,
    sourceRawRevision:revision.rawRevision,
    sourceRawSha256:revision.rawSha256,
    transactionSlot:revision.slot,
    transactionStatusContextSlot:sr.context.slot,
    mintAccountContextSlot:mr.context.slot,
    mintProgram:result.program,
    limits:[
      "rpc_response_not_cryptographic_attestation",
      "current_mint_account_not_mint_state_at_transaction_slot",
      "not_a_verified_trade_or_pnl",
    ],
  };
}
module.exports={TOKEN_PROGRAM,TOKEN_2022_PROGRAM,
  buildVerificationPlan,parseMintAccount,verifyOfflineSwapProof};
