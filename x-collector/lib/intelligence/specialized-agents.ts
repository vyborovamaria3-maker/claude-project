import type { IntelligenceAgentType } from './agent-registry';

export interface SpecializedAgentConfig {
  type: IntelligenceAgentType;
  capabilities: string[];
}

export const specializedAgents: SpecializedAgentConfig[] = [
  {
    type: 'graph',
    capabilities: ['relations', 'clusters', 'centrality'],
  },
  {
    type: 'blockchain',
    capabilities: ['wallets', 'flows', 'transactions'],
  },
  {
    type: 'risk',
    capabilities: ['anomalies', 'risk-score', 'alerts'],
  },
  {
    type: 'research',
    capabilities: ['context', 'evidence', 'enrichment'],
  },
];
