/**
 * Canon Workflow Enforcer Plugin (CRU-183)
 *
 * 1. before_agent_start — detects dev work prompts, injects Canon preflight reminder
 * 2. before_prompt_build — injects os/README.md into every session
 * 3. subagent_ended — logs completions to JSONL for Wolverine auto-logger
 * 4. /canon command — shows recent Canon classifications
 */

import { readFileSync, mkdirSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Keywords that signal implementation/dev work
const DEV_KEYWORDS =
  /\b(implement|build|create|fix|update|refactor|code|develop|write\s+code|debug|deploy|migrate|scaffold|feature\/)\b/i;

const CANON_PREFLIGHT = `⚠️ Canon Preflight: Before proceeding, verify you have a Linear issue and have run canon-classify. See os/canon/CANON.md.`;

type CanonConfig = {
  mode: "warn" | "block";
  injectOsReadme: boolean;
  logSubagentCompletions: boolean;
};

function getConfig(pluginConfig?: Record<string, unknown>): CanonConfig {
  return {
    mode: (pluginConfig?.mode as string) === "block" ? "block" : "warn",
    injectOsReadme: pluginConfig?.injectOsReadme !== false,
    logSubagentCompletions: pluginConfig?.logSubagentCompletions !== false,
  };
}

const plugin = {
  id: "canon-enforcer",
  name: "Canon Workflow Enforcer",
  description:
    "Enforces Canon workflow with preflight reminders, OS context injection, and subagent completion logging",

  register(api: OpenClawPluginApi) {
    const cfg = getConfig(api.pluginConfig);

    // ========================================================================
    // Hook: before_agent_start — Dev work detection + Canon preflight
    // ========================================================================
    api.on("before_agent_start", async (event, context) => {
      if (!event.prompt) return;

      if (DEV_KEYWORDS.test(event.prompt)) {
        api.logger.info("canon-enforcer: dev work detected, injecting preflight reminder");
        return { prependContext: CANON_PREFLIGHT };
      }
    });

    // ========================================================================
    // Hook: before_prompt_build — Inject os/README.md
    // ========================================================================
    if (cfg.injectOsReadme) {
      let osReadmeCache: string | null = null;

      api.on("before_prompt_build", async (_event, context) => {
        if (!context.workspaceDir) return;

        if (osReadmeCache === null) {
          const readmePath = join(context.workspaceDir, "os", "README.md");
          try {
            osReadmeCache = readFileSync(readmePath, "utf-8");
          } catch {
            api.logger.warn(`canon-enforcer: os/README.md not found at ${readmePath}`);
            osReadmeCache = "";
          }
        }

        if (osReadmeCache) {
          return {
            prependContext: `<os-framework>\n${osReadmeCache}\n</os-framework>`,
          };
        }
      });
    }

    // ========================================================================
    // Hook: subagent_ended — Log completions to JSONL
    // ========================================================================
    if (cfg.logSubagentCompletions) {
      api.on("subagent_ended", async (event, context) => {
        // Resolve workspace dir from requester context
        const workspaceDir =
          (context as Record<string, unknown>).workspaceDir as string | undefined;

        // Try config workspace as fallback
        const wsDir = workspaceDir || api.config.workspaceDir;
        if (!wsDir) {
          api.logger.warn("canon-enforcer: no workspaceDir available for subagent logging");
          return;
        }

        const logsDir = join(wsDir, "logs");
        try {
          mkdirSync(logsDir, { recursive: true });
        } catch {
          // already exists
        }

        const entry = {
          timestamp: new Date().toISOString(),
          childSessionKey: context.childSessionKey ?? event.targetSessionKey,
          runId: event.runId,
          outcome: event.outcome ?? "unknown",
          reason: event.reason,
          error: event.error,
          endedAt: event.endedAt,
        };

        const logPath = join(logsDir, "subagent-completions.jsonl");
        try {
          appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
          api.logger.info(
            `canon-enforcer: logged subagent completion (${entry.outcome}) → ${logPath}`,
          );
        } catch (err) {
          api.logger.warn(`canon-enforcer: failed to write completion log: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Command: /canon — Show recent Canon status
    // ========================================================================
    api.registerCommand({
      name: "canon",
      description: "Show recent Canon workflow classifications and status",
      acceptsArgs: false,
      handler: (ctx) => {
        const wsDir = ctx.config.workspaceDir;
        if (!wsDir) {
          return { text: "⚠️ No workspace directory configured." };
        }

        const canonLogDir = join(wsDir, "os", "canon", "log");
        let output = "📋 **Canon Status**\n\n";

        // Read recent classifications
        try {
          if (!existsSync(canonLogDir)) {
            output += "_No canon log directory found at os/canon/log/_\n";
          } else {
            const files = readdirSync(canonLogDir)
              .filter((f) => f.endsWith(".jsonl"))
              .sort()
              .slice(-3); // last 3 months

            if (files.length === 0) {
              output += "_No classification logs found._\n";
            } else {
              // Read last 5 classifications across all log files
              const allEntries: Array<{ ts: string; issueId: string; classification: string }> = [];
              for (const file of files.reverse()) {
                try {
                  const lines = readFileSync(join(canonLogDir, file), "utf-8").trim().split("\n");
                  for (const line of lines.reverse()) {
                    if (allEntries.length >= 5) break;
                    try {
                      const entry = JSON.parse(line);
                      allEntries.push({ ts: entry.ts, issueId: entry.issueId, classification: entry.classification });
                    } catch { /* skip malformed */ }
                  }
                } catch { /* skip unreadable */ }
              }
              output += `**Recent classifications** (last ${allEntries.length}):\n`;
              for (const e of allEntries) {
                output += `• ${e.ts?.slice(0, 16)} — \`${e.issueId}\` → **${e.classification}**\n`;
              }
            }
          }
        } catch (err) {
          output += `_Error reading canon logs: ${String(err)}_\n`;
        }

        // Check subagent completion log
        const completionLog = join(wsDir, "logs", "subagent-completions.jsonl");
        try {
          if (existsSync(completionLog)) {
            const lines = readFileSync(completionLog, "utf-8").trim().split("\n");
            const recent = lines.slice(-5);
            output += `\n**Recent subagent completions** (${lines.length} total):\n`;
            for (const line of recent) {
              try {
                const entry = JSON.parse(line);
                output += `• ${entry.timestamp} — ${entry.outcome} (${entry.childSessionKey ?? entry.runId ?? "?"})\n`;
              } catch {
                // skip malformed
              }
            }
          }
        } catch {
          // no log yet
        }

        return { text: output };
      },
    });

    api.logger.info(`canon-enforcer: registered (mode=${cfg.mode}, readme=${cfg.injectOsReadme}, logging=${cfg.logSubagentCompletions})`);
  },
};

export default plugin;
