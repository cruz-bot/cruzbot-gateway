# CruzBot — Custom Gateway Fork

This is the `cruzbot` branch of the OpenClaw gateway fork. It contains custom plugins, patches, and extensions that power CruzBot 💠 — Tony Cruz's personal AI co-builder.

## Branch Strategy

- `main` — tracks upstream `openclaw/openclaw` main (periodic syncs)
- `cruzbot` — our working branch; all custom work lives here
- Feature branches merge into `cruzbot`, not `main`

## Custom Plugins (Live)

All plugins live in `~/.openclaw/extensions/` (local override takes priority over stock).
Source files are `.ts` (TypeScript, loaded natively by OpenClaw runtime).

| Plugin | Issue | Status | What it does |
|--------|-------|--------|-------------|
| `canon-enforcer` | CRU-183 | ✅ Live | Enforces Canon workflow phases; injects `os/README.md` into prompts; blocks Canon violations |
| `context-injector` | CRU-189/198 | ✅ Live | Injects Wolverine lessons + daily memory notes into every session |
| `wolverine-logger` | CRU-187 | ✅ Live | Auto-logs all subagent completions to structured markdown; auto-prunes |
| `model-routing-enforcer` | CRU-197 | ✅ Live | Warns/blocks on model tier mismatches; `/model-audit` command |
| `plugin-health-monitor` | CRU-194 | ✅ Live | Health-checks all plugins on startup; `/plugin-health` command |
| `memory-lancedb` | — | ✅ Live | Vector memory via LanceDB + Gemini embeddings; auto-recall per session |
| `linear-webhook` | CRU-188 | 🔧 Built | HTTP endpoint for Linear webhooks + `/linear-poll`; **spawn wiring pending** |
| `subagent-chainer` | CRU-190 | 🔧 Built | Sequential multi-step agent chain orchestration; `/chain-status` command |
| `diagnostics-otel` | — | ✅ Live | OpenTelemetry tracing |

## CruzBot 2.0 — Evolution Status

CruzBot 2.0 is not a separate app — it's the progressive evolution of me (CruzBot) through OpenClaw plugins, workspace scripts, and gateway customizations.

### Epic Status

| Epic | Description | Status |
|------|-------------|--------|
| **E1: Foundation** | OS scripts (Canon/Neo/Wolverine/Evolve) + model routing | ✅ Done |
| **E2: Event-Driven** | Linear↔GitHub↔Agent automation | 🔧 In Progress |
| **E3: Vector Memory** | LanceDB semantic recall | ✅ Done (LanceDB, not Qdrant) |
| **E4: Knowledge Graph** | Neo4j relational reasoning | 📋 Future |
| **E5: Web Dashboard** | Single pane of glass | 📋 Future |
| **E6: VS Code Extension** | "Ask CruzBot" from IDE | 📋 Future |

### E2 Gap: What's Left

The `linear-webhook` + `subagent-chainer` plugins are built. The missing wire:

```
Linear issue → "In Dev"
  → linear-webhook (receives/logs) 
  → [MISSING: spawn logic]
  → subagent-chainer 
  → dev agent auto-starts
```

Remaining work: CRU-90 — add spawn-on-state-change to `linear-webhook` plugin.

## openclaw.json Plugin Config

```json
{
  "plugins": {
    "allow": [
      "diagnostics-otel", "telegram", "google-gemini-cli-auth",
      "memory-lancedb", "wolverine-logger", "context-injector",
      "linear-webhook", "model-routing-enforcer", "plugin-health-monitor",
      "subagent-chainer", "canon-enforcer"
    ],
    "slots": { "memory": "memory-lancedb" }
  }
}
```

## Key Paths

| Resource | Path |
|----------|------|
| Local extensions | `~/.openclaw/extensions/` |
| OpenClaw config | `~/.openclaw/openclaw.json` |
| Workspace | `~/.openclaw/workspace/` |
| OS scripts | `workspace/scripts/os/` |
| Daily memory | `workspace/memory/YYYY-MM-DD.md` |
| Subagent logs | `workspace/logs/subagents/` |
| Plugin health log | `workspace/logs/plugin-health.json` |
| Linear webhook events | `workspace/logs/linear-webhook-events.jsonl` |
| Subagent chains | `workspace/logs/subagent-chains.jsonl` |

## Upstream Sync

To sync with upstream OpenClaw:
```bash
git fetch upstream
git checkout main
git merge upstream/main
git checkout cruzbot
git merge main
# Resolve any conflicts, then push
git push origin cruzbot
```

Last upstream sync: 2026-02-25 (v2026.2.24)
