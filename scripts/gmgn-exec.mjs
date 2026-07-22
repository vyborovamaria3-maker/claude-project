import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const mode = args[0] || 'swap';

const wallet = process.env.GMGN_WALLET || '<wallet_address>';
const token = process.env.GMGN_TOKEN || '<token_address>';

const map = {
  swap: ['swap', '--chain', 'sol', '--from', wallet, '--input-token', 'So11111111111111111111111111111111111111112', '--output-token', token, '--amount', '100000000', '--anti-mev'],
  'multi-swap': ['multi-swap', '--chain', 'sol', '--accounts', '<addr1>,<addr2>', '--input-token', 'So11111111111111111111111111111111111111112', '--output-token', token],
  'strategy-list': ['order', 'strategy', 'list', '--chain', 'sol', '--group-tag', 'LimitOrder'],
  'strategy-create': ['order', 'strategy', 'create', '--chain', 'sol', '--from', wallet, '--base-token', token, '--quote-token', 'So11111111111111111111111111111111111111112', '--order-type', 'limit_order', '--sub-order-type', 'buy_low', '--check-price', '<target_price>', '--amount-in', '100000000'],
  'strategy-cancel': ['order', 'strategy', 'cancel', '--chain', 'sol', '--from', wallet, '--order-id', '<order_id>'],
  'cooking-stats': ['cooking', 'stats'],
  'cooking-pump': ['cooking', 'create', '--chain', 'sol', '--dex', 'pump', '--from', wallet, '--name', '<token_name>', '--symbol', '<symbol>'],
  'cooking-fourmeme': ['cooking', 'create', '--chain', 'bsc', '--dex', 'fourmeme', '--from', wallet, '--name', '<token_name>', '--symbol', '<symbol>'],
  'cooking-clanker': ['cooking', 'create', '--chain', 'base', '--dex', 'clanker', '--from', wallet, '--name', '<token_name>', '--symbol', '<symbol>'],
  'cooking-flap': ['cooking', 'create', '--chain', 'bsc', '--dex', 'flap', '--from', wallet, '--name', '<token_name>', '--symbol', '<symbol>', '--buy-amt', '2'],
};

const gmgnArgs = map[mode];
if (!gmgnArgs) {
  console.error(`Unknown mode: ${mode}`);
  process.exit(1);
}

const result = spawnSync('gmgn-cli', gmgnArgs, { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);

