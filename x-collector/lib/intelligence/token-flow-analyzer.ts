export type TokenFlow = {
  token: string;
  from: string;
  to: string;
  amount?: number;
  timestamp?: number;
};

export class TokenFlowAnalyzer {
  analyze(flows: TokenFlow[]) {
    return {
      count: flows.length,
      wallets: [...new Set(flows.flatMap((flow) => [flow.from, flow.to]))],
      flows,
    };
  }
}
