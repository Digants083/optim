type LogLevel = "info" | "warn" | "error" | "debug";

const shouldDebug = process.env.OPTIM_DEBUG === "true";

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (level === "debug" && !shouldDebug) {
    return;
  }

  const payload = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  // MCP stdio servers must reserve stdout for JSON-RPC messages. Human-readable
  // diagnostics always go to stderr so they cannot break protocol handshakes.
  process.stderr.write(`[optim] ${level.toUpperCase()} ${message}${payload}\n`);
}

export const logger = {
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
  debug: (message: string, meta?: unknown) => write("debug", message, meta)
};
