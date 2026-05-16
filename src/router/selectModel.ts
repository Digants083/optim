import { getModelsForTask } from "../config/loadConfig.js";
import type { FallbackLevel, ModelOption, ModelSelection, OptimConfig, OptimToolInput, PromptAnalysis } from "../types/index.js";
import { isProviderConfigured } from "../utils/env.js";
import { analyzePrompt } from "./analyzePrompt.js";

export class NoAvailableModelError extends Error {
  constructor(
    readonly taskType: string,
    readonly categoryCount: number
  ) {
    super(
      `No available model for ${taskType}. Loaded ${categoryCount} model(s) from models.json ${taskType}[], but none matched configured provider API keys.`
    );
    this.name = "NoAvailableModelError";
  }
}

function fallbackLevel(index: number): FallbackLevel {
  if (index === 0) return "primary";
  if (index === 1) return "secondary";
  return "tertiary";
}

function scoreModel(model: ModelOption, analysis: PromptAnalysis): number {
  const capability =
    analysis.taskType === "coding"
      ? model.coding
      : analysis.taskType === "planning"
        ? model.planning
        : model.reasoning;
  const repositoryMetrics = analysis.repositoryIntelligence?.metrics;
  const repositoryPressure = repositoryMetrics
    ? Math.max(repositoryMetrics.architectureImpact, repositoryMetrics.dependencyComplexity, repositoryMetrics.reasoningDepthRequired)
    : 0;
  const isolatedRepositoryChange =
    repositoryMetrics !== undefined && repositoryMetrics.relatedFileCount <= 1 && repositoryMetrics.affectedModuleCount <= 1;
  const specializationFit = model.specializations.includes(analysis.taskType) ? 100 : 55;
  const contextFit = analysis.requiresLongContext ? Math.min(100, model.contextWindow / 2000) : 80;
  const nvidiaPreference = model.provider.toLowerCase() === "nvidia" ? 14 : 0;
  const qualityPressure =
    analysis.taskDifficulty === "difficult" || repositoryPressure >= 70
      ? 1.28
      : analysis.taskDifficulty === "moderate" || repositoryPressure >= 45
        ? 1
        : 0.72;
  const speedWeight = analysis.taskDifficulty === "simple" && isolatedRepositoryChange ? 0.24 : analysis.taskDifficulty === "simple" ? 0.2 : 0.1;
  const costWeight =
    analysis.taskDifficulty === "difficult" || repositoryPressure >= 70
      ? 0.05
      : analysis.taskDifficulty === "moderate"
        ? 0.12
        : isolatedRepositoryChange
          ? 0.24
          : 0.2;
  const architectureReasoningWeight = repositoryPressure >= 65 ? 0.14 : 0.08;

  return (
    capability * 0.3 * qualityPressure +
    specializationFit * 0.18 +
    model.reasoning * (analysis.taskType === "reasoning" ? 0.16 : architectureReasoningWeight) +
    model.coding * (analysis.taskType === "coding" ? 0.16 : 0.06) +
    model.planning * (analysis.taskType === "planning" ? 0.16 : 0.06) +
    contextFit * 0.08 +
    model.reliability * 0.12 +
    model.latency * speedWeight +
    model.cost * costWeight +
    nvidiaPreference
  );
}

function explainSelection(model: ModelOption, analysis: PromptAnalysis, fallbackUsed: boolean): string {
  const reasons = [
    `selected from models.json ${analysis.taskType}[] only`,
    `${model.provider} credentials are available`,
    `balanced quality, speed, estimated cost, and ${analysis.taskDifficulty} task difficulty`
  ];

  if (model.provider.toLowerCase() === "nvidia") {
    reasons.push("NVIDIA NIM preference applied");
  }

  const repository = analysis.repositoryIntelligence;
  if (repository?.status === "queried" || repository?.status === "query_failed") {
    reasons.push(
      `Graphify repository intelligence: ${repository.metrics.relatedFileCount} related file(s), ${repository.metrics.affectedModuleCount} module(s), architecture impact ${repository.metrics.architectureImpact}/100, dependency complexity ${repository.metrics.dependencyComplexity}/100`
    );
  } else if (repository?.status === "missing_graph") {
    reasons.push("Graphify graph missing; routed with prompt-only complexity");
  }

  if (fallbackUsed) {
    reasons.push("previous candidate failed");
  }

  return reasons.join("; ");
}

export function selectModel(input: OptimToolInput, config: OptimConfig, providedAnalysis?: PromptAnalysis): ModelSelection {
  const analysis = providedAnalysis ?? analyzePrompt(input);
  const taskModels = getModelsForTask(config, analysis.taskType);

  const candidates = taskModels
    .filter((model) => isProviderConfigured(model.provider))
    .filter((model) => !input.provider || model.provider === input.provider)
    .filter((model) => !input.model || model.model === input.model)
    .sort((a, b) => scoreModel(b, analysis) - scoreModel(a, analysis));

  if (candidates.length === 0) {
    throw new NoAvailableModelError(analysis.taskType, taskModels.length);
  }

  const selected = candidates[0];
  if (!selected) {
    throw new Error("No model selected.");
  }

  return {
    provider: selected.provider,
    taskType: analysis.taskType,
    model: selected.model,
    fallbackLevel: fallbackLevel(0),
    executionMode: analysis.executionMode,
    reason: explainSelection(selected, analysis, false),
    analysis,
    rankedCandidates: candidates.slice(0, 3)
  };
}

export function selectionWithFallback(selection: ModelSelection, model: ModelOption, index: number): ModelSelection {
  return {
    ...selection,
    provider: model.provider,
    model: model.model,
    fallbackLevel: fallbackLevel(index),
    reason: explainSelection(model, selection.analysis, index > 0)
  };
}
