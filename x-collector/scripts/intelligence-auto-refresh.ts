import { refreshIntelligenceProfiles } from '../lib/intelligence/auto-enrichment-worker';

export async function runAutoRefresh() {
  return refreshIntelligenceProfiles();
}

if (require.main === module) {
  runAutoRefresh().catch((error) => {
    console.error('intelligence auto refresh failed', error);
    process.exitCode = 1;
  });
}
