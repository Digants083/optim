#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOptimTool } from "./tools/optimTool.js";
import { loadEnv } from "./utils/env.js";

async function main(): Promise<void> {
  loadEnv();

  const server = new McpServer({
    name: "optim",
    version: "0.1.0"
  });

  registerOptimTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(
    `[optim] MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
