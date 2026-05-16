import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TASK_TYPES, type ModelOption, type OptimConfig, type ProviderName, type TaskType } from "../types/index.js";
import { logger } from "../utils/logger.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "..", "..");
const primaryConfigPath = resolve(currentDir, "models.json");
const projectConfigPath = resolve(projectRoot, "src", "config", "models.json");
const defaultConfigCandidates = [primaryConfigPath, projectConfigPath];

const emptyModels: Required<OptimConfig["models"]> = {
  coding: [],
  reasoning: [],
  planning: []
};

async function resolveDefaultConfigPath(): Promise<string> {
  for (const candidate of defaultConfigCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Compiled builds run from dist/, while development runs from src/.
    }
  }

  return primaryConfigPath;
}

function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeProviderName(value: ProviderName): ProviderName {
  return value.trim().toLowerCase();
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && TASK_TYPES.includes(value as TaskType);
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

function contextFrom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function defaultCapability(taskType: TaskType, capability: TaskType): number {
  if (taskType === capability) return 86;
  if (taskType === "planning" && capability === "reasoning") return 82;
  if (taskType === "reasoning" && capability === "planning") return 80;
  return 70;
}

function splitModelList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}

function buildModelOption(
  model: string,
  provider: ProviderName,
  taskType: TaskType,
  source: Record<string, unknown>
): ModelOption {
  const specializations = Array.isArray(source.specializations)
    ? source.specializations.filter(isTaskType)
    : [taskType];

  return {
    model,
    provider,
    reasoning: numberFrom(source.reasoning, defaultCapability(taskType, "reasoning")),
    coding: numberFrom(source.coding, defaultCapability(taskType, "coding")),
    planning: numberFrom(source.planning, defaultCapability(taskType, "planning")),
    contextWindow: contextFrom(source.contextWindow, 128000),
    latency: numberFrom(source.latency, provider === "nvidia" ? 72 : 60),
    cost: numberFrom(source.cost, provider === "nvidia" ? 76 : 60),
    reliability: numberFrom(source.reliability, 80),
    specializations: specializations.length > 0 ? specializations : [taskType]
  };
}

function readModelOptions(value: unknown, taskType: TaskType, inheritedProvider?: ProviderName): ModelOption[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const provider = isProviderName(candidate.provider)
    ? normalizeProviderName(candidate.provider)
    : inheritedProvider
      ? normalizeProviderName(inheritedProvider)
      : undefined;
  if (!isProviderName(provider)) {
    return [];
  }

  return splitModelList(candidate.model).map((model) => buildModelOption(model, provider, taskType, candidate));
}

function readProviderGroup(value: unknown, taskType: TaskType): ModelOption[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (!isProviderName(candidate.provider)) {
    return [];
  }

  const provider = normalizeProviderName(candidate.provider);
  if (typeof candidate.model === "string") {
    return readModelOptions(candidate, taskType, provider);
  }

  if (Array.isArray(candidate.models)) {
    return candidate.models.flatMap((modelEntry) => readModelOptions(modelEntry, taskType, provider));
  }

  return [];
}

function readTaskModels(raw: unknown, onlyTaskType?: TaskType): OptimConfig["models"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const source = raw as Record<string, unknown>;
  const taskTypes: readonly TaskType[] = onlyTaskType ? [onlyTaskType] : TASK_TYPES;

  return taskTypes.reduce<OptimConfig["models"]>((models, taskType) => {
    const entries = source[taskType];
    if (!Array.isArray(entries)) {
      return models;
    }

    const parsed = entries.flatMap((entry) => {
      const groupedModels = readProviderGroup(entry, taskType);
      if (groupedModels.length > 0) {
        return groupedModels;
      }

      return readModelOptions(entry, taskType);
    });

    if (parsed.length > 0) {
      models[taskType] = parsed;
    }

    return models;
  }, {} as OptimConfig["models"]);
}

function emptyModelsForTask(taskType?: TaskType): OptimConfig["models"] {
  if (!taskType) {
    return emptyModels;
  }

  return {
    [taskType]: emptyModels[taskType]
  };
}

export async function loadConfig(configPath?: string, onlyTaskType?: TaskType): Promise<OptimConfig> {
  const resolvedConfigPath = configPath ?? (await resolveDefaultConfigPath());

  try {
    const file = await readFile(resolvedConfigPath, "utf8");
    const raw = JSON.parse(file) as unknown;
    const configured = readTaskModels(raw, onlyTaskType);

    return {
      models: {
        ...emptyModelsForTask(onlyTaskType),
        ...configured
      }
    };
  } catch (error) {
    logger.warn("Could not load models.json; using empty task model arrays.", {
      configPath: resolvedConfigPath,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      models: emptyModelsForTask(onlyTaskType)
    };
  }
}

export function getModelsForTask(config: OptimConfig, taskType: TaskType): ModelOption[] {
  return config.models[taskType] ?? [];
}
