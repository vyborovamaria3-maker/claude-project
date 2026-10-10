export type Community = {
  id: string;
  members: string[];
  density: number;
};

function normalise(relations: Array<[string, string]>): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const [left, right] of relations) {
    if (!left || !right || left === right) continue;
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    if (!adjacency.has(right)) adjacency.set(right, new Set());
    adjacency.get(left)!.add(right);
    adjacency.get(right)!.add(left);
  }
  return adjacency;
}

export function detectCommunities(nodes: string[], relations: Array<[string, string]>): Community[] {
  const adjacency = normalise(relations);
  const labels = new Map<string, string>();
  for (const node of [...new Set(nodes)].sort()) {
    labels.set(node, node);
    if (!adjacency.has(node)) adjacency.set(node, new Set());
  }

  for (let round = 0; round < 50; round++) {
    let changed = false;
    for (const node of [...labels.keys()].sort()) {
      const neighbours = [...adjacency.get(node)!].filter((neighbour) => labels.has(neighbour));
      if (!neighbours.length) continue;
      const counts = new Map<string, number>();
      for (const neighbour of neighbours) {
        const label = labels.get(neighbour)!;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      let best = labels.get(node)!;
      let bestCount = -1;
      for (const [label, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (count > bestCount) {
          best = label;
          bestCount = count;
        }
      }
      if (best !== labels.get(node)) {
        labels.set(node, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const node of [...labels.keys()].sort()) {
    const label = labels.get(node)!;
    const group = groups.get(label);
    if (group) group.push(node);
    else groups.set(label, [node]);
  }

  return [...groups.entries()]
    .map(([label, members]) => {
      const sorted = [...members].sort();
      const memberSet = new Set(sorted);
      const internal = new Set<string>();
      for (const [left, right] of relations) {
        if (left === right) continue;
        if (!memberSet.has(left) || !memberSet.has(right)) continue;
        internal.add([left, right].sort().join("|"));
      }
      const possible = (sorted.length * (sorted.length - 1)) / 2;
      return {
        id: sorted[0] ?? label,
        members: sorted,
        density: possible ? internal.size / possible : 0,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
