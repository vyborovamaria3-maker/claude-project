import catalogJson from "./analysis-feature-provenance.json";
import {
  buildAnalysisSnapshot as buildBaseAnalysisSnapshot,
  type AnalysisSnapshot as BaseAnalysisSnapshot,
  type IntelligenceFeature as BaseIntelligenceFeature,
} from "./intelligence-agent";

export {
  buildEntityGraph,
  INTELLIGENCE_GRAPH_VERSION,
  INTELLIGENCE_SNAPSHOT_VERSION,
} from "./intelligence-agent";

export type {
  IntelligenceEdge,
  IntelligenceEdgeType,
  IntelligenceEvidence,
  IntelligenceGraph,
  IntelligenceNode,
  IntelligenceNodeType,
} from "./intelligence-agent";

export type IntelligenceFeatureSource =
  | "derived"
  | "x"
  | "telegram"
  | "market"
  | "chain"
  | "ai";

export type IntelligenceFeatureRole = "input" | "ai_output";

type ProvenanceRule = {
  source: IntelligenceFeatureSource;
  sources: IntelligenceFeatureSource[];
  role: IntelligenceFeatureRole;
};

type ProvenanceGroup = {
  coreCount: number;
  default: ProvenanceRule;
  labels: string[];
  overrides?: Record<string, ProvenanceRule>;
};

type ProvenanceCatalog = {
  version: string;
  coreFeatureCount: number;
  groups: Record<string, ProvenanceGroup>;
};

const catalog = catalogJson as unknown as ProvenanceCatalog;
const fallbackRule: ProvenanceRule = {
  source: "derived",
  sources: ["derived"],
  role: "input",
};

export type IntelligenceFeature = Omit<BaseIntelligenceFeature, "source"> & {
  source: IntelligenceFeatureSource;
  sources: IntelligenceFeatureSource[];
  role: IntelligenceFeatureRole;
  core: boolean;
  provenanceMapped: boolean;
  includedInAgentSnapshot: true;
  availableAsAgentInput: boolean;
};

export type AnalysisSnapshot = Omit<BaseAnalysisSnapshot, "features"> & {
  features: IntelligenceFeature[];
  provenance: {
    version: string;
    catalogFeatureCount: number;
    snapshotFeatureCount: number;
    coreFeatureCount: number;
    coreMappedFeatureCount: number;
    extendedFeatureCount: number;
    mappedFeatureCount: number;
    unmappedFeatureCount: number;
    agentInputFeatureCount: number;
    availableAgentInputFeatureCount: number;
    aiOutputPlaceholderCount: number;
    allCoreMapped: boolean;
    allFeaturesMapped: boolean;
  };
};

function buildSnapshotProvenance(features: IntelligenceFeature[]) {
  const mappedFeatureCount = features.filter((feature) => feature.provenanceMapped).length;
  const coreFeatures = features.filter((feature) => feature.core);
  const coreMappedFeatureCount = coreFeatures.filter(
    (feature) => feature.provenanceMapped,
  ).length;
  const agentInputFeatures = features.filter((feature) => feature.role === "input");
  const aiOutputPlaceholders = features.filter(
    (feature) => feature.role === "ai_output",
  );
  const catalogFeatureCount = Object.values(catalog.groups).reduce(
    (sum, group) => sum + group.labels.length,
    0,
  );

  return {
    version: catalog.version,
    catalogFeatureCount,
    snapshotFeatureCount: features.length,
    coreFeatureCount: catalog.coreFeatureCount,
    coreMappedFeatureCount,
    extendedFeatureCount: Math.max(0, features.length - catalog.coreFeatureCount),
    mappedFeatureCount,
    unmappedFeatureCount: features.length - mappedFeatureCount,
    agentInputFeatureCount: agentInputFeatures.length,
    availableAgentInputFeatureCount: agentInputFeatures.filter(
      (feature) => feature.availableAsAgentInput,
    ).length,
    aiOutputPlaceholderCount: aiOutputPlaceholders.length,
    allCoreMapped:
      coreFeatures.length === catalog.coreFeatureCount
      && coreMappedFeatureCount === catalog.coreFeatureCount,
    allFeaturesMapped:
      features.length === catalogFeatureCount
      && mappedFeatureCount === features.length,
  };
}

function featureRule(group: string, label: string) {
  const groupRule = catalog.groups[group];
  if (!groupRule) {
    return {
      rule: fallbackRule,
      mapped: false,
      core: false,
    };
  }

  const labelIndex = groupRule.labels.indexOf(label);
  const mapped = labelIndex >= 0;
  return {
    rule: groupRule.overrides?.[label] || groupRule.default,
    mapped,
    core: mapped && labelIndex < groupRule.coreCount,
  };
}

function enrichFeature(feature: BaseIntelligenceFeature): IntelligenceFeature {
  const { rule, mapped, core } = featureRule(feature.group, feature.label);
  const sources = [...new Set(rule.sources.length ? rule.sources : [rule.source])];
  const role = rule.role;

  return {
    ...feature,
    source: rule.source,
    sources,
    role,
    core,
    provenanceMapped: mapped,
    includedInAgentSnapshot: true,
    availableAsAgentInput: role === "input" && !feature.missing,
  };
}

export function buildProvenanceFeature(
  feature: BaseIntelligenceFeature,
): IntelligenceFeature {
  return enrichFeature(feature);
}

export function buildAnalysisSnapshot(
  args: Parameters<typeof buildBaseAnalysisSnapshot>[0],
): AnalysisSnapshot {
  const snapshot = buildBaseAnalysisSnapshot(args);
  const features = snapshot.features.map(enrichFeature);

  return {
    ...snapshot,
    features,
    provenance: buildSnapshotProvenance(features),
  };
}

export function rebuildProvenanceSnapshot(snapshot: AnalysisSnapshot): AnalysisSnapshot {
  return {
    ...snapshot,
    provenance: buildSnapshotProvenance(snapshot.features),
  };
}
