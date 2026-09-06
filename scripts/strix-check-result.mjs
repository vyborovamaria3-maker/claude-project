import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`[strix] ERROR: ${message}`);
  process.exit(1);
}

const runJsonPath = process.argv[2];
const budgetArg = process.argv[3];

if (!runJsonPath) {
  fail('usage: node scripts/strix-check-result.mjs <run.json> [max-budget-usd]');
}

if (!fs.existsSync(runJsonPath)) {
  fail(`run.json not found: ${runJsonPath}`);
}

let run;
try {
  run = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
} catch (error) {
  fail(`cannot parse ${runJsonPath}: ${error.message}`);
}

const status = typeof run.status === 'string' ? run.status : 'unknown';
const rawCost = run?.llm_usage?.cost;
const cost = Number.isFinite(Number(rawCost)) ? Number(rawCost) : 0;
const budget = budgetArg === undefined ? null : Number(budgetArg);

console.log(`[strix] run: ${path.resolve(runJsonPath)}`);
console.log(`[strix] status: ${status}`);
console.log(`[strix] reported LLM cost: $${cost.toFixed(4)}`);

if (status !== 'completed') {
  fail(`scan did not complete (status=${status}); refusing to treat a partial run as clean`);
}

if (budget !== null) {
  if (!Number.isFinite(budget) || budget <= 0) {
    fail(`invalid max budget: ${budgetArg}`);
  }

  const ratio = cost / budget;
  if (ratio >= 0.9) {
    console.warn(
      `[strix] WARNING: reported cost used ${(ratio * 100).toFixed(1)}% of the configured budget; review report coverage before accepting a clean result`,
    );
  }
}

const reportDir = path.dirname(runJsonPath);
const vulnerabilitiesPath = path.join(reportDir, 'vulnerabilities.json');
if (fs.existsSync(vulnerabilitiesPath)) {
  try {
    const vulnerabilities = JSON.parse(fs.readFileSync(vulnerabilitiesPath, 'utf8'));
    let count = null;

    if (Array.isArray(vulnerabilities)) {
      count = vulnerabilities.length;
    } else if (Array.isArray(vulnerabilities?.vulnerabilities)) {
      count = vulnerabilities.vulnerabilities.length;
    } else if (Array.isArray(vulnerabilities?.findings)) {
      count = vulnerabilities.findings.length;
    }

    if (count !== null) {
      console.log(`[strix] structured findings: ${count}`);
    }
  } catch (error) {
    console.warn(`[strix] WARNING: cannot parse vulnerabilities.json: ${error.message}`);
  }
}

console.log('[strix] completed run verified.');
