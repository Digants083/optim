import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { routeRequest } from "../router/routeRequest.js";
import { NoAvailableModelError } from "../router/selectModel.js";
import { TASK_TYPES } from "../types/index.js";
import { logger } from "../utils/logger.js";

const optimInputShape = {
  prompt: z.string().min(1).describe("The user prompt to send to the selected model."),
  taskType: z
    .enum(TASK_TYPES)
    .optional()
    .describe("Optional task hint. If omitted, Optim detects the task type automatically."),
  provider: z
    .string()
    .min(1)
    .optional()
    .describe("Optional provider hint. If omitted, Optim compares all configured providers."),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Optional model hint. If omitted, Optim ranks configured models automatically."),
  repositoryPath: z
    .string()
    .min(1)
    .optional()
    .describe("Optional repository root containing graphify-out/graph.json. Defaults to the MCP process working directory."),
  graphPath: z
    .string()
    .min(1)
    .optional()
    .describe("Optional Graphify graph.json path. Relative paths resolve against repositoryPath.")
};

const optimInputSchema = z.object(optimInputShape);

export function registerOptimTool(server: McpServer): void {
  server.registerTool(
    "optim",
    {
      title: "Optim AI Router",
      description:
        "Analyzes prompts and routes them to the best available model from models.json for coding, reasoning, or planning tasks.",
      inputSchema: optimInputShape
    },
    async (input) => {
      try {
        const result = await routeRequest(input);

        return {
          content: [
            {
              type: "text",
              text: result.response?.text ?? ""
            }
          ]
        };
      } catch (error) {
        if (error instanceof NoAvailableModelError) {
          return {
            content: [
              {
                type: "text",
                text: [
                  error.message,
                  "",
                  "[MCP ROUTER]",
                  `Task Type: ${error.taskType}`,
                  "Task Difficulty: unknown",
                  "Selected Model: none",
                  "Provider: none",
                  "Reason: no configured provider API key matched the selected task array",
                  "Fallback Used: no",
                  `Execution Mode: ${error.taskType}`
                ].join("\n")
              }
            ]
          };
        }

        logger.error("optim tool failed", error instanceof Error ? error.message : String(error));

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unknown optim routing error."
            }
          ]
        };
      }
    }
  );
}

export { optimInputSchema };
