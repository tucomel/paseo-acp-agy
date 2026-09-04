# paseo-acp-agy

> **Agent Client Protocol (ACP)** provider adapter connecting **Google Antigravity (`agy`)** to **[Paseo](https://paseo.sh)**, **Zed**, and any ACP-compliant agent client over stdio.

[![CI](https://github.com/tucomel/paseo-acp-agy/actions/workflows/ci.yml/badge.svg)](https://github.com/tucomel/paseo-acp-agy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Overview

`paseo-acp-agy` allows you to use Google Antigravity as a first-class agent provider inside Paseo. It implements the JSON-RPC [Agent Client Protocol](https://agentclientprotocol.com) over standard input/output (`stdio`), dynamically exposing supported models, tracking session token usage, calculating real-time cost, displaying context window usage, and supporting slash commands.

### Features
- **Zero-Downtime Daemon Compatibility**: Conforms to the [Paseo Server & CLI specification](https://paseo.sh/docs#server--cli). Updates to this adapter apply to future agent launches without restarting the Paseo daemon.
- **Dynamic Model Catalog**: Exposes Google Gemini (Flash, Pro) and Anthropic Claude models configured in your Antigravity CLI environment.
- **Usage & Quota Telemetry**: Real-time context window meters, prompt/output token tracking, pricing windows, and quota limit notifications.
- **Session Management**: Native support for session modes (Default / Plan mode), session cancellation, and resume.
- **Slash Commands**: In-session support for `/help`, `/usage`, and `/resume`.

---

## Quick Start in Paseo

### 1. Configure Provider in Paseo

Add `antigravity` under `agents.providers` in your `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "extends": "acp",
        "label": "Antigravity",
        "command": ["npx", "-y", "paseo-acp-agy", "--acp"],
        "enabled": true
      }
    }
  }
}
```

> **Local / Development Setup:**
> If you cloned this repository locally, you can compile and point directly to the binary:
> ```json
> "command": ["node", "/path/to/paseo-acp-agy/dist/index.js"]
> ```
> Or install globally:
> ```bash
> npm install -g paseo-acp-agy
> ```
> And configure `"command": ["paseo-acp-agy"]`.

### 2. Reload Paseo Configuration

Apply changes immediately without restarting the daemon:

```bash
paseo reload
```

### 3. Verify with Diagnostics

Run the official Paseo provider diagnostic command:

```bash
paseo provider diagnostic antigravity
```

List detected models:

```bash
paseo provider models antigravity
```

### 4. Run an Agent

Launch a task directly from your terminal:

```bash
paseo run --provider antigravity "Analyze the repository architecture"
```

Or select **Antigravity** from the provider dropdown in the Paseo Desktop App or Web UI (`https://app.paseo.sh`).

### 5. Official Paseo Catalog Entry

To include `paseo-acp-agy` in Paseo's built-in provider store (`ACP_PROVIDER_CATALOG`), see the [Paseo Catalog Specification](docs/paseo-catalog-entry.md).

---

## Requirements

- **Node.js**: >= 20.0.0 (Node.js 22 recommended)
- **Google Antigravity CLI (`agy`)**: Installed and authenticated in your `PATH` (or specified via `AGY_BIN_PATH`).
- **Paseo**: [Paseo CLI / Daemon](https://paseo.sh/docs#server--cli) (`@getpaseo/cli`) >= 0.7.0.

---

## Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `AGY_BIN_PATH` | Path to the Google Antigravity binary | Auto-detected from `PATH` or `~/.local/bin/agy` |
| `AGY_ACP_LOG_FILE` | Enable debug file logging | Disabled |

---

## Development

```bash
# Clone repository
git clone https://github.com/tucomel/paseo-acp-agy.git
cd paseo-acp-agy

# Install dependencies
npm install

# Typecheck
npm run typecheck

# Run test suite (56+ unit & protocol tests)
npm test

# Build distribution
npm run build

# Test ACP initialization via stdio
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n' | node dist/index.js
```

---

## License

MIT © [Arthur Melo](https://github.com/tucomel)
