# pi-openai-toolkit

Add Codex context windows, Responses compaction, hosted tools, and reviewed tool calls to Pi.

[![npm version](https://img.shields.io/npm/v/pi-openai-toolkit.svg)](https://www.npmjs.com/package/pi-openai-toolkit)
[![License: MIT](https://img.shields.io/npm/l/pi-openai-toolkit.svg)](LICENSE)

[简体中文](README.zh.md)

## Features

| Feature | Use it to |
| --- | --- |
| Codex Remote Context | Use the adapted Codex window protocol to start a new context window and retrieve earlier windows with `history`. |
| Remote Compaction v2 | Continue an eligible Responses session with an encrypted server checkpoint. |
| Web Search routes | Choose local `pi-web-access`, hosted Responses `web_search`, or experimental CPA standalone `web_run` per exact model. |
| Image generation | Call the hosted Responses image tool to generate images or edit explicitly supplied local references. |
| Tool-call review | Use Toolkit's approval gate to ask a reviewer model whether selected tool calls may run. |

The package uses Pi's existing model, authentication, and session configuration. It does not add a provider or model.

## Install

Requires Pi 0.85.1 or newer and Node.js 22.19.0 or newer.

```bash
pi install npm:pi-openai-toolkit
```

Use `--local` to install the extension in the current project. Toolkit policy is still global; there are no project or environment policy overlays.

Without a config file, Toolkit is inactive and Pi keeps its native behavior. In v2, only exact entries in `models` activate Toolkit, including an empty `{}` entry. `defaults` are shared templates for those listed models; they do not activate any other model. An identically named model under another provider is separate.

The only Toolkit config file is:

`~/.pi/agent/extensions/pi-openai-toolkit/config.json`

All JSON examples below except the Pi model-registration example use **configuration schema v2**. Create the file and parent directory if absent. Merge examples into an existing v2 document, keeping its other settings. An unversioned legacy file remains supported: do not add v2 fields to it or overwrite it with an example. First use `/toolkit-config migration-preview`; the [configuration reference](docs/configuration.md) explains the review and installed-version checks. Loading config and previewing migration never rewrite the source file.

## Quick start: enable Remote Context

This section is for Codex-style context windows. For search, images, or tool-call review only, skip to [Common tasks](#common-tasks).

### Use Pi's built-in Codex provider

You must already be signed in to Pi's built-in `openai-codex` provider. Create or merge this v2 Toolkit config:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "remote-windows" }
  },
  "models": {
    "openai-codex/<model-id>": {}
  }
}
```

Start Pi with a model from your existing Codex catalog:

```bash
pi --model openai-codex/<model-id>
```

Replace `<model-id>` in both the config and command with the ID shown by your Pi setup. The session is activated when `new_context`, `get_context_remaining`, `history`, and `notes` appear. This verifies activation, not a completed backend round trip.

### Use a compatible gateway

This route requires `openai-responses` and a gateway that preserves Remote Context's Codex protocol fields. A successful ordinary chat request does not prove Remote Context compatibility.

If `~/.pi/agent/models.json` already registers a compatible model, skip registration and set Toolkit's exact model override below. Otherwise, add or merge this Pi provider entry. Replace the provider name, URL, environment variable, and model values with your setup. The numeric limits are examples, not project defaults.

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://your-gateway.example/v1",
      "api": "openai-responses",
      "apiKey": "$MY_GATEWAY_KEY",
      "models": [{
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "reasoning": true,
        "input": ["text"],
        "contextWindow": 272000,
        "maxTokens": 128000
      }]
    }
  }
}
```

Set the referenced key before starting Pi. In PowerShell:

```powershell
$env:MY_GATEWAY_KEY = "replace-with-your-gateway-key"
```

In a POSIX shell:

```bash
export MY_GATEWAY_KEY="replace-with-your-gateway-key"
```

Use the same terminal to start Pi. In the Toolkit config, make the key exactly match the registered provider and model ID:

```json
{
  "schemaVersion": 2,
  "models": {
    "my-gateway/gpt-5.6-luna": {
      "context": { "mode": "remote-windows" },
      "compatibility": { "transport": "codex-gateway" }
    }
  }
}
```

```bash
pi --model my-gateway/gpt-5.6-luna
```

Check for `new_context`, `get_context_remaining`, `history`, and `notes`. If absent, read the notification and check `/toolkit-config`, the exact model key, Pi API, credentials, and base URL. The transport setting opts into a protocol profile; it does not register a model or prove the backend supports it.

Earlier windows remain retrievable through `history`, but are not all automatically inserted into the current context.

## Common tasks

### Continue a session with server-side compaction

Use `context.mode: "remote-compaction"` for the Responses compaction path (the default for listed models), or `"pi"` to relinquish Toolkit context management. Set `context.remoteCompaction.model` only when a separate model should produce the checkpoint. These fields belong under `defaults` or an exact `models` override. An empty entry opts into the built-in defaults:

```json
{
  "schemaVersion": 2,
  "models": {
    "your-provider/your-model": {}
  }
}
```

Switching to an unlisted model disables Toolkit hooks and tools, restores third-party search state, and hands context and compaction to Pi without a Toolkit close-out request. Existing persisted history stays intact; opting out cannot recover original content already replaced by a persisted compaction summary or opaque checkpoint. Toolkit does not replay that checkpoint on the inactive path. Returning to a listed model restores its feature availability; Auto Mode requires explicit engagement again.

`context.remoteCompaction.inputSource` defaults to `"legacy"`: first compaction uses Pi's current session context, with event preparation as a last resort; recursion uses the raw branch tail. This preserves existing behavior but can diverge from provider-visible context when other extensions rewrite messages.

Opt into `"pi-context-hook"` to use the ordered Pi context-hook projection. If that bridge is unavailable, compaction cancels rather than sending unprojected history. Checkpoints are source-specific; switching input sources requires a new checkpoint. See [protocol details](docs/internals.md#remote-compaction-v2-wire-contract).

### Choose a Web Search route

Configure shared defaults for listed models and exact overrides:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "webSearch": { "route": "local" }
  },
  "models": {
    "my-gateway/gpt-5.6-luna": {
      "webSearch": { "route": "hosted" }
    }
  }
}
```

- `unmanaged` releases Toolkit ownership. It does not disable third-party search or all Internet access.
- `local` preserves the original local `pi-web-access` tool state and removes conflicting hosted/standalone tools from provider payloads. It never activates a local tool that was inactive.
- `hosted` replaces the local `web_search` function with the native Responses search tool and source annotations.
- `standalone-alpha` deliberately opts into experimental CPA/Codex gateway search. It exposes sequential `web_run` and sends one isolated request per call to the provider-relative `/alpha/search`, using the current Pi model and credentials. The gateway must actually support that endpoint and capability; Toolkit does not probe or enable it.

Exact overrides win over defaults. There are no patterns, inferred capabilities, or fallback between routes. Invalid selected policy blocks the affected operation instead of choosing another route. The legacy hosted model list remains readable, but its permissive failure behavior is not identical to explicit v2 `hosted`; migration preview flags that difference.

### Generate an image

Image generation requires a listed Responses session and may incur provider charges. Share its output-model policy across listed models:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "imageGeneration": {
      "enabled": true,
      "defaultModel": "gpt-image-2.5",
      "allowedModels": ["gpt-image-2.5", "grok-imagine-image-2.0"]
    }
  },
  "models": {
    "my-gateway/gpt-5.6-luna": {}
  }
}
```

These are bare output-model IDs for the nested Responses `image_generation` tool. List order does not choose the default. `defaultModel` must belong to the nonempty `allowedModels` list; an optional one-call `model` must also be allowed. Invalid policy or a disallowed choice fails before authentication, reference upload, and paid dispatch. The provider must support the chosen model.

`openai_generate_image` accepts text-to-image requests and edits using explicitly supplied local references. Image output policy cannot be overridden per session model; exposure and execution still require that active model's exact `models` entry. Output-model IDs and producer/reviewer references do not activate chat models.

### Review tool calls automatically

Make Auto Mode available to an exact model and choose its reviewer:

```json
{
  "schemaVersion": 2,
  "models": {
    "my-gateway/gpt-5.6-luna": {
      "autoMode": {
        "available": true,
        "reviewerModel": "my-gateway/gpt-5.6-luna"
      }
    }
  }
}
```

`available` permits engagement; use `/auto on` or `--auto` to engage. `/auto off` explicitly disengages it. The default `side-effect` gate covers `bash`, `write`, `edit`, and configured extra tools; `gate: "all"` reviews every tool call. A reviewer timeout does not approve a call. Invalid configuration while engaged keeps a blocking gate until corrected or explicitly turned off.

The TUI shows activation, review activity, and a footer status. Compatible Pi tool renderers also show per-call allowed, denied, blocked, or unreviewed states. If that renderer seam is unavailable, Toolkit warns once and retains the footer display. Reviewer, classifier, and circuit-breaker controls are in the [configuration reference](docs/configuration.md).

### Control Astra reasoning-effort updates

By default, the toolkit preserves Pi's selected request-level reasoning effort. Opt into cache-preserving updates only for a gateway that supports `configuration_update`:

```json
{
  "schemaVersion": 2,
  "models": {
    "your-provider/gpt-6-astra": {
      "reasoning": { "effortOverride": true }
    }
  }
}
```

`defaults.reasoning.effortOverride` supplies an inherited value; an exact model can override it. The built-in default is `false`. Only `gpt-6-astra` on `openai-responses` is eligible, including when the setting is inherited. The first request establishes a baseline; later changes use `input` update items while top-level `reasoning.effort` remains at that baseline. Disabled or invalid settings and other APIs, including `openai-codex-responses`, preserve Pi's selected effort and clear old baselines. The unversioned `reasoning_effort_override` flag remains supported; migration preview maps it to the V2 default. This setting belongs to Toolkit, not Codex's `config.toml`.

## Common configuration

For models explicitly listed in `models`, the global file uses built-ins, then `defaults`, then exact `models["provider/model-id"]` overrides. Missing fields inherit; arrays replace; `false` and `0` are retained. Supported optional model references accept `null` to clear inheritance. Defaults are not master switches: an exact override can enable a feature whose default is disabled.

| Field | Default | Use |
| --- | --- | --- |
| `defaults.reasoning.effortOverride` | `false` | Opt into Astra effort updates on `openai-responses`; exact models can override. |
| `defaults.context.mode` | `"remote-compaction"` | `"pi"`, `"remote-compaction"`, or `"remote-windows"`. |
| `models[exact].compatibility.transport` | `"standard"` | Exact gateway opt-in with `"codex-gateway"`. |
| `defaults.context.remoteCompaction.model` | `null` | Optional checkpoint producer. |
| `defaults.context.remoteCompaction.inputSource` | `"legacy"` | Source-specific checkpoint input policy. |
| `defaults.context.remoteWindows.reminderThresholdPercent` | `5` | `0` disables reminders and exhausted-window fallback. |
| `defaults.webSearch.route` | `"unmanaged"` | Toolkit search ownership policy. |
| `defaults.imageGeneration.enabled` | `false` | Global image-generation switch. |
| `defaults.imageGeneration.defaultModel` | `"gpt-image-2.5"` | Explicit default output model. |
| `defaults.imageGeneration.allowedModels` | `["gpt-image-2.5"]` | Allowed output models, global only. |
| `defaults.autoMode.available` | `false` | Permission to engage tool review. |
| `defaults.autoMode.gate` | `"side-effect"` | Selected side-effect tools or `"all"`. |
| `defaults.autoMode.timeoutMs` | `30000` | Reviewer timeout in milliseconds. |
| `diagnostics.level` | `"info"` | `"debug"` enables debug artifacts. |
| `diagnostics.captureRequests` / `captureResponses` | `false` | Independent request/compact-response capture opt-ins. |

An unversioned legacy file retains its previous global reach. Migration preview preserves explicit legacy model entries even when their overrides equal defaults and flags the narrower v2 reach for review.

Use `/toolkit-config` for activation scope, effective values and origins, `/toolkit-config validate` for document issues, and `/toolkit-config migration-preview` for a read-only legacy candidate. These commands require a UI and perform no network/auth lookup, tool activation, or file writes. Configuration selection does not verify backend support.

Unknown v2 policy keys and malformed values produce scoped errors. Known unlisted models remain native even if defaults or another model's feature policies are invalid; `/toolkit-config validate` still reports those errors. Unknown or unreadable scope is not an opt-out and preserves fail-closed behavior, including an engaged approval gate. Each public callback or tool execution uses one immutable snapshot across its awaited helpers; later operations reread the file. Separate Pi events are not one atomic transaction. See the [complete configuration reference](docs/configuration.md) and [editor schema](config.schema.json).

## Development

From the repository root, after dependencies are installed:

```bash
npm run typecheck
```

```bash
bun test
```

```bash
npm run test:pi
```

```bash
npm pack --dry-run
```

## License

MIT © awoaCrim and contributors. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
