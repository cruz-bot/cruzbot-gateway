/**
 * Linear Webhook Bridge Plugin (CRU-188 + CRU-90)
 *
 * 1. HTTP endpoint at /webhooks/linear — receives Linear webhooks, validates HMAC signature
 * 2. Logs issue state change events to JSONL
 * 3. /linear-poll command — polls Linear GraphQL API for recent issue changes
 * 4. Trigger file + direct spawn on "In Dev" state change (CRU-90)
 */

import { createHmac } from "node:crypto";
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// State ID → label mapping
const STATE_MAP: Record<string, string> = {
  "99a123f5-1bda-48b0-b0b2-38246e2a50d2": "ready for dev",
  "83a9ff51-748f-4242-96d7-2df175e6c2bb": "completed",
  "b26e9e94-919c-45a3-a62f-4ec89d234e8c": "ready for QA",
};

const IN_DEV_STATE_ID = "99a123f5-1bda-48b0-b0b2-38246e2a50d2";

type PluginConfig = {
  webhookSecret: string;
  teamId: string;
  logEvents: boolean;
};

export type TriggerEntry = {
  issueId: string;
  issueTitle: string;
  stateId: string;
  triggeredAt: string;
  source: "webhook" | "poll";
  status: "pending" | "spawned" | "skipped";
  storyFilePath: string | null;
};

function getConfig(pluginConfig?: Record<string, unknown>): PluginConfig {
  return {
    webhookSecret: (pluginConfig?.webhookSecret as string) ?? "",
    teamId: (pluginConfig?.teamId as string) ?? "",
    logEvents: pluginConfig?.logEvents !== false,
  };
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!secret || !signature) return false;
  const computed = createHmac("sha256", secret).update(body).digest("hex");
  return computed === signature;
}

function logEvent(workspaceDir: string, event: Record<string, unknown>): void {
  const logsDir = join(workspaceDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  appendFileSync(
    join(logsDir, "linear-webhook-events.jsonl"),
    JSON.stringify({ ...event, loggedAt: new Date().toISOString() }) + "\n"
  );
}

/**
 * Read all trigger entries from the JSONL log.
 */
export function readTriggerLog(triggerFilePath: string): TriggerEntry[] {
  if (!existsSync(triggerFilePath)) return [];
  const lines = readFileSync(triggerFilePath, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as TriggerEntry);
}

/**
 * Derive story file path from issue description using standard BMAD pattern.
 */
export function extractStoryFilePath(description: string | undefined | null): string | null {
  if (!description) return null;
  const match = description.match(/_bmad-output\/stories\/[^\s"'\)]+\.md/);
  return match ? match[0] : null;
}

/**
 * Append a trigger entry to the JSONL log.
 * Deduplicates by issueId: skips if a pending or spawned entry already exists.
 * Returns true if written, false if deduped.
 */
export function writeTrigger(
  triggerFilePath: string,
  entry: Omit<TriggerEntry, "status">
): boolean {
  const logsDir = join(triggerFilePath, "..");
  mkdirSync(logsDir, { recursive: true });

  const existing = readTriggerLog(triggerFilePath);
  const alreadyExists = existing.some(
    (e) =>
      e.issueId === entry.issueId &&
      (e.status === "pending" || e.status === "spawned")
  );
  if (alreadyExists) return false;

  const fullEntry: TriggerEntry = { ...entry, status: "pending" };
  appendFileSync(triggerFilePath, JSON.stringify(fullEntry) + "\n");
  return true;
}

function linearGraphQL(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return Promise.reject(new Error("LINEAR_API_KEY not set"));

  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: "api.linear.app",
        path: "/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export function register(api: OpenClawPluginApi): void {
  const cfg = getConfig(api.pluginConfig);
  const workspaceDir = join(api.config.dataDir ?? process.cwd(), "workspace");
  const triggerFilePath = join(workspaceDir, "logs", "linear-triggers.jsonl");

  // --- HTTP Webhook Endpoint ---
  api.registerHttpRoute({
    path: "/webhooks/linear",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("Method Not Allowed");
        return;
      }

      const rawBody = await parseBody(req);

      // Validate signature
      const signature = req.headers["x-linear-signature"] as string | undefined;
      if (cfg.webhookSecret && !verifySignature(rawBody, signature ?? "", cfg.webhookSecret)) {
        api.logger.warn("Linear webhook: invalid signature");
        res.writeHead(401);
        res.end("Invalid signature");
        return;
      }

      // Return 200 immediately
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      // Process async
      try {
        const payload = JSON.parse(rawBody);
        const { type, action, data, updatedFrom } = payload;

        // Filter: only Issue updates with state changes
        if (type !== "Issue" || action !== "update") return;
        if (!updatedFrom?.stateId) return;

        // Filter by team if configured
        if (cfg.teamId && data?.teamId !== cfg.teamId) return;

        const newStateId = data?.stateId ?? data?.state?.id;
        const label = STATE_MAP[newStateId];
        const issueId = data?.identifier ?? data?.id ?? "unknown";
        const issueTitle: string = data?.title ?? "";

        api.logger.info(
          `Linear webhook: ${issueId} state changed → ${label ?? newStateId}`
        );

        if (cfg.logEvents) {
          logEvent(workspaceDir, {
            type: "state_change",
            issueId,
            issueTitle,
            fromStateId: updatedFrom.stateId,
            toStateId: newStateId,
            label: label ?? "other",
            teamId: data?.teamId,
          });
        }

        // CRU-90: Trigger on "In Dev" state change
        if (newStateId === IN_DEV_STATE_ID) {
          const storyFilePath = extractStoryFilePath(data?.description as string | undefined);
          const written = writeTrigger(triggerFilePath, {
            issueId,
            issueTitle,
            stateId: newStateId,
            triggeredAt: new Date().toISOString(),
            source: "webhook",
            storyFilePath,
          });

          if (written) {
            api.logger.info(`Linear trigger written for ${issueId} (webhook)`);
          } else {
            api.logger.info(`Linear trigger deduped for ${issueId} (webhook) — already pending/spawned`);
          }

          // AC9: Direct spawn attempt — real-time path
          try {
            const spawnResult = await (api as any).sessions?.spawn({
              task: `Implement ${issueId}: ${issueTitle}. Story file: ${storyFilePath ?? "not found - check _bmad-output/stories/cruzbot/"}. Follow Canon workflow. Read story file first.`,
              label: `dev-${issueId}`,
              model: "anthropic/claude-sonnet-4-6",
              mode: "run",
            });
            if (spawnResult) {
              api.logger.info(`Linear direct spawn succeeded for ${issueId}: ${JSON.stringify(spawnResult)}`);
            }
          } catch (spawnErr) {
            api.logger.info(`Linear direct spawn unavailable for ${issueId}, trigger file will be used: ${spawnErr}`);
          }
        }
      } catch (err) {
        api.logger.error(`Linear webhook processing error: ${err}`);
      }
    },
  });

  // --- /linear-poll Command ---
  api.registerCommand({
    name: "linear-poll",
    description: "Poll Linear for recently changed issues",
    handler: async () => {
      const teamId = cfg.teamId;
      if (!teamId) return "⚠️ No teamId configured in plugin config.";

      const query = `
        query RecentIssues($teamId: String!) {
          issues(
            filter: { team: { id: { eq: $teamId } }, updatedAt: { gte: "${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}" } }
            orderBy: updatedAt
            first: 15
          ) {
            nodes {
              identifier
              title
              description
              state { name id }
              updatedAt
              assignee { name }
            }
          }
        }
      `;

      try {
        const result = (await linearGraphQL(query, { teamId })) as {
          data?: { issues?: { nodes?: Array<Record<string, unknown>> } };
        };
        const issues = result?.data?.issues?.nodes ?? [];
        if (issues.length === 0) return "No recently changed issues found.";

        // CRU-90: Check for "In Dev" issues not yet in trigger log
        let triggeredCount = 0;
        for (const issue of issues) {
          const state = issue.state as Record<string, string> | undefined;
          if (state?.id === IN_DEV_STATE_ID) {
            const issueId = issue.identifier as string;
            const issueTitle = issue.title as string;
            const storyFilePath = extractStoryFilePath(issue.description as string | undefined);

            const written = writeTrigger(triggerFilePath, {
              issueId,
              issueTitle,
              stateId: IN_DEV_STATE_ID,
              triggeredAt: new Date().toISOString(),
              source: "poll",
              storyFilePath,
            });

            if (written) {
              triggeredCount++;
              api.logger.info(`Linear trigger written for ${issueId} (poll)`);

              // AC9: Direct spawn attempt from poll
              try {
                const spawnResult = await (api as any).sessions?.spawn({
                  task: `Implement ${issueId}: ${issueTitle}. Story file: ${storyFilePath ?? "not found - check _bmad-output/stories/cruzbot/"}. Follow Canon workflow. Read story file first.`,
                  label: `dev-${issueId}`,
                  model: "anthropic/claude-sonnet-4-6",
                  mode: "run",
                });
                if (spawnResult) {
                  api.logger.info(`Linear direct spawn succeeded for ${issueId} (poll): ${JSON.stringify(spawnResult)}`);
                }
              } catch (spawnErr) {
                api.logger.info(`Linear direct spawn unavailable for ${issueId} (poll), trigger file will be used: ${spawnErr}`);
              }
            }
          }
        }

        const lines = issues.map((i: Record<string, unknown>) => {
          const state = i.state as Record<string, string> | undefined;
          const assignee = i.assignee as Record<string, string> | undefined;
          return `• **${i.identifier}** ${i.title} → _${state?.name ?? "?"}_ (${assignee?.name ?? "unassigned"})`;
        });

        const triggerNote = triggeredCount > 0 ? `\n\n🤖 Triggered ${triggeredCount} new dev agent(s) via trigger file.` : "";
        return `**Recently changed issues (last 24h):**\n${lines.join("\n")}${triggerNote}`;
      } catch (err) {
        return `❌ Linear poll failed: ${err}`;
      }
    },
  });

  api.logger.info(
    `Linear Webhook Bridge loaded. Endpoint: /plugins/linear-webhook/webhooks/linear`
  );
}
