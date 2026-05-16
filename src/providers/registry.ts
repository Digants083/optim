import OpenAI from "openai";
import type { ProviderAdapter, ProviderName, ProviderRequest, ProviderResponse } from "../types/index.js";
import {
  getOptimAnswerTimeoutMs,
  getProviderApiKey,
  getProviderApiKeyEnvName,
  getProviderBaseUrl,
  getProviderNames,
  isKnownProvider,
  isProviderConfigured,
} from "../utils/env.js";

export class OptimProviderTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly provider: ProviderName,
    readonly model: string
  ) {
    super(`No answer received from "${provider}/${model}" within ${timeoutMs / 1000} seconds.`);
    this.name = "OptimProviderTimeoutError";
  }
}

const openAiCompatibleProviders = new Set<ProviderName>([
  "openai",
  "deepseek",
  "nvidia",
  "openrouter",
  "groq",
  "minimax",
  "codex"
]);
const providerCache = new Map<ProviderName, ProviderAdapter>();

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return error.name === "APIConnectionTimeoutError" || error.name === "AbortError" || message.includes("timed out") || message.includes("timeout");
}

function logProviderRequest(request: ProviderRequest, baseUrl: string | undefined): void {
  process.stderr.write(`[optim] Provider: ${request.provider}\n`);
  process.stderr.write(`[optim] Task Type: ${request.taskType}\n`);
  process.stderr.write(`[optim] Execution Mode: ${request.executionMode}\n`);
  process.stderr.write(`[optim] Model Used: ${request.model}\n`);
  if (baseUrl) {
    process.stderr.write(`[optim] Base URL: ${baseUrl}\n`);
  }
  process.stderr.write("-----------------------------------------------------\n");
}

function systemPrompt(request: ProviderRequest): string {
  const prompt = [
    "You are the selected model inside an MCP routing system.",
    `Task type: ${request.taskType}.`,
    `Execution mode: ${request.executionMode}.`,
    "Answer the user request directly and accurately.",
    "Do not invent unavailable tool results."
  ];

  if (request.repositoryIntelligence?.status === "queried" || request.repositoryIntelligence?.status === "query_failed") {
    prompt.push(
      "A compact Graphify repository intelligence block may be included before the user request.",
      "Use it as persistent codebase memory for related files, dependencies, architecture context, and complexity."
    );
  }

  return prompt.join("\n");
}

function createOpenAiClient(provider: ProviderName): OpenAI {
  const apiKey = getProviderApiKey(provider);
  if (!apiKey) {
    throw new Error(`${getProviderApiKeyEnvName(provider)} is not configured.`);
  }

  const baseURL = getProviderBaseUrl(provider);
  if (!baseURL && !isKnownProvider(provider)) {
    throw new Error(`${provider.toUpperCase()}_BASE_URL is required for custom provider "${provider}".`);
  }

  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {})
  });
}

async function completeOpenAiCompatible(request: ProviderRequest): Promise<ProviderResponse> {
  const timeoutMs = getOptimAnswerTimeoutMs();
  const baseUrl = getProviderBaseUrl(request.provider);
  logProviderRequest(request, baseUrl);

  try {
    const response = await createOpenAiClient(request.provider).chat.completions.create(
      {
        model: request.model,
        messages: [
          {
            role: "system",
            content: systemPrompt(request)
          },
          {
            role: "user",
            content: request.prompt
          }
        ]
      },
      {
        maxRetries: 0,
        timeout: timeoutMs
      }
    );

    return {
      provider: request.provider,
      model: request.model,
      text: response.choices[0]?.message?.content ?? "",
      raw: response
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new OptimProviderTimeoutError(timeoutMs, request.provider, request.model);
    }

    throw error;
  }
}

async function completeAnthropic(request: ProviderRequest): Promise<ProviderResponse> {
  const apiKey = getProviderApiKey("anthropic");
  if (!apiKey) {
    throw new Error(`${getProviderApiKeyEnvName("anthropic")} is not configured.`);
  }

  const timeoutMs = getOptimAnswerTimeoutMs();
  const baseUrl = getProviderBaseUrl("anthropic") ?? "https://api.anthropic.com";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  logProviderRequest(request, baseUrl);

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 4096,
        system: systemPrompt(request),
        messages: [
          {
            role: "user",
            content: request.prompt
          }
        ]
      }),
      signal: controller.signal
    });

    const raw = (await response.json()) as unknown;
    if (!response.ok) {
      const message = raw && typeof raw === "object" && "error" in raw ? JSON.stringify((raw as { error: unknown }).error) : response.statusText;
      throw new Error(`Anthropic request failed: ${message}`);
    }

    const content = raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)
      ? (raw as { content: Array<{ type?: string; text?: string }> }).content
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("")
      : "";

    return {
      provider: "anthropic",
      model: request.model,
      text: content,
      raw
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new OptimProviderTimeoutError(timeoutMs, request.provider, request.model);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createProviderAdapter(provider: ProviderName): ProviderAdapter {
  return {
    name: provider,
    envKey: getProviderApiKeyEnvName(provider),
    isConfigured() {
      return isProviderConfigured(provider);
    },
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      if (provider !== request.provider) {
        throw new Error(`Provider adapter mismatch: expected "${provider}", got "${request.provider}".`);
      }

      if (provider === "anthropic") {
        return completeAnthropic(request);
      }

      if (openAiCompatibleProviders.has(provider) || !isKnownProvider(provider)) {
        return completeOpenAiCompatible(request);
      }

      throw new Error(`Unsupported provider "${provider}".`);
    }
  };
}

export function getProviderAdapter(provider: ProviderName): ProviderAdapter {
  const cached = providerCache.get(provider);
  if (cached) {
    return cached;
  }

  const adapter = createProviderAdapter(provider);
  providerCache.set(provider, adapter);
  return adapter;
}

export const providerRegistry = new Proxy({} as Record<ProviderName, ProviderAdapter>, {
  get(_target, property) {
    if (typeof property !== "string") {
      return undefined;
    }

    return getProviderAdapter(property);
  }
});

export function getConfiguredProviders(): ProviderName[] {
  return getProviderNames().filter((provider) => getProviderAdapter(provider).isConfigured());
}
