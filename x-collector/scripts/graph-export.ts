import { q } from "../lib/trade/pg";

export interface GraphNode {
  id: string; label: string; mints_count: number;
  total_views: string; tweets_count: number; is_verified: boolean; bot_score: number;
}
export interface GraphEdge { source: string; target: string; weight: number; shared_mints: string[]; }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; meta: { nodeCount: number; edgeCount: number; generatedAt: number; minWeight: number; }; }

export async function loadGraph(opts: {
  minWeight?: number; maxNodes?: number; minMintsPerNode?: number; onlyVerified?: boolean;
} = {}): Promise<GraphData> {
  const { minWeight = 2, maxNodes = 2000, minMintsPerNode = 1, onlyVerified = false } = opts;

  const edges = await q<{ source: string; target: string; weight: string; shared_mints: string[] }>(
    `SELECT source, target, weight, shared_mints FROM v_author_graph
     WHERE weight >= $1 ORDER BY weight DESC LIMIT $2`,
    [minWeight, maxNodes * 4]
  );

  const handles = new Set<string>();
  for (const e of edges) { handles.add(e.source); handles.add(e.target); }
  if (handles.size === 0) {
    return { nodes: [], edges: [], meta: { nodeCount: 0, edgeCount: 0, generatedAt: Date.now(), minWeight } };
  }

  const nodesRaw = await q<{ handle: string; mints_promoted: number; total_views: string; total_tweets: number; is_verified: boolean }>(
    `SELECT handle, mints_promoted, total_views, total_tweets, is_verified
     FROM v_author_profile WHERE handle = ANY($1::text[])`,
    [Array.from(handles)]
  );

  const allowed = new Set<string>();
  const nodes: GraphNode[] = [];
  for (const n of nodesRaw) {
    if (n.mints_promoted < minMintsPerNode) continue;
    if (onlyVerified && !n.is_verified) continue;
    allowed.add(n.handle);
    nodes.push({
      id: n.handle, label: n.handle, mints_count: n.mints_promoted,
      total_views: n.total_views, tweets_count: n.total_tweets,
      is_verified: n.is_verified, bot_score: 0,
    });
  }

  const cleanEdges: GraphEdge[] = [];
  for (const e of edges) {
    if (!allowed.has(e.source) || !allowed.has(e.target)) continue;
    cleanEdges.push({ source: e.source, target: e.target, weight: Number(e.weight), shared_mints: e.shared_mints ?? [] });
  }

  return {
    nodes, edges: cleanEdges,
    meta: { nodeCount: nodes.length, edgeCount: cleanEdges.length, generatedAt: Date.now(), minWeight },
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function toGEXF(g: GraphData): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<gexf xmlns="http://www.gexf.net/1.3" xmlns:viz="http://www.gexf.net/1.3/viz" version="1.3">`);
  lines.push(`  <meta lastmodifieddate="${new Date(g.meta.generatedAt).toISOString().slice(0, 10)}">`);
  lines.push(`    <creator>solana-x-collector</creator>`);
  lines.push(`    <description>nodes=${g.meta.nodeCount}, edges=${g.meta.edgeCount}, minWeight=${g.meta.minWeight}</description>`);
  lines.push(`  </meta>`);
  lines.push(`  <graph mode="static" defaultedgetype="undirected">`);
  lines.push(`    <attributes class="node">`);
  lines.push(`      <attribute id="mints_count" title="mints_count" type="integer"/>`);
  lines.push(`      <attribute id="total_views" title="total_views" type="long"/>`);
  lines.push(`      <attribute id="tweets_count" title="tweets_count" type="integer"/>`);
  lines.push(`      <attribute id="is_verified" title="is_verified" type="boolean"/>`);
  lines.push(`    </attributes>`);
  lines.push(`    <attributes class="edge">`);
  lines.push(`      <attribute id="shared_mints_count" title="shared_mints_count" type="integer"/>`);
  lines.push(`      <attribute id="shared_mints" title="shared_mints" type="string"/>`);
  lines.push(`    </attributes>`);
  lines.push(`    <nodes>`);
  const maxViews = Math.max(...g.nodes.map((n) => Number(n.total_views)), 1);
  for (const n of g.nodes) {
    const viewRatio = Number(n.total_views) / maxViews;
    const size = 5 + Math.log10(viewRatio * 1000 + 1) * 4;
    const color = n.is_verified ? "0,150,255" : "150,150,150";
    lines.push(`      <node id="${xmlEscape(n.id)}" label="${xmlEscape(n.label)}">`);
    lines.push(`        <attvalues>`);
    lines.push(`          <attvalue for="mints_count" value="${n.mints_count}"/>`);
    lines.push(`          <attvalue for="total_views" value="${n.total_views}"/>`);
    lines.push(`          <attvalue for="tweets_count" value="${n.tweets_count}"/>`);
    lines.push(`          <attvalue for="is_verified" value="${n.is_verified}"/>`);
    lines.push(`        </attvalues>`);
    lines.push(`        <viz:size value="${size.toFixed(2)}"/>`);
    lines.push(`        <viz:color r="${color.split(",")[0]}" g="${color.split(",")[1]}" b="${color.split(",")[2]}"/>`);
    lines.push(`      </node>`);
  }
  lines.push(`    </nodes>`);
  lines.push(`    <edges>`);
  let edgeId = 0;
  for (const e of g.edges) {
    lines.push(`      <edge id="${edgeId++}" source="${xmlEscape(e.source)}" target="${xmlEscape(e.target)}" weight="${e.weight}">`);
    lines.push(`        <attvalues>`);
    lines.push(`          <attvalue for="shared_mints_count" value="${e.shared_mints.length}"/>`);
    lines.push(`          <attvalue for="shared_mints" value="${xmlEscape(e.shared_mints.join(","))}"/>`);
    lines.push(`        </attvalues>`);
    lines.push(`      </edge>`);
  }
  lines.push(`    </edges>`);
  lines.push(`  </graph>`);
  lines.push(`</gexf>`);
  return lines.join("\n");
}

export function toGraphML(g: GraphData): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<graphml xmlns="http://graphml.graphdrawing.org/xmlns">`);
  lines.push(`  <key id="mints_count" for="node" attr.name="mints_count" attr.type="int"/>`);
  lines.push(`  <key id="total_views" for="node" attr.name="total_views" attr.type="long"/>`);
  lines.push(`  <key id="is_verified" for="node" attr.name="is_verified" attr.type="boolean"/>`);
  lines.push(`  <key id="weight" for="edge" attr.name="weight" attr.type="int"/>`);
  lines.push(`  <graph id="G" edgedefault="undirected">`);
  for (const n of g.nodes) {
    lines.push(`    <node id="${xmlEscape(n.id)}">`);
    lines.push(`      <data key="mints_count">${n.mints_count}</data>`);
    lines.push(`      <data key="total_views">${n.total_views}</data>`);
    lines.push(`      <data key="is_verified">${n.is_verified}</data>`);
    lines.push(`    </node>`);
  }
  let edgeId = 0;
  for (const e of g.edges) {
    lines.push(`    <edge id="e${edgeId++}" source="${xmlEscape(e.source)}" target="${xmlEscape(e.target)}">`);
    lines.push(`      <data key="weight">${e.weight}</data>`);
    lines.push(`    </edge>`);
  }
  lines.push(`  </graph>`);
  lines.push(`</graphml>`);
  return lines.join("\n");
}

export function toDOT(g: GraphData): string {
  const lines: string[] = [];
  lines.push(`graph G {`);
  lines.push(`  layout=neato; overlap=false;`);
  lines.push(`  node [shape=circle, style=filled, fontsize=10];`);
  lines.push(`  edge [color="#888888"];`);
  for (const n of g.nodes) {
    const fill = n.is_verified ? "#0096ff" : "#cccccc";
    const fontcolor = n.is_verified ? "white" : "black";
    lines.push(`  "${n.id}" [fillcolor="${fill}", fontcolor="${fontcolor}", tooltip="mints=${n.mints_count}, views=${n.total_views}"];`);
  }
  for (const e of g.edges) {
    const penwidth = Math.min(1 + e.weight * 0.3, 8);
    lines.push(`  "${e.source}" -- "${e.target}" [penwidth=${penwidth.toFixed(1)}, tooltip="shared=${e.shared_mints.length}"];`);
  }
  lines.push(`}`);
  return lines.join("\n");
}

export function toNodesCSV(g: GraphData): string {
  const headers = ["id", "label", "mints_count", "total_views", "tweets_count", "is_verified"];
  return [headers.join(","), ...g.nodes.map((n) =>
    [n.id, n.label, n.mints_count, n.total_views, n.tweets_count, n.is_verified].join(",")
  )].join("\n");
}

export function toEdgesCSV(g: GraphData): string {
  const headers = ["source", "target", "weight", "shared_mints_count", "shared_mints"];
  return [headers.join(","), ...g.edges.map((e) =>
    [e.source, e.target, e.weight, e.shared_mints.length, `"${e.shared_mints.join(";")}"`].join(",")
  )].join("\n");
}

