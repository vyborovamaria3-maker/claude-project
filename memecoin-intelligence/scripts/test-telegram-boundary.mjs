import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const protectedRoots = [
  'src/server/xanalysis',
  'src/server/providers',
  'src/server/services/analysisService.ts',
  'src/server/services/ingestionService.ts',
];
const violations = [];

async function walk(target) {
  const stat = await import('node:fs/promises').then(({ stat }) => stat(target));
  if (stat.isFile()) {
    const text = await readFile(target, 'utf8');
    if (/telegram-ai|TELEGRAM_AI|Qwen/i.test(text)) violations.push(target);
    return;
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isDirectory() || /\.(ts|tsx|js|mjs)$/.test(entry.name)) await walk(path.join(target, entry.name));
  }
}

for (const root of protectedRoots) await walk(root);
if (violations.length) {
  console.error(`Telegram AI boundary violation:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('Telegram AI boundary OK: X analysis has no Qwen dependency');
