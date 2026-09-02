# Protocol Specification & Mapping: Antigravity stream-json ↔ ACP

This document records the protocol discovery findings for the Google Antigravity CLI (`agy`) stream-json interface and its translation to the Agent Client Protocol (ACP) used by Paseo.

## 1. Antigravity Stream-JSON Interface

### Invocation
The official Antigravity CLI (`/home/ubuntu/.local/bin/agy`) is invoked in headless stream-json mode with:
```bash
agy --input-format stream-json --output-format stream-json --print=""
```
Optional flags supported:
- `--cwd <path>` / `--add-dir <dir>`: session workspace root
- `--model <model-id>`: base model selection (e.g. `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`)
- `--effort <low|medium|high>`: reasoning effort / thinking level
- `--mode <mode-id>`: execution mode (e.g. `accept-edits`, `plan`)
- `--conversation <id>`: resume previous conversation ID
- `--sandbox`: run with terminal restrictions enabled
- `--dangerously-skip-permissions`: bypass permission prompts (disabled by default)

### Input Stream Format (Stdin)
`agy` expects NDJSON (one JSON object per line) on stdin.
Each turn is triggered by a `user` event:
```json
{
  "event": "user",
  "message": {
    "content": "User prompt text here"
  }
}
```
Or with structured content blocks:
```json
{
  "event": "user",
  "message": {
    "content": [
      { "type": "text", "text": "User prompt text here" }
    ]
  }
}
```

Multiple turns can be sent sequentially on the same open stdin stream.

### Output Stream Format (Stdout)
`agy` emits NDJSON events on stdout for each turn:

1. **`init` event** (emitted once at process startup):
```json
{
  "event": "init",
  "conversation_id": "823fb330-71e5-43b9-9efd-d9b7323e4b94",
  "init": {
    "cwd": "/home/ubuntu/projects/eo",
    "tools": ["view_file", "run_command", "replace_file_content", ...],
    "permission_mode": "request-review",
    "model": "gemini-3.7-flash"
  }
}
```

2. **`step_update` event** (emitted incrementally during turn execution):
- **User input echo**:
  ```json
  {
    "event": "step_update",
    "step_update": {
      "conversation_id": "...",
      "step_index": 0,
      "state": "DONE",
      "step_type": "user_input"
    }
  }
  ```
- **Agent response streaming** (with `text_delta` or `thought`):
  ```json
  {
    "event": "step_update",
    "step_update": {
      "conversation_id": "...",
      "step_index": 1,
      "state": "ACTIVE",
      "step_type": "agent_response",
      "text_delta": "Hello! How can I help"
    }
  }
  ```
- **Tool invocation & result**:
  ```json
  {
    "event": "step_update",
    "step_update": {
      "conversation_id": "...",
      "step_index": 2,
      "state": "ACTIVE",
      "step_type": "tool",
      "tool_name": "view_file",
      "tool_info": {
        "name": "view_file",
        "parameters": { "AbsolutePath": "/home/ubuntu/projects/eo/README.md" }
      }
    }
  }
  ```

3. **`result` event** (marks the end of a prompt turn):
```json
{
  "event": "result",
  "result": {
    "conversation_id": "823fb330-71e5-43b9-9efd-d9b7323e4b94",
    "status": "SUCCESS",
    "response": "Hello! How can I help you today?\n",
    "duration_seconds": 1.42,
    "num_turns": 1,
    "usage": {
      "input_tokens": 13842,
      "output_tokens": 35,
      "thinking_tokens": 26,
      "cache_read_tokens": 0,
      "total_tokens": 13877
    }
  }
}
```

---

## 2. ACP Protocol Mapping & Combobox Separation

### Separation of Model & Thinking Effort (Comboboxes)
In ACP, Paseo separates the model selection from the thinking/reasoning effort:
- **Models (`models` / `setSessionModel`)**:
  - `gemini-3.7-flash` (Gemini 3.7 Flash)
  - `gemini-3.6-flash` (Gemini 3.6 Flash)
  - `gemini-3.1-pro` (Gemini 3.1 Pro)
  - `claude-sonnet-4-6` (Claude Sonnet 4.6)
  - `claude-opus-4-6-thinking` (Claude Opus 4.6)
  - `gpt-oss-120b-medium` (GPT-OSS 120B)
- **Thinking Option (`configOptions` / `setSessionConfigOption` with `category: "thought_level"`)**:
  - `low` (Low reasoning effort)
  - `medium` (Medium reasoning effort)
  - `high` (High reasoning effort)

When configured in Paseo (CLI `--model <model> --thinking <effort>` or in UI dropdowns), Paseo calls `setSessionModel` and `setSessionConfigOption`, and `agy-acp` applies `--model <model>` and `--effort <effort>` to the `agy` process.

| ACP (Paseo) | `agy-acp` Action | Antigravity `agy` stream-json |
|---|---|---|
| `initialize` | Return capabilities, server info | Probe `agy --version` |
| `session/new` | Create session state, return `models`, `modes`, and `configOptions` | Spawn dedicated `agy` process with `--model` and `--effort` |
| `session/set_model` | Set active base model | Pass `--model <model>` |
| `session/set_config_option` (`thought_level`) | Set reasoning effort (`low`, `medium`, `high`) | Pass `--effort <effort>` |
| `session/set_mode` | Change mode (`accept-edits` vs `plan`) | Pass `--mode <mode>` |
| `session/prompt` | Send prompt turn, await turn completion | Write NDJSON `{"event": "user", "message": {"content": prompt}}` |
| `session/update` notification | Send streaming chunks | Translate `step_update` (text_delta, thought, tool) to ACP update notifications |
| `session/cancel` notification | Cancel active turn | Send `SIGINT` to the active `agy` process |
| `session/close` | Free session resources | Terminate process cleanly |
