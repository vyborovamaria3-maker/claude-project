import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {formatTokenId} from "@claude-project/contracts";
import {FEATURES_V1,registerFeatureVersion,putFeatureSnapshot,queryFeaturesAsOf} from "../dist/index.js";
const url=process.env.INTELLIGENCE_TEST_DB_URL;
test("Postgres feature registry and immutable point-in-time snapshots",{skip:!url},async()=>{
  const db=new pg.Client({connectionString:url});
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query(await readFile(new URL("../migrations/003_feature_store.sql",import.meta.url),"utf8"));
    await registerFeatureVersion(db);
    await registerFeatureVersion(db);
    const token=formatTokenId("solana","So11111111111111111111111111111111111111112");
    const snap={
      canonicalTokenId:token,
      asOf:"2026-10-18T00:15:00Z",maxInputObservedAt:"2026-10-18T00:14:00Z",
      featureVersion:FEATURES_V1.version,
      features:{
        mentions_5m:1,mentions_15m:2,mentions_1h:3,unique_authors:2,unique_sources:1,
        velocity:1,acceleration:0,sentiment_bullish_ratio:null,bot_ratio:0.2,
        smart_money_bought_at:null,liquidity_usd:null,volume_24h_usd:null,
        holder_concentration:null,decoder_coverage:"swap_only",
        history_coverage:"partial",data_confidence:0.4
      }
    };
    assert.equal(await putFeatureSnapshot(db,snap),true);
    assert.equal(await putFeatureSnapshot(db,snap),false);
    await assert.rejects(putFeatureSnapshot(db,{
      ...snap,features:{...snap.features,mentions_5m:99}
    }),/snapshot conflict/);
    assert.equal(await queryFeaturesAsOf(db,token,"2026-10-18T00:13:00Z"),null);
    const row=await queryFeaturesAsOf(db,token,"2026-10-18T00:15:00Z");
    assert.equal(row.features.mentions_5m,1);
    const count=await db.query("SELECT COUNT(*) FROM chain_token_features");
    assert.equal(Number(count.rows[0].count),1);
    await db.query("ROLLBACK");
  } catch(error) {try{await db.query("ROLLBACK")}catch{} throw error}
  finally{await db.end()}
});
