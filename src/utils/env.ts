import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultNvidiaBaseUrl = "https://integrate.api.nvidia.com/v1";
const defaultAnswerTimeoutMs = 10_000;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const providerEnv = {
  openai: {
    apiKeys: ["OPENAI_API_KEY"],
    baseUrls: ["OPENAI_BASE_URL"],
    defaultBaseUrl: "https://api.openai.com/v1"
  },
  anthropic: {
    apiKeys: ["ANTHROPIC_API_KEY"],
    baseUrls: ["ANTHROPIC_BASE_URL"],
    defaultBaseUrl: "https://api.anthropic.com"
  },
  deepseek: {
    apiKeys: ["DEEPSEEK_API_KEY"],
    baseUrls: ["DEEPSEEK_BASE_URL"],
    defaultBaseUrl: "https://api.deepseek.com"
  },
  nvidia: {
    apiKeys: ["NVIDIA_NIM_API_KEY", "NVIDIA_API_KEY"],
    baseUrls: ["NVIDIA_NIM_BASE_URL", "NVIDIA_BASE_URL"],
    defaultBaseUrl: defaultNvidiaBaseUrl
  },
  openrouter: {
    apiKeys: ["OPENROUTER_API_KEY"],
    baseUrls: ["OPENROUTER_BASE_URL"],
    defaultBaseUrl: "https://openrouter.ai/api/v1"
  },
  groq: {
    apiKeys: ["GROQ_API_KEY"],
    baseUrls: ["GROQ_BASE_URL"],
    defaultBaseUrl: "https://api.groq.com/openai/v1"
  },
  minimax: {
    apiKeys: ["MINIMAX_API_KEY"],
    baseUrls: ["MINIMAX_BASE_URL"],
    defaultBaseUrl: "https://api.minimax.io/v1"
  },
  codex: {
    apiKeys: ["CODEX_API_KEY"],
    baseUrls: ["CODEX_BASE_URL"],
    defaultBaseUrl: "https://api.openai.com/v1"
  }
} as const;

export type ProviderEnvName = string;

export function loadEnv(): void {
  // Claude Desktop can launch MCP servers from a different working directory on
  // Windows, so load .env relative to the optim project instead of process.cwd().
  // dotenv v17 logs by default unless quiet is true, which would corrupt MCP
  // stdio handshakes if written to stdout during initialization.
  dotenv.config({ path: resolve(projectRoot, ".env"), quiet: true });
}

export function getNvidiaApiKey(): string | undefined {
  return getProviderApiKey("nvidia");
}

export function getNvidiaBaseUrl(): string {
  return getProviderBaseUrl("nvidia") ?? defaultNvidiaBaseUrl;
}

export function getOptimAnswerTimeoutMs(): number {
  const value = process.env.OPTIM_ANSWER_TIMEOUT_MS;
  if (!value || value.trim().length === 0) {
    return defaultAnswerTimeoutMs;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultAnswerTimeoutMs;
}

export function isNvidiaConfigured(): boolean {
  return isProviderConfigured("nvidia");
}

export const nvidiaApiKeyEnvName = "NVIDIA_API_KEY";

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function envPrefix(provider: string): string {
  return normalizeProvider(provider).replace(/[^a-z0-9]+/g, "_").toUpperCase();
}

function getKnownProvider(provider: string): (typeof providerEnv)[keyof typeof providerEnv] | undefined {
  const normalized = normalizeProvider(provider);
  return Object.prototype.hasOwnProperty.call(providerEnv, normalized)
    ? providerEnv[normalized as keyof typeof providerEnv]
    : undefined;
}

export function getProviderApiKey(provider: ProviderEnvName): string | undefined {
  const setting = getKnownProvider(provider);
  const apiKeys = setting?.apiKeys ?? [`${envPrefix(provider)}_API_KEY`];

  for (const envName of apiKeys) {
    const value = process.env[envName];
    if (value && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

export function getProviderBaseUrl(provider: ProviderEnvName): string | undefined {
  const setting = getKnownProvider(provider);
  const baseUrls = setting?.baseUrls ?? [`${envPrefix(provider)}_BASE_URL`];

  for (const envName of baseUrls) {
    const value = process.env[envName];
    if (value && value.trim().length > 0) {
      return value;
    }
  }

  return setting?.defaultBaseUrl;
}

export function getProviderApiKeyEnvName(provider: ProviderEnvName): string {
  const setting = getKnownProvider(provider);
  return (setting?.apiKeys ?? [`${envPrefix(provider)}_API_KEY`]).join(" or ");
}

export function isProviderConfigured(provider: ProviderEnvName): boolean {
  return Boolean(getProviderApiKey(provider));
}

export function getProviderNames(): ProviderEnvName[] {
  return Object.keys(providerEnv) as ProviderEnvName[];
}

export function isKnownProvider(provider: ProviderEnvName): boolean {
  return Boolean(getKnownProvider(provider));
}
