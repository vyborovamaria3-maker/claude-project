const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function resolveMacosSdkRoot() {
  if (process.platform !== 'darwin') {
    return process.env.SDKROOT;
  }
  // Some shells/Xcode setups leave SDKROOT pointing at iPhoneOS, which breaks
  // swift-rs / macos-native-menu (targets arm64-apple-macosx).
  const current = process.env.SDKROOT || '';
  if (current && /MacOSX\.platform|MacOSX[^/]*\.sdk/i.test(current)) {
    return current;
  }
  const probed = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
    encoding: 'utf8',
  });
  if (probed.status === 0) {
    const path = String(probed.stdout || '').trim();
    if (path) return path;
  }
  return current || undefined;
}

const env = {
  ...process.env,
  COCKPIT_TOOLS_PROFILE: process.env.COCKPIT_TOOLS_PROFILE || 'dev',
  COCKPIT_TOOLS_API_PORT: process.env.COCKPIT_TOOLS_API_PORT || '1456',
  VITE_COCKPIT_TOOLS_PROFILE: process.env.VITE_COCKPIT_TOOLS_PROFILE || 'dev',
};
const repoRoot = path.resolve(__dirname, '..');
const localTauriCmd = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const macosSdkRoot = resolveMacosSdkRoot();
if (macosSdkRoot) {
  env.SDKROOT = macosSdkRoot;
}
const extraArgs = process.argv.slice(2);

const syncResult = spawnSync('npm', ['run', 'sync-version'], {
  stdio: 'inherit',
  env,
});

if (syncResult.status !== 0) {
  process.exit(syncResult.status ?? 1);
}

const tauriExecutable = fs.existsSync(localTauriCmd) ? localTauriCmd : 'tauri';
const tauriResult = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : tauriExecutable,
  process.platform === 'win32'
    ? ['/d', '/s', '/c', `"${tauriExecutable}" dev --config src-tauri/tauri.dev.conf.json ${extraArgs.join(' ')}`.trim()]
    : ['dev', '--config', 'src-tauri/tauri.dev.conf.json', ...extraArgs],
  {
    stdio: 'inherit',
    env,
    cwd: repoRoot,
    shell: false,
  },
);

process.exit(tauriResult.status ?? 1);
