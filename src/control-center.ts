/**
 * Pythia's AI-facing control plane.
 *
 * The physics engine remains Lilith-compatible. This module describes the
 * system around it in stable, machine-readable terms so an MCP client can
 * discover capabilities, provenance, and safe next actions in one call.
 */

export const PYTHIA_VERSION = "1.2.0";

export type ControlSourceId = "lilith" | "run2database" | "smodels";

export interface ControlSource {
  id: ControlSourceId;
  name: string;
  role: string;
  repository: string;
  localPath: string;
  authority: "engine" | "data" | "reference";
  runtimeIntegrated: boolean;
  notes: string;
}

export const CONTROL_SOURCES: readonly ControlSource[] = [
  {
    id: "lilith",
    name: "Lilith-2",
    role: "Higgs signal-strength likelihood engine",
    repository: "https://github.com/sabinekraml/Lilith-2",
    localPath: "lilith/",
    authority: "engine",
    runtimeIntegrated: true,
    notes: "Pythia preserves Lilith's published likelihood contract and adds a persistent worker boundary.",
  },
  {
    id: "run2database",
    name: "Lilith Run-2 database",
    role: "historical measurement-development and validation reference",
    repository: "https://github.com/sabinekraml/Lilith-Run2database",
    localPath: "lilith/data/",
    authority: "data",
    runtimeIntegrated: true,
    notes: "The bundled database is curated for Pythia; new records are ingested into user data with provenance.",
  },
  {
    id: "smodels",
    name: "SModelS documentation",
    role: "broader LHC reinterpretation and likelihood ecosystem reference",
    repository: "https://github.com/sabinekraml/smodels.github.io",
    localPath: "",
    authority: "reference",
    runtimeIntegrated: false,
    notes: "Used for discovery and future adapters; SModelS is not silently installed as a Lilith dependency.",
  },
];

export const CONTROL_CAPABILITIES = [
  "discover_capabilities",
  "inspect_engine_and_database_health",
  "compute_likelihood",
  "compare_models_to_the_standard_model",
  "scan_coupling_parameters",
  "browse_and_validate_experimental_data",
  "ingest_measurements_with_provenance",
  "check_official_upstream_revisions",
] as const;

export const RESEARCH_TARGETS = [
  {
    topic: "full Run-2 Higgs signal-strength fits",
    reason: "Extend the validated ATLAS/CMS measurement catalog while preserving correlations and validation provenance.",
    source: "https://github.com/sabinekraml/Lilith-2/tree/py3-fullRun2-dev",
  },
  {
    topic: "Higgs simplified-template cross sections (STXS)",
    reason: "The next analysis layer beyond inclusive signal strengths needs production-bin observables and their covariance information.",
    source: "https://arxiv.org/abs/2311.02028",
  },
  {
    topic: "SMEFT parameterizations",
    reason: "Map model predictions into a parameter basis that can be scanned and compared through the same likelihood surface.",
    source: "https://arxiv.org/abs/2311.02028",
  },
  {
    topic: "global likelihood interoperability",
    reason: "Connect Higgs constraints with the wider LHC reinterpretation ecosystem documented by SModelS without conflating their databases.",
    source: "https://smodels.github.io/",
  },
] as const;

export interface ControlCenterLocalState {
  lilithDirectory: string;
  dataDirectory: string;
  userDataDirectory: string;
  pythonCommand: string;
  pythonVersion?: string;
  lilithVersion: string;
  databaseVersion: string;
  datasetCount: number;
  activeListCount: number;
  workerCount: number;
  workerMode: "persistent-pooled" | "subprocess-fallback";
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export function buildControlCenterStatus(local: ControlCenterLocalState) {
  const healthy = local.checks.every((check) => check.ok);
  return {
    controlCenter: {
      name: "Pythia",
      codename: "Lilith Immaculate",
      version: PYTHIA_VERSION,
      mission: "Give AI systems one safe, explainable control surface for Higgs likelihood analysis.",
      status: healthy ? "ready" : "degraded",
    },
    health: {
      status: healthy ? "healthy" : "degraded",
      checks: local.checks,
    },
    engine: {
      name: "Lilith-2",
      version: local.lilithVersion,
      pythonCommand: local.pythonCommand,
      pythonVersion: local.pythonVersion ?? "unknown",
      workerMode: local.workerMode,
      workerCount: local.workerCount,
      likelihoodContract: [
        "ordinary Gaussian",
        "variable Gaussian",
        "generalized Poisson",
        "correlated N-dimensional measurements",
      ],
    },
    data: {
      databaseVersion: local.databaseVersion,
      bundledDatasetCount: local.datasetCount,
      activeListCount: local.activeListCount,
      dataDirectory: local.dataDirectory,
      userDataDirectory: local.userDataDirectory,
      writePolicy: "bundled data is read-only; generated or ingested data goes to the user data directory",
    },
    sources: CONTROL_SOURCES,
    capabilities: CONTROL_CAPABILITIES,
    researchTargets: RESEARCH_TARGETS,
    aiWorkflow: [
      "1. Call get_control_center_status before analysis.",
      "2. Choose a dataset list and record its database version.",
      "3. Validate or ingest measurements with provenance.",
      "4. Compute the model likelihood and compare it with the SM reference.",
      "5. Report likelihood, delta-likelihood, p-value, database version, and source provenance together.",
    ],
  };
}

export function selectControlSources(source?: string): readonly ControlSource[] {
  if (!source || source === "all") return CONTROL_SOURCES;
  const selected = CONTROL_SOURCES.find((item) => item.id === source);
  if (!selected) {
    throw new Error(`Unknown source "${source}". Allowed: all, ${CONTROL_SOURCES.map((item) => item.id).join(", ")}`);
  }
  return [selected];
}
