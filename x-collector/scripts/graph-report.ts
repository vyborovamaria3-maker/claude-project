import {
  getAuthorNetwork, getRelatedEntities, topAuthors, topEntities, topRelations,
} from "../src/intelligence/graph/analytics";
import { buildKnowledgeGraph } from "../src/intelligence/graph/builder";
import type { NodeType } from "../src/intelligence/graph/types";
import { metrics } from "../src/core/metrics";

function arg(k: string): string | undefined {
  const i = process.argv.indexOf(`--${k}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
function hr(t: string) { console.log("\n" + "━".repeat(72) + "\n  " + t + "\n" + "━".repeat(72)); }
function pad(w: string) { return w.padEnd(14); }

function countByType(nodes: Array<{ type: NodeType }>): Record<NodeType, number> {
  const counts: Record<NodeType, number> = { AUTHOR: 0, ENTITY: 0, TOKEN: 0, TWEET: 0 };
  for (const node of nodes) counts[node.type] += 1;
  return counts;
}

async function main() {
  const hoursRaw = arg("hours");
  const hours = hoursRaw ? Number(hoursRaw) : undefined;
  const limit = Number(arg("limit") ?? 1000);
  const top = Number(arg("top") ?? 10);
  const entityArg = arg("entity");
  const authorArg = arg("author");

  const graph = await buildKnowledgeGraph({ hours, limit });
  const byType = countByType(graph.nodes);

  hr(`KNOWLEDGE GRAPH REPORT · ${hours ? `${hours}h` : "all time"} · top ${top}`);
  console.log(
    `nodes: ${graph.meta.nodeCount}` +
    ` (AUTHOR ${byType.AUTHOR} · ENTITY ${byType.ENTITY} · TOKEN ${byType.TOKEN} · TWEET ${byType.TWEET})` +
    ` · edges: ${graph.meta.edgeCount} · tweets: ${graph.meta.tweetsProcessed}`,
  );

  const entities = topEntities(graph, top);
  console.log("\nTOP ENTITIES");
  if (entities.length === 0) console.log("(нет данных)");
  else for (const e of entities) {
    console.log(`\n${e.entity}`);
    console.log(`connections: ${e.connections}`);
    console.log(`mentions: ${e.mentions}`);
  }

  const authors = topAuthors(graph, top);
  console.log("\nTOP AUTHORS");
  if (authors.length === 0) console.log("(нет данных)");
  else for (const a of authors) {
    console.log(`\n@${a.handle}`);
    console.log(`entities: ${a.entities}`);
    console.log(`tweets: ${a.tweets}`);
  }

  const relations = topRelations(graph, top);
  console.log("\nTOP RELATIONS");
  if (relations.length === 0) console.log("(нет данных)");
  else for (const r of relations) {
    console.log(`\n${r.from} ↔ ${r.to}`);
    console.log(`weight: ${r.weight}`);
  }

  if (entityArg) {
    const related = getRelatedEntities(entityArg, graph);
    console.log(`\nRELATED · ${entityArg}`);
    if (related.length === 0) console.log("(связей нет)");
    else for (const r of related) {
      console.log(`\n${r.entity}`);
      console.log(`connections: ${r.connections}`);
      console.log(`weight: ${r.weight}`);
    }
  }

  if (authorArg) {
    const network = getAuthorNetwork(authorArg, graph);
    console.log(`\nAUTHOR NETWORK · @${network.author}`);
    console.log(`tweets: ${network.tweets}`);
    console.log("entities:");
    if (network.entities.length === 0) console.log("  (нет)");
    else for (const e of network.entities) console.log(`  ${pad(e.entity)}${e.tweets} tweets (${e.type})`);
    console.log("related authors:");
    if (network.relatedAuthors.length === 0) console.log("  (нет)");
    else for (const a of network.relatedAuthors) {
      console.log(`  ${pad("@" + a.handle)}shared ${a.sharedEntities} · weight ${a.weight}`);
    }
  }

  metrics.reportsGenerated += 1;
  console.log(
    `\nmetrics: graphNodesBuilt=${metrics.graphNodesBuilt} ` +
    `graphEdgesBuilt=${metrics.graphEdgesBuilt} ` +
    `relationshipsCalculated=${metrics.relationshipsCalculated} ` +
    `reportsGenerated=${metrics.reportsGenerated}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
