# optim MCP

optim is a smart AI model router for MCP.

Instead of manually choosing models every time, you call one tool:

```json
{
  "tool": "optim"
}
```

optim automatically selects the best available model for the task.

---

# What optim Can Do

- Route coding tasks
- Route reasoning tasks
- Route planning tasks
- Automatically skip providers without API keys
- Support multiple AI providers
- Add Graphify repository context

---

# How It Works

```text
You
 ↓
optim MCP
 ↓
Best Available Model
 ↓
Answer
```

Example:

| Task | Model |
|---|---|
| Coding | DeepSeek Flash |
| Reasoning | DeepSeek Pro |
| Planning | Minimax |

---

# Install

```bash
cd D:\optim-mcp\optim

npm install
npm run build
```

---

# Run Server

```bash
npm start
```

or:

```bash
node dist/index.js
```

If the terminal looks stuck, that means the MCP server is running correctly.

---

# NVIDIA Setup

Get API key:

https://build.nvidia.com/models

Add to `.env`:

```env
NVIDIA_NIM_API_KEY=your_key_here
NVIDIA_NIM_BASE_URL=https://integrate.api.nvidia.com/v1
```

---

# Configure Models

Edit:

```text
src/config/models.json
```

Example:

```json
{
  "coding": [
    {
      "provider": "nvidia",
      "model": "deepseek-ai/deepseek-v4-flash,z-ai/glm4.7,minimaxai/minimax-m2.7"     # in this we can hv multipal model from one  provider as well as u can hv n number diffrent provider
    }
     # can hv multipal provider also
    {
      "provider": "openai",
      "model": "gpt 5.5,gpt 5.4"
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

After editing:

```bash
npm run build
# how to use in ide check for /mcp optim is connected if so in promot add like " use optim -to build something to build -" 
```


---

# Supported Providers

- NVIDIA NIM
- OpenAI
- Anthropic
- DeepSeek
- OpenRouter
- Groq

Add only the providers you want inside `.env`.

---

# Example Request

```json
{
  "prompt": "Explain this repository simply.",
  "taskType": "coding"
}
```

---

# Supported Task Types

```text
coding
reasoning
planning
```

---

# Graphify Support

If Graphify data exists, optim can automatically include repository context such as:

- project structure
- imports
- dependencies
- architecture

This improves coding responses significantly.

---

# MCP Tool

Server name:

```text
optim
```

Tool name:

```text
optim
```
