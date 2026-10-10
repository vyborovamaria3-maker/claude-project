export type Community = {
  id: string;
  members: string[];
  density: number;
};

export function detectCommunities(nodes: string[], relations: Array<[string,string]>): Community[] {
  const groups = new Map<string,string[]>();
  for (const node of nodes) groups.set(node, [node]);
  for (const [a,b] of relations) {
    const group = groups.get(a) ?? [];
    if (!group.includes(b)) group.push(b);
    groups.set(a, group);
  }
  return Array.from(groups.entries()).map(([id,members]) => ({id,members,density: members.length ? relations.length / members.length : 0}));
}
