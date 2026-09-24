import { q, q1, tx } from "./pg";
import { log } from "./logger";

const MAX_CLUSTER_EDGES = 250_000;

export async function rebuildClusters(minWeight = 2): Promise<number> {
  return tx(async (c) => {
    await c.query(`SET LOCAL statement_timeout = '300000'`);
    const result = await c.query<{ a: string; b: string }>(
      `SELECT source AS a, target AS b
       FROM v_author_graph
       WHERE weight >= $1
       ORDER BY weight DESC, source, target
       LIMIT $2`,
      [minWeight, MAX_CLUSTER_EDGES]
    );

    // Union-find computes connected components over the undirected author graph.
    const parent = new Map<string, string>();
    const size = new Map<string, number>();
    const find = (node: string): string => {
      const p = parent.get(node);
      if (p === undefined) {
        parent.set(node, node);
        size.set(node, 1);
        return node;
      }
      if (p === node) return node;
      const root = find(p);
      parent.set(node, root);
      return root;
    };
    const union = (a: string, b: string) => {
      let ra = find(a);
      let rb = find(b);
      if (ra === rb) return;
      if ((size.get(ra) ?? 1) < (size.get(rb) ?? 1)) [ra, rb] = [rb, ra];
      parent.set(rb, ra);
      size.set(ra, (size.get(ra) ?? 1) + (size.get(rb) ?? 1));
      size.delete(rb);
    };

    for (const edge of result.rows) union(edge.a, edge.b);
    const components = new Map<string, string[]>();
    for (const node of parent.keys()) {
      const root = find(node);
      const members = components.get(root) ?? [];
      members.push(node);
      components.set(root, members);
    }
    const ordered = [...components.values()]
      .map((members) => members.sort())
      .sort((a, b) => a[0].localeCompare(b[0]));

    await c.query(`DELETE FROM cluster_members`);
    await c.query(`DELETE FROM author_clusters`);
    const now = Date.now();
    const clusterRows = ordered.map((members, index) => [index + 1, `cluster-${index + 1}`, members.length]);
    const memberRows: Array<[number, string, number]> = [];
    for (let index = 0; index < ordered.length; index++) {
      const id = index + 1;
      for (const handle of ordered[index]) memberRows.push([id, handle, now]);
    }

    for (let offset = 0; offset < clusterRows.length; offset += 500) {
      const batch = clusterRows.slice(offset, offset + 500);
      const values: any[] = [];
      const placeholders = batch.map(([id, label, clusterSize], row) => {
        const base = row * 4;
        values.push(id, label, clusterSize, now);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 4})`;
      }).join(",");
      await c.query(
        `INSERT INTO author_clusters (id,label,size,created_at,updated_at) VALUES ${placeholders}`,
        values
      );
    }
    for (let offset = 0; offset < memberRows.length; offset += 1000) {
      const batch = memberRows.slice(offset, offset + 1000);
      const values = batch.flat();
      const placeholders = batch.map((_, row) => {
        const base = row * 3;
        return `($${base + 1},$${base + 2},$${base + 3})`;
      }).join(",");
      await c.query(
        `INSERT INTO cluster_members (cluster_id,handle,joined_at) VALUES ${placeholders}`,
        values
      );
    }

    log.info("clusters rebuilt", {
      count: ordered.length,
      nodes: parent.size,
      edges: result.rows.length,
      edgeLimitReached: result.rows.length === MAX_CLUSTER_EDGES,
    });
    return ordered.length;
  });
}

export async function listClusters(minSize = 3) {
  return q(`SELECT * FROM author_clusters WHERE size >= $1 ORDER BY size DESC`, [minSize]);
}

export async function getClusterMembers(clusterId: number) {
  return q(
    `SELECT cm.handle, cm.centrality, r.reputation_score, r.total_mints
     FROM cluster_members cm
     LEFT JOIN author_reputation r ON r.handle = cm.handle
     WHERE cm.cluster_id = $1
     ORDER BY COALESCE(r.reputation_score, 0) DESC`, [clusterId]
  );
}

export async function getAuthorCluster(handle: string) {
  return q1(
    `SELECT c.id, c.label, c.size FROM cluster_members cm
     JOIN author_clusters c ON c.id = cm.cluster_id
     WHERE cm.handle = $1`, [handle.toLowerCase()]
  );
}
