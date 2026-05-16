import OpenAI from "openai";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "../types/index.js";
import {
  getNvidiaApiKey,
  getNvidiaBaseUrl,
  getOptimAnswerTimeoutMs,
  isNvidiaConfigured,
  nvidiaApiKeyEnvName
} from "../utils/env.js";

export class OptimAnswerTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly model: string
  ) {
    super(`No answer received from "${model}" within ${timeoutMs / 1000} seconds.`);
    this.name = "OptimAnswerTimeoutError";
  }
}

function logNvidiaRequest(request: ProviderRequest, baseUrl: string): void {
  process.stderr.write("[optim] Provider: NVIDIA\n");
  process.stderr.write(`[optim] Task Type: ${request.taskType}\n`);
  process.stderr.write(`[optim] Selected Model: ${request.model}\n`);
  process.stderr.write(`[optim] Base URL: ${baseUrl}\n`);
  process.stderr.write("-----------------------------------------------------\n");
}

function logNvidiaSuccess(response: unknown): void {
  process.stderr.write("[optim] NVIDIA response received successfully\n");

  const status = response && typeof response === "object" ? (response as { status?: unknown }).status : undefined;
  if (typeof status === "number" || typeof status === "string") {
    process.stderr.write(`[optim] NVIDIA response status: ${status}\n`);
  }
}

function logNvidiaError(error: unknown, request: ProviderRequest): void {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write("[optim] NVIDIA request failed\n");
  process.stderr.write(`[optim] Task Type: ${request.taskType}\n`);
  process.stderr.write(`[optim] Selected Model: ${request.model}\n`);
  process.stderr.write(`[optim] Error: ${message}\n`);
}

function logNvidiaTimeout(request: ProviderRequest, timeoutMs: number): void {
  process.stderr.write("[optim] NVIDIA request timed out\n");
  process.stderr.write(`[optim] Task Type: ${request.taskType}\n`);
  process.stderr.write(`[optim] Selected Model: ${request.model}\n`);
  process.stderr.write(`[optim] Timeout: ${timeoutMs}ms\n`);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return error.name === "APIConnectionTimeoutError" || message.includes("timed out") || message.includes("timeout");
}

function createClient(): OpenAI {
  const apiKey = getNvidiaApiKey();
  if (!apiKey) {
    throw new Error(`${nvidiaApiKeyEnvName} is not configured. Add it to .env before calling optim.`);
  }

  return new OpenAI({
    apiKey,
    baseURL: getNvidiaBaseUrl()
  });
}

// NVIDIA NIM exposes OpenAI-compatible endpoints, so the adapter can use the
// OpenAI SDK while keeping the rest of the server provider-neutral.
export const nvidiaProvider: ProviderAdapter = {
  name: "nvidia",
  envKey: nvidiaApiKeyEnvName,

  isConfigured() {
    return isNvidiaConfigured();
  },

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const baseUrl = getNvidiaBaseUrl();
    const timeoutMs = getOptimAnswerTimeoutMs();
    logNvidiaRequest(request, baseUrl);

    const client = createClient();

    try {
      const response = await client.chat.completions.create(
        {
          model: request.model,
          messages: [
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

      logNvidiaSuccess(response);

      return {
        provider: "nvidia",
        model: request.model,
        text: response.choices[0]?.message?.content ?? "",
        raw: response
      };
    } catch (error) {
      if (isTimeoutError(error)) {
        logNvidiaTimeout(request, timeoutMs);
        throw new OptimAnswerTimeoutError(timeoutMs, request.model);
      }

      logNvidiaError(error, request);
      throw error;
    }
  }
};
