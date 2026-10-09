import { runMonitoringCycle } from "../lib/trade/graph-monitoring";
import { closePool } from "../lib/trade/pg";

runMonitoringCycle().then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => closePool());
