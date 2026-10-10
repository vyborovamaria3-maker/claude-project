export type GraphDomain = 'social' | 'blockchain';

export type CrossDomainNode = {
  id: string;
  domain: GraphDomain;
};

export class CrossDomainGraph {
  connect(source: CrossDomainNode, target: CrossDomainNode) {
    return {
      source,
      target,
      createdAt: new Date().toISOString(),
    };
  }
}
