import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const mode = args[0] || 'trending';

const map = {
  trending: ['market', 'trending', '--chain', 'sol', '--interval', '5m'],
  'hot-searches': ['market', 'hot-searches', '--interval', '5m', '--raw'],
  'trenches-new': ['market', 'trenches', '--chain', 'sol', '--type', 'new_creation'],
  'trenches-completed': ['market', 'trenches', '--chain', 'sol', '--type', 'completed'],
  'trenches-near-completion': ['market', 'trenches', '--chain', 'sol', '--type', 'near_completion'],
  signals: ['market', 'signal', '--chain', 'sol', '--signal-type', '13'],
};

const gmgnArgs = map[mode];
if (!gmgnArgs) {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

const result = spawnSync('gmgn-cli', gmgnArgs, { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
