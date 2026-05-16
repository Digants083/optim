export const TASK_TYPES = ["coding", "reasoning", "planning"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export type ProviderName = string;
export type ExecutionMode = TaskType;
export type FallbackLevel = "primary" | "secondary" | "tertiary";

export interface ModelOption {
  model: string;
  provider: ProviderName;
  reasoning: number;
  coding: number;
  planning: number;
  contextWindow: number;
  latency: number;
  cost: number;
  reliability: number;
  specializations: TaskType[];
}

export interface OptimConfig {
  models: Partial<Record<TaskType, ModelOption[]>>;
}

export interface OptimToolInput {
  prompt: string;
  taskType?: TaskType | undefined;
  model?: string | undefined;
  provider?: ProviderName | undefined;
  repositoryPath?: string | undefined;
  graphPath?: string | undefined;
}

export interface ProviderRequest {
  prompt: string;
  taskType: TaskType;
  provider: ProviderName;
  model: string;
  executionMode: ExecutionMode;
  repositoryIntelligence?: RepositoryIntelligence | undefined;
}

export interface ProviderResponse {
  provider: ProviderName;
  model: string;
  text: string;
  raw?: unknown;
}

export interface ProviderAdapter {
  name: ProviderName;
  envKey: string;
  isConfigured(): boolean;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface PromptAnalysis {
  taskType: TaskType;
  complexityScore: number;
  taskDifficulty: "simple" | "moderate" | "difficult";
  reasoningIntensity: number;
  codingIntensity: number;
  contextRequirement: number;
  planningDepth: number;
  executionPriority: "speed" | "quality" | "balanced";
  requiresLongContext: boolean;
  requiresCodingModel: boolean;
  requiresReasoningModel: boolean;
  executionMode: ExecutionMode;
  signals: string[];
  repositoryIntelligence?: RepositoryIntelligence | undefined;
}

export interface ModelSelection {
  provider: ProviderName;
  taskType: TaskType;
  model: string;
  fallbackLevel: FallbackLevel;
  executionMode: ExecutionMode;
  reason: string;
  analysis: PromptAnalysis;
  rankedCandidates: ModelOption[];
}

export type GraphifyStatus =
  | "not_applicable"
  | "missing_graph"
  | "queried"
  | "query_failed"
  | "unavailable";

export interface RepositoryRelationship {
  source: string;
  target: string;
  relation: string;
  confidence?: string | undefined;
  confidenceScore?: number | undefined;
  sourceFile?: string | undefined;
  targetFile?: string | undefined;
}

export interface RepositoryComplexityMetrics {
  taskDifficulty: "simple" | "moderate" | "difficult";
  score: number;
  reasoningDepthRequired: number;
  architectureImpact: number;
  dependencyComplexity: number;
  connectedSystemsAffected: number;
  relatedFileCount: number;
  affectedModuleCount: number;
}

export interface RepositoryIntelligence {
  provider: "graphify";
  status: GraphifyStatus;
  repositoryRoot: string;
  graphPath: string;
  queried: boolean;
  query: string;
  summary: string;
  relatedFiles: string[];
  dependencyRelationships: RepositoryRelationship[];
  affectedModules: string[];
  architectureContext: string[];
  metrics: RepositoryComplexityMetrics;
  signals: string[];
  rawQueryContext?: string | undefined;
  error?: string | undefined;
}
