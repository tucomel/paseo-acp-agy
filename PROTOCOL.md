# Protocol Specification & Mapping: Antigravity stream-json ↔ ACP

`agy-acp` exposes the official Google Antigravity CLI (`agy`) to Paseo through ACP while keeping authentication and model execution inside the official CLI.

## Antigravity process

Each Paseo ACP session owns one persistent `agy` process:

```bash
agy --input-format stream-json --output-format stream-json --print=""
```

Session flags applied when the process starts or is restarted:

- `--model <model-id>`
- `--effort <low|medium|high>` when supported by the selected model
- `--mode <mode-id>`
- `--conversation <conversation-id>` when resuming
- `--add-dir <cwd>` registering the active workspace directory
- `--dangerously-skip-permissions` (enabled by default under ACP; see Permission Model)
- `--sandbox` when configured via `AGY_ACP_SANDBOX=1`

Configuration changes schedule a controlled restart before the next prompt. On POSIX systems `agy` is launched as a process-group leader; shutdown, restart and turn cancellation signal the process group so tool subprocesses are not left orphaned.

## Antigravity stream-json

### Input

One NDJSON object per user turn:

```json
{"event":"user","message":{"content":"User prompt"}}
```

### Output

`agy` emits NDJSON events:

- `init` — process/session metadata and `conversation_id`
- `step_update` — streaming assistant text, thoughts, tool calls and usage
- `result` — terminal result for a prompt turn

One open stdin/stdout stream is reused for multiple turns.

## ACP wire methods

The ACP wire protocol uses snake_case method names. `agy-acp` accepts these methods:

| ACP method | agy-acp behavior |
|---|---|
| `initialize` | Advertise provider/session capabilities |
| `session/new` | Create a new isolated session |
| `session/resume` | Restore and validate a persisted ACP session without history replay |
| `session/prompt` | Send a prompt to the persistent `agy` process |
| `session/cancel` | Cancel the reserved/running turn; signal the `agy` process group when running |
| `session/close` | Persist state and terminate the process tree |
| `session/set_mode` | Change mode; restart before the next turn if needed |
| `session/set_model` | Change base model; restart before the next turn if needed |
| `session/set_config_option` | Change `thought_level` / reasoning effort |
| `session/update` | Stream messages, thoughts, tool calls, usage and commands to Paseo |
| `provider/usage` | Return current Antigravity quota and credit state |

For backwards compatibility, the server also accepts the exact pre-hardening aliases:

- `setSessionMode`
- `unstable_setSessionModel`
- `setSessionConfigOption`

### `session/load`

`agy-acp` currently advertises `loadSession: false`. ACP `session/load` requires the agent to replay prior conversation history through `session/update` notifications. The adapter intentionally does not claim that capability until replay is implemented. Paseo persistence uses `session/resume`, which restores model context without replaying already-rendered history.

## Permission Model & CLI Limitations

In the standard ACP specification, clients like Paseo or Zed act as supervisors: an agent requests authorization for actions via `session/request_permission`, and the client presents prompts to the user or evaluates auto-accept policies.

### The Antigravity headless stream-json constraint

The official Antigravity CLI (`agy`) was created as a terminal-interactive CLI rather than a native ACP server:
1. **Piped Stdio vs. Interactive TTY**: `agy` runs headlessly over JSON-RPC stdio pipes. In this mode, `agy`'s internal TTY consent prompts (`Allow <tool>? [y/n]`) cannot query the user.
2. **Immediate Denial on Non-Interactive Stdin**: Without `--dangerously-skip-permissions`, whenever `agy` invokes a tool (`read_file`, `write_file`, shell execution) in a workspace path that has not been manually pre-trusted in `~/.gemini/antigravity-cli/settings.json`, it immediately fails with:
   `permission check failed for <tool>: user denied permission for <tool>(<path>)`.
3. **Absence of a Protocol-Level Permission Callback**: The `agy stream-json` protocol currently lacks an inbound pause-and-resume event (such as `permission_response`). By the time `agy` outputs a `step_update` event with `step_type: "tool"` and `state: "ACTIVE"`, execution has already been initiated by the binary.

### How `agy-acp` resolves this

- **Delegated Trust**: `agy-acp` applies `--dangerously-skip-permissions` by default for ACP sessions so the underlying CLI does not fail on headless stdin prompts.
- **Workspace Demarcation**: `agy-acp` passes `--add-dir <cwd>` on startup to explicitly register the current working directory in Antigravity's workspace context.
- **Live Tool Streaming**: Tool calls are mapped and streamed immediately via `session/update` (`tool_call` and `tool_call_update`) so Paseo provides real-time auditability of actions and outputs.
- **Opt-out & Sandbox**: Users can customize this behavior:
  - Setting `AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS=false` disables `--dangerously-skip-permissions` for environments where `~/.gemini/antigravity-cli/settings.json` is strictly maintained.
  - Setting `AGY_ACP_SANDBOX=true` adds `--sandbox` to enable terminal execution restrictions.

## Turn concurrency and cancellation

A session-level prompt operation is reserved synchronously before any slash-command or process startup/restart `await`. Therefore:

- a second `session/prompt` cannot enter while `/resume`, `/usage`, or another asynchronous slash command is running;
- a second prompt cannot enter during first-turn startup;
- cancellation received during startup prevents the user prompt from ever being written to `agy` stdin;
- stale child events cannot resolve or reject a newer turn;
- each active process turn tracks the exact child process that owns it;
- the session prompt reservation is always released in `finally`, for both slash-command and ordinary prompt paths.

## Models and thinking effort

`agy-acp` discovers models through `agy models`. Model variants ending in `-high`, `-medium` or `-low` are exposed as a base model plus a separate ACP `thought_level` config option. Discovery is cached for one minute per `agy` binary path, with a fallback list if discovery fails.

## Session persistence and resume validation

ACP session metadata is stored outside the repository under:

```text
${XDG_STATE_HOME:-~/.local/state}/agy-acp/sessions/
```

Each session is stored in its own `0600` JSON file inside a `0700` directory. Persisted state contains only:

- ACP `sessionId`
- Antigravity `conversation_id`
- cwd
- model
- effort
- mode
- accumulated token/cost/context usage
- update timestamp

No Google credentials or OAuth tokens are read or persisted by the adapter.

When Paseo requests `session/resume`, the adapter starts `agy --conversation <id>`, waits for its `init` event, and verifies that Antigravity actually opened the requested conversation before returning success.

## Token usage, context window, cost and quota

- Cumulative `inputTokens`, `outputTokens`, `cachedInputTokens` and `totalTokens` are persisted per ACP session.
- Usage from a completed Antigravity `result` is recorded even when the turn ends with `status: ERROR`, because model/tool work may already have consumed billable tokens.
- The model used for cost calculation is snapshotted at the beginning of the prompt operation. A `session/set_model` received mid-turn applies to the next Antigravity process, without repricing the current turn.
- Raw session cost is accumulated without per-turn rounding. Rounding occurs only in UI-facing ACP payloads, preserving micro-costs across many small turns.
- Context-window limits are attached to model definitions and streaming usage updates.
- `fetchAntigravityUsage()` treats `/usage` as the primary availability probe. A failed, timed-out or missing `agy` command returns `status: unavailable` with an error instead of a false zero-usage `available` result.
- `/credits` failure is treated as partial data loss when `/usage` succeeds: quota remains available, balances are omitted and the error explains the missing credit data.

## Child-process lifecycle

- One ACP session = one `agy` process tree.
- On POSIX, the child is a process-group leader and signals target the whole group.
- A child being replaced is terminated and awaited before a replacement is spawned.
- `SIGTERM` is used first; `SIGKILL` follows a bounded timeout.
- Child event handlers are identity-checked so an old process cannot alter a newer process.

## Attachments

Inline base64 images are written under the adapter state directory with `0600` permissions and a content-addressed file name. The adapter:

- accepts only known image MIME types;
- validates base64 by decode/re-encode equivalence;
- enforces a default 20 MiB decoded-size limit (`AGY_ACP_MAX_ATTACHMENT_BYTES` can override it);
- converts valid `file://` URIs with Node's URL parser.

## Slash commands

The adapter intercepts selected local commands such as `/resume`, `/usage`, `/credits`, `/skills`, `/agents`, `/changelog` and `/help`.

- Resume identifiers are validated before filesystem lookup.
- Paseo session IDs resolve through the persisted session store rather than by scraping logs.
- `/resume` stats all conversation candidates first and reads transcript contents only for the newest requested entries.
- `/resume <id>` validates the Antigravity conversation before reporting success.
- Subprocess-based slash commands use bounded timeouts and output buffers.

## CI

`.github/workflows/agy-acp.yml` runs `npm ci`, `npm audit --omit=dev --audit-level=high`, `npm run typecheck` and `npm test` for changes under `tools/agy-acp`.
