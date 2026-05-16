# optim MCP

`optim` is an MCP server that works like a small AI model router.

You call one MCP tool named `optim`, give it a prompt, and it decides which configured model should answer. It can route coding, reasoning, and planning tasks. If Graphify data exists for a repo, it can also add compact repository context before sending the request to the selected model.

In short:

- You ask `optim` something.
- It detects the task type: `coding`, `reasoning`, or `planning`.
- It checks `models.json`.
- It skips providers without API keys.
- It picks the best available model.
- It calls that model.
- It returns the answer plus routing details.

## Get NVIDIA NIM API Key

NVIDIA NIM models are available from the NVIDIA API Catalog:

```text
https://build.nvidia.com/models
```

To get a key:

1. Open `https://build.nvidia.com/models`.
2. Log in with an NVIDIA account.
3. Pick a model.
4. Open the model page.
5. Click `Get API Key`.
6. Copy the key.
7. Put it in `.env` as `NVIDIA_NIM_API_KEY`.

NVIDIA's hosted NIM API base URL is:

```text
https://integrate.api.nvidia.com/v1
```

The LLM chat endpoint is OpenAI-compatible:

```text
POST /v1/chat/completions
```

Useful NVIDIA docs:

- API catalog: `https://build.nvidia.com/models`
- NIM quickstart: `https://docs.api.nvidia.com/nim/docs/api-quickstart`
- LLM API reference: `https://docs.api.nvidia.com/nim/reference/llm-apis`

## Get NVIDIA NIM Model Names

The safest way is to copy the model name from the model page code sample on `build.nvidia.com`.

For example, NVIDIA model names often look like this:

```text
deepseek-ai/deepseek-v4-flash
deepseek-ai/deepseek-v4-pro
minimaxai/minimax-m2.7
```

Model availability changes, so always confirm the exact model id in the NVIDIA API Catalog before putting it in `models.json`.

## Setup

From this folder:

```powershell
cd D:\optim-mcp\optim
npm install
```

Copy env file:

```powershell
copy .env.example .env
```

Edit `.env` and add your NVIDIA key:

```text
NVIDIA_NIM_API_KEY=your_key_here
NVIDIA_NIM_BASE_URL=https://integrate.api.nvidia.com/v1
OPTIM_ANSWER_TIMEOUT_MS=10000
```

## Configure Models

Edit:

```text
D:\optim-mcp\optim\src\config\models.json
```

Example NVIDIA-only config:

```json
{
  "coding": [
    {
      "provider": "nvidia",
      "model": "deepseek-ai/deepseek-v4-flash"
    }
  ],
  "reasoning": [
    {
      "provider": "nvidia",
      "model": "deepseek-ai/deepseek-v4-pro"
    }
  ],
  "planning": [
    {
      "provider": "nvidia",
      "model": "minimaxai/minimax-m2.7"
    }
  ]
}
```

You can put more than one model in a string, separated by commas:

```json
{
  "coding": [
    {
      "provider": "nvidia",
      "model": "deepseek-ai/deepseek-v4-flash,deepseek-ai/deepseek-v4-pro"
    }
  ],
  "reasoning": [],
  "planning": []
}
```

After editing `src/config/models.json`, rebuild:

```powershell
npm run build
```

The build copies the config into `dist/config/models.json`, which is what the running MCP server normally reads.

## Run The MCP Server

Build:

```powershell
npm run build
```

Run:

```powershell
npm start
```

Or directly:

```powershell
node D:\optim-mcp\optim\dist\index.js
```

This is an MCP stdio server. It is not a website and it does not open a browser. If it looks like it is just waiting, that is normal. Your IDE or MCP client starts it and talks to it over stdio.

## Tool Name And Input

The MCP server exposes one tool:

```text
optim
```

Minimum input:

```json
{
  "prompt": "Explain this codebase simply."
}
```

Useful input:

```json
{
  "prompt": "Find the best place to add retry handling.",
  "taskType": "coding",
  "repositoryPath": "D:\\my-project"
}
```

Supported fields:

```text
prompt          required
taskType        optional: coding, reasoning, planning
provider        optional provider hint, example: nvidia
model           optional model hint
repositoryPath  optional repo path for Graphify context
graphPath       optional direct path to graphify-out/graph.json
```

## Use In Codex

Add this to your Codex config file:

```text
C:\Users\<you>\.codex\config.toml
```

Config:

```toml
[mcp_servers.optim]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\optim-mcp\optim\dist\index.js']
```

Restart Codex after editing the config.

Then call the MCP tool named:

```text
optim
```

Example call:

```json
{
  "prompt": "Route this as a coding task and explain the selected model.",
  "taskType": "coding",
  "repositoryPath": "D:\\optim-mcp\\optim"
}
```

## Use In Claude Desktop

Open Claude Desktop config and add:

```json
{
  "mcpServers": {
    "optim": {
      "command": "cmd",
      "args": [
        "/c",
        "node",
        "D:\\optim-mcp\\optim\\dist\\index.js"
      ]
    }
  }
}
```

Restart Claude Desktop.

Claude should then show a tool/server named `optim`. The tool to call is also named `optim`.

## Use In Any MCP IDE

Any IDE with MCP support needs the same basic server command:

```text
node D:\optim-mcp\optim\dist\index.js
```

Generic MCP config:

```json
{
  "mcpServers": {
    "optim": {
      "command": "node",
      "args": [
        "D:\\optim-mcp\\optim\\dist\\index.js"
      ]
    }
  }
}
```

After adding the server, call:

```text
server: optim
tool: optim
```

With input:

```json
{
  "prompt": "Your request here",
  "taskType": "coding"
}
```

## Quick Start

```powershell
cd D:\optim-mcp\optim
copy .env.example .env
npm install
npm run build
node dist\index.js
```

Then connect it from Codex, Claude Desktop, or another MCP IDE using the config above.
