import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const mode = args[0] || 'holdings';

const map = {
  holdings: ['portfolio', 'holdings', '--chain', 'sol', '--wallet', process.env.GMGN_WALLET || '<wallet_address>'],
  stats: ['portfolio', 'stats', '--chain', 'sol', '--wallet', process.env.GMGN_WALLET || '<wallet_address>', '--period', '30d'],
  activity: ['portfolio', 'activity', '--chain', 'sol', '--wallet', process.env.GMGN_WALLET || '<wallet_address>'],
  'token-balance': ['portfolio', 'token-balance', '--chain', 'sol', '--wallet', process.env.GMGN_WALLET || '<wallet_address>', '--token', process.env.GMGN_TOKEN || '<token_address>'],
  'created-tokens': ['portfolio', 'created-tokens', '--chain', 'sol', '--wallet', process.env.GMGN_WALLET || '<wallet_address>', '--order-by', 'token_ath_mc'],
  'follow-wallet': ['track', 'follow-wallet', '--chain', 'sol'],
  'follow-tokens': ['track', 'follow-tokens', '--chain', 'sol', '--wallet', process.env.GMGN_WALLET || '<wallet_address>'],
  smartmoney: ['track', 'smartmoney', '--chain', 'sol'],
  kol: ['track', 'kol', '--chain', 'sol'],
};

const gmgnArgs = map[mode];
if (!gmgnArgs) {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

const result = spawnSync('gmgn-cli', gmgnArgs, { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);

