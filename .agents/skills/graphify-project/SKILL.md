---
name: graphify-project
description: Build a project knowledge graph from code, docs, configs, and selected text artifacts. Use when Codex needs architecture mapping, subsystem discovery, dependency/community analysis, interactive HTML graph output, GRAPH_REPORT.md summaries, or graph JSON for later project questions.
---

# Graphify Project

## Workflow

Use `scripts/build_graph.mjs` from this skill whenever a repository-wide graph is requested.

Default command:

```bash
node .agents/skills/graphify-project/scripts/build_graph.mjs --root . --out .codex/graphify
```

## Inputs

Analyze source code, package manifests, configs, Markdown, Prisma schemas, and scripts. Exclude dependency folders, build outputs, logs, databases, binary assets, and generated maps unless the user asks otherwise.

## Outputs

The script writes:

- `graph.json`: full graph with nodes, edges, communities, metrics, and skipped-file summary.
- `GRAPH_REPORT.md`: architecture-oriented report with key concepts, subsystems, hubs, and follow-up questions.
- `graph.html`: interactive browser map using embedded JSON and no external runtime.

## Interpretation

After running the script, read `GRAPH_REPORT.md` and inspect `graph.json` enough to summarize the architecture. Treat the graph as an aid, not as perfect ground truth; call out approximations such as heuristic imports, generated files excluded, or oversized files skipped.
