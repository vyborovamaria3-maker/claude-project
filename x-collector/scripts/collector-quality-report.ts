import { closePool } from "../lib/trade/pg";
import { collectorQualitySnapshot } from "../src/collector/monitoring";
collectorQualitySnapshot().then(snapshot=>{
  console.log(JSON.stringify(snapshot,null,2));
}).catch(()=>{
  console.error("Collector quality report unavailable. Apply migrations and check PostgreSQL.");
  process.exitCode=1;
}).finally(()=>closePool());
