import type { OptimToolInput, PromptAnalysis, TaskType } from "../types/index.js";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function inferTaskType(prompt: string, hint?: TaskType): TaskType {
  if (hint) {
    return hint;
  }

  const text = prompt.toLowerCase();
  const coding = countMatches(text, [
    /```/,
    /\b(code|implement|function|class|api|typescript|javascript|python|repo|file|component|test|debug|bug|error|compile|refactor|fix)\b/
  ]);
  const planning = countMatches(text, [
    /\b(plan|planning|roadmap|strategy|architecture|design|workflow|steps|milestone|system|orchestrat|agent|mcp)\b/
  ]);
  const reasoning = countMatches(text, [
    /\b(reason|reasoning|analyze|evaluate|compare|tradeoff|derive|prove|diagnose|math|logic|why|decision)\b/
  ]);

  if (coding >= planning && coding >= reasoning && coding > 0) return "coding";
  if (planning >= coding && planning >= reasoning && planning > 0) return "planning";
  return "reasoning";
}

export function analyzePrompt(input: OptimToolInput): PromptAnalysis {
  const prompt = input.prompt.trim();
  const text = prompt.toLowerCase();
  const tokenEstimate = Math.ceil(prompt.length / 4);
  const taskType = inferTaskType(prompt, input.taskType);
  const codingSignals = countMatches(text, [/```/, /\b(code|implement|debug|bug|error|test|api|typescript|javascript|python|refactor|compile)\b/]);
  const planningSignals = countMatches(text, [/\b(plan|planning|roadmap|architecture|design|workflow|strategy|steps|agent|mcp|system)\b/]);
  const reasoningSignals = countMatches(text, [/\b(reason|analyze|evaluate|compare|tradeoff|derive|prove|diagnose|why|logic)\b/]);
  const longContext = tokenEstimate > 6000 || /\b(long context|large repo|entire codebase|many files|full document)\b/.test(text);

  const codingIntensity = clamp(codingSignals * 25 + (taskType === "coding" ? 40 : 0));
  const planningDepth = clamp(planningSignals * 24 + (taskType === "planning" ? 40 : 0));
  const reasoningIntensity = clamp(reasoningSignals * 24 + (taskType === "reasoning" ? 40 : 0));
  const contextRequirement = clamp(Math.min(100, tokenEstimate / 180) + (longContext ? 40 : 0));
  const complexityScore = clamp(
    16 +
      codingIntensity * 0.24 +
      planningDepth * 0.24 +
      reasoningIntensity * 0.28 +
      contextRequirement * 0.16 +
      Math.min(16, tokenEstimate / 500)
  );
  const taskDifficulty = complexityScore < 40 ? "simple" : complexityScore < 72 ? "moderate" : "difficult";
  const executionPriority = complexityScore < 35 && tokenEstimate < 900 ? "speed" : complexityScore > 72 ? "quality" : "balanced";
  const signals: string[] = [];

  if (codingIntensity >= 45) signals.push("coding");
  if (planningDepth >= 45) signals.push("planning");
  if (reasoningIntensity >= 45) signals.push("reasoning");
  if (longContext) signals.push("long_context");

  return {
    taskType,
    complexityScore,
    taskDifficulty,
    reasoningIntensity,
    codingIntensity,
    contextRequirement,
    planningDepth,
    executionPriority,
    requiresLongContext: longContext,
    requiresCodingModel: taskType === "coding" || codingIntensity >= 55,
    requiresReasoningModel: taskType === "reasoning" || reasoningIntensity >= 55,
    executionMode: taskType,
    signals
  };
}
