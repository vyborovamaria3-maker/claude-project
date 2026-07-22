#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = path.resolve(getArg("--root", "."));
const outDir = path.resolve(getArg("--out", path.join(root, ".codex", "graphify")));
const maxBytes = Number(getArg("--max-bytes", "500000"));

const ignoredDirs = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".vite",
  ".turbo", ".cache", "logs", "tmp", "temp"
]);
const ignoredExt = new Set([".db", ".sqlite", ".sqlite3", ".log", ".map", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip"]);
const codeExt = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const docExt = new Set([".md", ".mdx", ".txt"]);
const configNames = new Set(["package.json", "tsconfig.json", "vite.config.ts", "tailwind.config.cjs", "schema.prisma"]);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(path.join(dir, entry.name), files);
      continue;
    }
    const full = path.join(dir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    if (ignoredExt.has(ext)) continue;
    if (codeExt.has(ext) || docExt.has(ext) || configNames.has(entry.name)) files.push(full);
  }
  return files;
}

const rel = (p) => path.relative(root, p).replaceAll(path.sep, "/");
const files = walk(root);
const nodes = [];
const edges = [];
const nodeById = new Map();
const skipped = [];

function addNode(node) {
  if (!nodeById.has(node.id)) {
    nodeById.set(node.id, node);
    nodes.push(node);
  }
  return nodeById.get(node.id);
}

function addEdge(source, target, type, weight = 1) {
  if (!source || !target || source === target) return;
  edges.push({ source, target, type, weight });
}

for (const file of files) {
  const stat = fs.statSync(file);
  const id = rel(file);
  const ext = path.extname(file).toLowerCase();
  const top = id.split("/")[0] || ".";
  addNode({ id, label: path.basename(file), type: codeExt.has(ext) ? "code" : docExt.has(ext) ? "doc" : "config", community: top, size: stat.size });
  addNode({ id: `dir:${top}`, label: top, type: "subsystem", community: top, size: 1 });
  addEdge(`dir:${top}`, id, "contains");
  if (stat.size > maxBytes) {
    skipped.push({ file: id, reason: `larger than ${maxBytes} bytes`, size: stat.size });
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  const imports = [...text.matchAll(/(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of imports) {
    if (spec.startsWith(".")) {
      const base = path.resolve(path.dirname(file), spec);
      const candidates = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", "/index.ts", "/index.tsx", "/index.js"].map((s) => base + s);
      const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (found) addEdge(id, rel(found), "imports", 3);
    } else {
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      addNode({ id: `pkg:${pkg}`, label: pkg, type: "package", community: "external", size: 1 });
      addEdge(id, `pkg:${pkg}`, "depends_on", 2);
    }
  }
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 12).map((m) => m[1].trim());
  for (const heading of headings) {
    const hid = `concept:${heading.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80)}`;
    addNode({ id: hid, label: heading, type: "concept", community: top, size: 1 });
    addEdge(id, hid, "mentions", 1);
  }
}

const degree = new Map(nodes.map((n) => [n.id, 0]));
for (const e of edges) {
  degree.set(e.source, (degree.get(e.source) || 0) + e.weight);
  degree.set(e.target, (degree.get(e.target) || 0) + e.weight);
}
for (const n of nodes) n.degree = degree.get(n.id) || 0;

const communityMap = nodes.reduce((acc, n) => {
  acc[n.community] ||= { id: n.community, nodes: 0, edges: 0 };
  acc[n.community].nodes += 1;
  return acc;
}, {});
for (const e of edges) {
  const source = nodeById.get(e.source);
  if (source) communityMap[source.community].edges += 1;
}
const communities = Object.values(communityMap);

fs.mkdirSync(outDir, { recursive: true });
const graph = { root, generatedAt: new Date().toISOString(), nodes, edges, communities, skipped };
fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(graph, null, 2));

const hubs = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 15);
const report = [
  "# GRAPH_REPORT",
  "",
  `Root: \`${root}\``,
  `Generated: ${graph.generatedAt}`,
  "",
  "## Summary",
  "",
  `- Nodes: ${nodes.length}`,
  `- Edges: ${edges.length}`,
  `- Communities: ${communities.length}`,
  `- Skipped files: ${skipped.length}`,
  "",
  "## Communities",
  "",
  ...communities.sort((a, b) => b.nodes - a.nodes).map((c) => `- ${c.id}: ${c.nodes} nodes, ${c.edges} outgoing/internal edges`),
  "",
  "## Hubs",
  "",
  ...hubs.map((n) => `- ${n.id} (${n.type}, degree ${n.degree})`),
  "",
  "## Notes",
  "",
  "- Import resolution is heuristic and optimized for JS/TS projects.",
  "- Dependency folders, build outputs, logs, maps, databases, and binary files are excluded by default.",
  "- Use graph.json for later architecture questions and graph.html for interactive exploration."
].join("\n");
fs.writeFileSync(path.join(outDir, "GRAPH_REPORT.md"), report);

const html = `<!doctype html><meta charset="utf-8"><title>Project Graph</title><style>
body{margin:0;font-family:Arial,sans-serif;background:#101418;color:#eef2f5}#wrap{display:grid;grid-template-columns:320px 1fr;height:100vh}
aside{padding:16px;border-right:1px solid #2b333b;overflow:auto}canvas{width:100%;height:100%;display:block}
.pill{display:inline-block;margin:2px;padding:2px 6px;border:1px solid #52606c;border-radius:4px;font-size:12px}
</style><div id="wrap"><aside><h1>Project Graph</h1><p>${nodes.length} nodes, ${edges.length} edges</p><div id="info">Hover a node.</div><h2>Communities</h2>${communities.map(c=>`<span class="pill">${c.id}: ${c.nodes}</span>`).join(" ")}</aside><canvas id="c"></canvas></div><script>
const graph=${JSON.stringify(graph)};const c=document.getElementById('c'),ctx=c.getContext('2d'),info=document.getElementById('info');
const colors={code:'#75b7ff',doc:'#84d99b',config:'#f5c46b',package:'#d190ff',concept:'#ff8f8f',subsystem:'#ffffff'};
function resize(){c.width=c.clientWidth*devicePixelRatio;c.height=c.clientHeight*devicePixelRatio}addEventListener('resize',resize);resize();
const nodes=graph.nodes.map((n,i)=>({...n,x:Math.random()*c.width,y:Math.random()*c.height,vx:0,vy:0,r:Math.max(4,Math.min(14,3+Math.sqrt(n.degree||1)))}));
const by=new Map(nodes.map(n=>[n.id,n]));const edges=graph.edges.map(e=>({s:by.get(e.source),t:by.get(e.target),w:e.weight||1})).filter(e=>e.s&&e.t);
let mouse={x:-1,y:-1};c.onmousemove=e=>{const r=c.getBoundingClientRect();mouse={x:(e.clientX-r.left)*devicePixelRatio,y:(e.clientY-r.top)*devicePixelRatio}};
function tick(){for(const e of edges){const dx=e.t.x-e.s.x,dy=e.t.y-e.s.y,d=Math.hypot(dx,dy)||1,f=(d-120)*0.0008*e.w;e.s.vx+=dx*f;e.s.vy+=dy*f;e.t.vx-=dx*f;e.t.vy-=dy*f}
for(const n of nodes){n.vx+=(c.width/2-n.x)*0.00003;n.vy+=(c.height/2-n.y)*0.00003;n.vx*=0.88;n.vy*=0.88;n.x+=n.vx;n.y+=n.vy}
ctx.clearRect(0,0,c.width,c.height);ctx.globalAlpha=.25;ctx.strokeStyle='#8ea0ad';for(const e of edges){ctx.beginPath();ctx.moveTo(e.s.x,e.s.y);ctx.lineTo(e.t.x,e.t.y);ctx.stroke()}
ctx.globalAlpha=1;let hit=null;for(const n of nodes){ctx.fillStyle=colors[n.type]||'#ccc';ctx.beginPath();ctx.arc(n.x,n.y,n.r,0,7);ctx.fill();if(Math.hypot(mouse.x-n.x,mouse.y-n.y)<n.r+4)hit=n}
if(hit){info.innerHTML='<b>'+hit.label+'</b><br>'+hit.id+'<br>'+hit.type+' / '+hit.community+'<br>degree '+hit.degree}
requestAnimationFrame(tick)}tick();
</script>`;
fs.writeFileSync(path.join(outDir, "graph.html"), html);

console.log(`Wrote ${path.join(outDir, "graph.json")}`);
console.log(`Wrote ${path.join(outDir, "GRAPH_REPORT.md")}`);
console.log(`Wrote ${path.join(outDir, "graph.html")}`);
