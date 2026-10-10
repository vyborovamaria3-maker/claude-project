export type GraphEdge={source:string;target:string;weight:number};
export function connectedComponents(edges:GraphEdge[]){
 const adjacency=new Map<string,Set<string>>();
 for(const {source,target} of edges){if(!adjacency.has(source))adjacency.set(source,new Set());if(!adjacency.has(target))adjacency.set(target,new Set());adjacency.get(source)!.add(target);adjacency.get(target)!.add(source);}
 const seen=new Set<string>(),components:string[][]=[];
 for(const root of adjacency.keys()){
  if(seen.has(root))continue;const members:string[]=[],queue=[root];seen.add(root);
  for(let i=0;i<queue.length;i++){const node=queue[i];members.push(node);for(const next of adjacency.get(node)!){if(!seen.has(next)){seen.add(next);queue.push(next);}}}
  components.push(members.sort());
 }
 return components.sort((a,b)=>b.length-a.length);
}
export function pageRank(edges:GraphEdge[],iterations=30,damping=0.85){
 const nodes=[...new Set(edges.flatMap(e=>[e.source,e.target]))];if(!nodes.length)return new Map<string,number>();
 let rank=new Map(nodes.map(n=>[n,1/nodes.length]));const outgoing=new Map<string,number>();
 for(const e of edges)outgoing.set(e.source,(outgoing.get(e.source)??0)+Math.max(0,e.weight));
 for(let i=0;i<iterations;i++){
  const dangling=nodes.reduce((s,n)=>s+((outgoing.get(n)??0)===0?rank.get(n)!:0),0);
  const next=new Map(nodes.map(n=>[n,(1-damping)/nodes.length+damping*dangling/nodes.length]));
  for(const e of edges){const total=outgoing.get(e.source)??0;if(total>0)next.set(e.target,next.get(e.target)!+damping*rank.get(e.source)!*Math.max(0,e.weight)/total);}
  rank=next;
 }
 return rank;
}
export function cosine(a:number[],b:number[]){
 if(!a.length||a.length!==b.length||[...a,...b].some(v=>!Number.isFinite(v)))throw Error('Invalid embedding dimensions or values');
 let dot=0,left=0,right=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];left+=a[i]*a[i];right+=b[i]*b[i];}
 if(!left||!right)throw Error('Zero embedding vector');return dot/Math.sqrt(left*right);
}
