import { loadConfig } from "../config/loadConfig.js";
import { getProviderAdapter } from "../providers/registry.js";
import type { ModelSelection, OptimToolInput, ProviderResponse } from "../types/index.js";
import { analyzeRepositoryWithGraphify, enrichPromptAnalysisWithRepositoryIntelligence, prependGraphifyContext } from "../repository/graphify.js";
import { analyzePrompt } from "./analyzePrompt.js";
import { selectModel, selectionWithFallback } from "./selectModel.js";

export interface RouteAttempt {
  provider: string;
  model: string;
  error?: string;
}

export interface ExecutionResult {
  selection: ModelSelection;
  response: ProviderResponse;
  attempts: RouteAttempt[];
}

export function formatRoutingDiagnostics(selection: ModelSelection): string {
  const diagnostics = [
    "[MCP ROUTER]",
    `Task Type: ${selection.taskType}`,
    `Task Difficulty: ${selection.analysis.taskDifficulty}`,
    `Selected Model: ${selection.model}`,
    `Provider: ${selection.provider}`,
    `Reason: ${selection.reason}`,
    `Fallback Used: ${selection.fallbackLevel === "primary" ? "no" : "yes"}`,
    `Execution Mode: ${selection.executionMode}`
  ];

  const repository = selection.analysis.repositoryIntelligence;
  if (repository) {
    diagnostics.push(`Graphify: ${repository.status}`);

    if (repository.status === "queried" || repository.status === "query_failed") {
      diagnostics.push(
        `Graphify Related Files: ${repository.metrics.relatedFileCount}`,
        `Graphify Affected Modules: ${repository.affectedModules.slice(0, 6).join(", ") || "none"}`,
        `Graphify Architecture Impact: ${repository.metrics.architectureImpact}/100`,
        `Graphify Dependency Complexity: ${repository.metrics.dependencyComplexity}/100`,
        `Graphify Connected Systems: ${repository.metrics.connectedSystemsAffected}`
      );
    }

    if (repository.status === "missing_graph" || repository.status === "unavailable") {
      diagnostics.push(`Graphify Note: ${repository.summary}`);
    }
  }

  return diagnostics.join("\n");
}

export async function executeRoutedRequest(input: OptimToolInput): Promise<ExecutionResult> {
  const promptAnalysis = analyzePrompt(input);
  const repositoryIntelligence = await analyzeRepositoryWithGraphify(input, promptAnalysis);
  const analysis = enrichPromptAnalysisWithRepositoryIntelligence(promptAnalysis, repositoryIntelligence);
  const config = await loadConfig(undefined, analysis.taskType);
  const initialSelection = selectModel(input, config, analysis);
  const attempts: RouteAttempt[] = [];
  const prompt = prependGraphifyContext(input.prompt, analysis.repositoryIntelligence);

  for (let index = 0; index < initialSelection.rankedCandidates.length; index += 1) {
    const candidate = initialSelection.rankedCandidates[index];
    if (!candidate) {
      continue;
    }

    const selection = selectionWithFallback(initialSelection, candidate, index);
    process.stderr.write(`[optim] Model Used: ${selection.model}\n`);

    try {
      const response = await getProviderAdapter(selection.provider).complete({
        prompt,
        taskType: selection.taskType,
        provider: selection.provider,
        model: selection.model,
        executionMode: selection.executionMode,
        repositoryIntelligence: selection.analysis.repositoryIntelligence
      });

      attempts.push({
        provider: selection.provider,
        model: selection.model
      });

      return {
        selection,
        response: {
          ...response,
          text: `${response.text.trim()}\n\n${formatRoutingDiagnostics(selection)}`
        },
        attempts
      };
    } catch (error) {
      attempts.push({
        provider: selection.provider,
        model: selection.model,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const errors = attempts
    .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error ?? "unknown error"}`)
    .join("; ");
  throw new Error(`All routing fallbacks failed. ${errors}`);
}
