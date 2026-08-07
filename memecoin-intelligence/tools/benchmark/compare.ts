import { readFileSync } from 'node:fs';
const [baselinePath, currentPath] = process.argv.slice(2);
if (!baselinePath || !currentPath) throw new Error('Usage: tsx tools/benchmark/compare.ts baseline.json current.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const current = JSON.parse(readFileSync(currentPath, 'utf8'));
const change = (before: number, after: number) => before ? Number((((after - before) / before) * 100).toFixed(2)) : null;
console.log(JSON.stringify({
  featureRowsPerSecondChangePercent: change(baseline.throughput.featureRowsPerSecond, current.throughput.featureRowsPerSecond),
  networkDurationChangePercent: change(baseline.timingsMs.network, current.timingsMs.network),
  rssChangePercent: change(baseline.memory.rssBytes, current.memory.rssBytes),
}, null, 2));
