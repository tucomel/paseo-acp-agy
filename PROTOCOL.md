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
- `--model <model-id>`: model selection (e.g. `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.6-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`)
- `--mode <mode-id>`: execution mode (e.g. `accept-edits`, `plan`)
- `--effort <low|medium|high>`: reasoning effort
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
    "model": "gemini-3.7-flash-high"
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
  And when completed:
  ```json
  {
    "event": "step_update",
    "step_update": {
      "conversation_id": "...",
      "step_index": 1,
      "state": "DONE",
      "step_type": "agent_response",
      "text_delta": " you today?\n",
      "duration_seconds": 1.37,
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
- **Tool invocation**:
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
  Tool completion:
  ```json
  {
    "event": "step_update",
    "step_update": {
      "conversation_id": "...",
      "step_index": 2,
      "state": "DONE",
      "step_type": "tool",
      "tool_name": "view_file",
      "duration_seconds": 0.027,
      "tool_info": {
        "name": "view_file",
        "parameters": { "AbsolutePath": "/home/ubuntu/projects/eo/README.md" },
        "output": "90 lines, 3065 bytes"
      }
    }
  }
  ```
- **Tool error**:
  ```json
  {
    "event": "step_update",
    "step_update": {
      "conversation_id": "...",
      "step_index": 4,
      "state": "ERROR",
      "step_type": "tool",
      "tool_name": "run_command",
      "duration_seconds": 0.02,
      "tool_info": {
        "name": "run_command",
        "parameters": { "CommandLine": "pwd" },
        "error": {
          "type": "TOOL_ERROR",
          "message": "permission check failed for command \"pwd\": user denied permission to run command:\npwd"
        }
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

## 2. ACP Protocol Mapping

| ACP (Paseo) | `agy-acp` Action | Antigravity `agy` stream-json |
|---|---|---|
| `initialize` | Return capabilities, server info, supported models/modes | Probe `/home/ubuntu/.local/bin/agy --version` |
| `session/new` | Create session state, allocate sessionId | Spawn dedicated `agy` persistent process with configured cwd/model/mode |
| `session/prompt` | Send prompt turn, await turn completion | Write `{"event": "user", "message": {"content": prompt}}` to `agy` stdin |
| `session/update` notification | Send streaming chunks to client | Translate `step_update` (text_delta, tool_info, usage) to ACP `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` |
| `session/cancel` notification | Cancel active turn | Send `SIGINT` to the active `agy` process for clean turn abortion |
| `session/close` | Free session resources | Close `agy` stdin, terminate process cleanly |
| `session/set_mode` | Change mode (`accept-edits` vs `plan`) | Track in session; apply on session turns |
| `session/set_model` | Change active model | Track in session; applied to process |

### Tool Kind Mapping

| `agy` Tool Name | ACP `ToolKind` |
|---|---|
| `view_file`, `list_dir`, `grep_search`, `find_by_name`, `read_url_content`, `read_resource` | `read` |
| `replace_file_content`, `write_to_file`, `multi_replace_file_content`, `sed_file` | `edit` |
| `run_command`, `send_command_input`, `command_status` | `execute` |
| `search_web`, `read_url_content` | `fetch` |
| Other tools (`browser_*`, `notebook_*`, `schedule`, etc.) | `other` |

---

## 3. Session Isolation & Process Architecture

- **1 Paseo Session = 1 Dedicated Persistent `agy` Process**.
- Sessions are completely isolated in their own processes with distinct working directories and conversation contexts.
- Multi-turn prompts maintain conversational context natively inside the `agy` process.
- Process crashes or turn timeouts are contained per session and do not compromise the adapter or Paseo daemon.
