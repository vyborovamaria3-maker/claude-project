"use strict";
// Deterministic, offline, transaction-level reconciliation of *observed* fee evidence.
// Never mutates collector input or canonical PnL. No SQLite SUM of large integers.
function decimal(value) {
  if (typeof value !== "string" || !/^\d{1,40}$/.test(value)) throw new Error("Invalid atomic fee amount");
  return BigInt(value);
}
function reconcile(rows, fields, amountField = "amount_atomic") {
  if (!rows.length) throw new Error("Empty fee observation group");
  const first = rows[0];
  const same = rows.every(row => fields.every(field => row[field] === first[field])
    && decimal(row[amountField]) === decimal(first[amountField]));
  if (!same) return { status: "CONFLICT", reason: "observed_fee_disagreement", value: null };
  if (typeof first.payer !== "string" || !first.payer.trim() || !Number.isSafeInteger(first.slot) || first.slot < 0) {
    return { status: "PARTIAL", reason: "missing_fee_payer_or_slot", value: null };
  }
  return { status: "OBSERVED_CONSISTENT", reason: "matching_raw_observations_not_finality_proof", value: first };
}
function buildFeeRollups(db) {
  // Tables live only in the isolated output database. They contain no estimates.
  db.exec(`CREATE TABLE fee_network_consensus(
    signature TEXT PRIMARY KEY, observation_count INTEGER NOT NULL,
    distinct_raw_hashes INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
    payer TEXT, slot INTEGER, network_fee_lamports TEXT
  );
  CREATE TABLE fee_payer_observed_totals(
    payer TEXT PRIMARY KEY, unique_signatures INTEGER NOT NULL, network_fee_lamports TEXT NOT NULL
  );
  CREATE TABLE fee_transfer_consensus(
    signature TEXT NOT NULL, event_key TEXT NOT NULL, observation_count INTEGER NOT NULL,
    status TEXT NOT NULL, reason TEXT NOT NULL,
    fee_kind TEXT, payer TEXT, recipient TEXT, service_id TEXT,
    amount_lamports TEXT, PRIMARY KEY(signature,event_key)
  );`);
  const blockedSignatures = new Set(db.prepare(
    "SELECT DISTINCT signature FROM fee_invalid_observations").all().map(r=>r.signature));
  const balanceMismatches = new Set(db.prepare(
    "SELECT DISTINCT signature FROM fee_balance_evidence WHERE balance_status='MISMATCH'"
  ).all().map(r=>r.signature));
  const netGroups = new Map();
  const transfers = new Map();
  const iter = db.prepare(`SELECT signature,event_key,fee_kind,payer,recipient,service_id,amount_atomic,
    slot,raw_sha256,classification_status,asset,economic_role
    FROM fee_evidence ORDER BY signature,event_key,target_kind,target_address,raw_revision`);
  for (const row of iter.iterate()) {
    if (row.fee_kind === "network_total" && row.event_key === "network") {
      const list = netGroups.get(row.signature) || [];
      list.push(row);netGroups.set(row.signature,list);
    } else if (row.fee_kind === "jito_tip_candidate" || row.fee_kind === "service_fee_candidate") {
      const key = JSON.stringify([row.signature,row.event_key]);
      const list = transfers.get(key) || [];
      list.push(row);transfers.set(key,list);
    }
  }
  const insertNet = db.prepare(`INSERT INTO fee_network_consensus
    (signature,observation_count,distinct_raw_hashes,status,reason,payer,slot,network_fee_lamports)
    VALUES(?,?,?,?,?,?,?,?)`);
  const insertPayer = db.prepare(`INSERT INTO fee_payer_observed_totals
    (payer,unique_signatures,network_fee_lamports) VALUES(?,?,?)`);
  const insertTransfer = db.prepare(`INSERT INTO fee_transfer_consensus
    (signature,event_key,observation_count,status,reason,fee_kind,payer,recipient,service_id,amount_lamports)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const totals = new Map();
  const networkStatuses = new Map();
  const stats = { networkSignatures:0, networkConsistent:0, networkPartial:0,
    networkConflicts:0, networkWithheld:0, candidateTransferGroups:0, candidateConsistent:0, candidateConflicts:0 };
  db.transaction(() => {
    for (const [signature, group] of netGroups) {
      const hashes = new Set(group.map(r => r.raw_sha256));
      const legitimate = group.every(r => r.classification_status === "EXACT_ONCHAIN"
        && r.asset === "SOL" && r.economic_role === "INDEPENDENT");
      const c = blockedSignatures.has(signature)
        ? {status:"WITHHELD",reason:"invalid_raw_observation_for_signature",value:null}
        : balanceMismatches.has(signature)
        ? {status:"WITHHELD",reason:"native_balance_conservation_mismatch",value:null}
        : legitimate ? reconcile(group,["payer","slot","asset","fee_kind","economic_role"])
        : {status:"CONFLICT",reason:"invalid_network_evidence_role",value:null};
      stats.networkSignatures++;
      networkStatuses.set(signature,c.status);
      if (c.status==="OBSERVED_CONSISTENT") {
        stats.networkConsistent++;
        const payer=c.value.payer, amount=decimal(c.value.amount_atomic);
        const t=totals.get(payer)||{n:0,amount:0n};
        t.n++;t.amount+=amount;totals.set(payer,t);
      } else if(c.status==="PARTIAL")stats.networkPartial++;
      else if(c.status==="WITHHELD")stats.networkWithheld++;
      else stats.networkConflicts++;
      insertNet.run(signature,group.length,hashes.size,c.status,c.reason,
        c.value?.payer || null,c.value?.slot ?? null,c.value?.amount_atomic || null);
    }
    for (const [payer,t] of totals) insertPayer.run(payer,t.n,t.amount.toString());
    for (const [rawKey,group] of transfers) {
      const [signature,eventKey]=JSON.parse(rawKey);
      const legitimate=group.every(r=>r.classification_status==="CANDIDATE"
        && r.asset==="SOL" && r.economic_role==="INDEPENDENT");
      const networkStatus = networkStatuses.get(signature);
      let c = blockedSignatures.has(signature)
        ?{status:"WITHHELD",reason:"invalid_raw_observation_for_signature",value:null}
        :balanceMismatches.has(signature)
        ?{status:"WITHHELD",reason:"native_balance_conservation_mismatch",value:null}
        :networkStatus!=="OBSERVED_CONSISTENT"
        ?{status:"WITHHELD",reason:"network_evidence_not_consistent",value:null}
        :group.length !== (netGroups.get(signature)?.length||0)
        ?{status:"PARTIAL",reason:"candidate_missing_from_some_raw_observations",value:null}
        :legitimate?reconcile(group,["fee_kind","payer","recipient","service_id","slot"])
        :{status:"CONFLICT",reason:"invalid_candidate_evidence_role",value:null};
      // Matching transfers remain candidate observations, not verified service fees.
      if(c.status==="OBSERVED_CONSISTENT") c={...c,status:"CANDIDATE_CONSISTENT"};
      stats.candidateTransferGroups++;
      if(c.status==="CANDIDATE_CONSISTENT")stats.candidateConsistent++;
      else if(c.status==="CONFLICT")stats.candidateConflicts++;
      insertTransfer.run(signature,eventKey,group.length,c.status,c.reason,
        c.value?.fee_kind||null,c.value?.payer||null,c.value?.recipient||null,c.value?.service_id||null,
        c.value?.amount_atomic||null);
    }
  })();
  return stats;
}
module.exports={decimal,reconcile,buildFeeRollups};
