# Paseo Catalog Entry Specification

This document defines the official catalog entry and metadata required to publish **Google Antigravity (`paseo-acp-agy`)** in Paseo's built-in provider store/catalog (`ACP_PROVIDER_CATALOG`).

---

## 1. Official Catalog Metadata (`ACP_PROVIDER_CATALOG`)

In Paseo's web UI and desktop clients (`@getpaseo/server`), community ACP agents are registered in `ACP_PROVIDER_CATALOG`.

### Entry Definition (TypeScript)

```typescript
{
  id: "antigravity",
  title: "Google Antigravity",
  description: "Autonomous AI pair programming agent by Google DeepMind via Antigravity CLI",
  version: "1.1.0",
  iconId: "agy",
  installLink: "https://github.com/tucomel/paseo-acp-agy",
  command: ["npx", "-y", "paseo-acp-agy@1.1.0", "--acp"]
}
```

### Explanation of Fields

| Field | Value | Purpose |
|---|---|---|
| `id` | `"antigravity"` | Unique provider identifier in Paseo (`/^[a-z][a-z0-9-]*$/`). |
| `title` | `"Google Antigravity"` | Display title in Paseo UI and model selector. |
| `description` | Description string | Summary shown in the Paseo Provider Store / Settings. |
| `version` | `"1.1.0"` | Current published semver release. |
| `iconId` | `"agy"` | Associated icon identifier (already recognized in Paseo's `KNOWN_PROVIDER_ICON_NAMES`). |
| `installLink` | `https://github.com/tucomel/paseo-acp-agy` | Link to documentation / repository. |
| `command` | `["npx", "-y", "paseo-acp-agy@1.1.0", "--acp"]` | Zero-install launcher command executed by Paseo daemon. |

---

## 2. Icon Asset (SVG)

Paseo's UI registers icon identifiers in `KNOWN_PROVIDER_ICON_NAMES`. Paseo already includes `"agy"` in its list of known icons. For standalone embedding or custom rendering, here is the official Antigravity SVG icon markup:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
</svg>
```

---

## 3. End-User Installation (Without Waiting for Catalog PR)

Any Paseo user can immediately use Google Antigravity today without waiting for Paseo's upstream catalog release by adding the provider to `~/.paseo/config.json`:

### Option A: Via `npx` (Automatic, no global install required)

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "extends": "acp",
        "label": "Google Antigravity",
        "description": "Google Antigravity ACP adapter for autonomous coding",
        "command": ["npx", "-y", "paseo-acp-agy@1.1.0", "--acp"]
      }
    }
  }
}
```

### Option B: Via Global npm Install

```bash
npm install -g paseo-acp-agy
```

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "extends": "acp",
        "label": "Google Antigravity",
        "description": "Google Antigravity ACP adapter for autonomous coding",
        "command": ["paseo-acp-agy", "--acp"]
      }
    }
  }
}
```

### Hot Reload

After editing `~/.paseo/config.json`:

```bash
paseo reload
```

Verify connection:

```bash
paseo provider diagnostic antigravity
```

Expected output:
```
Antigravity (ACP)
  Provider ID: antigravity
  Status: Ready
  Models: 7
```

---

## 4. Submitting to Upstream Paseo

To contribute `paseo-acp-agy` to Paseo's official catalog:

1. Fork [getpaseo/paseo](https://github.com/getpaseo/paseo).
2. Locate `ACP_PROVIDER_CATALOG` in `packages/server` or `src/providers/acp/catalog.ts`.
3. Append the entry shown in Section 1.
4. Submit a Pull Request titled:
   `feat(providers): add Google Antigravity (paseo-acp-agy) to ACP catalog`
