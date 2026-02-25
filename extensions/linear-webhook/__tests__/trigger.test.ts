/**
 * Unit tests for CRU-90: Linear Webhook Trigger logic
 *
 * Tests: writeTrigger dedup, schema validation, HMAC still passes,
 *        extractStoryFilePath, readTriggerLog
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";

// Import from plugin (using relative path from the test file)
import {
  writeTrigger,
  readTriggerLog,
  extractStoryFilePath,
  verifySignature,
  type TriggerEntry,
} from "../index.js";

// ─── Setup/teardown ───────────────────────────────────────────────────────────

let testDir: string;
let triggerFilePath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `linear-webhook-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  triggerFilePath = join(testDir, "linear-triggers.jsonl");
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── writeTrigger ─────────────────────────────────────────────────────────────

describe("writeTrigger", () => {
  const baseEntry = {
    issueId: "CRU-123",
    issueTitle: "Test issue",
    stateId: "99a123f5-1bda-48b0-b0b2-38246e2a50d2",
    triggeredAt: new Date().toISOString(),
    source: "webhook" as const,
    storyFilePath: null,
  };

  it("writes a new pending entry when log is empty", () => {
    const written = writeTrigger(triggerFilePath, baseEntry);
    expect(written).toBe(true);

    const entries = readTriggerLog(triggerFilePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].issueId).toBe("CRU-123");
    expect(entries[0].status).toBe("pending");
  });

  it("creates the logs directory if it does not exist", () => {
    const deepPath = join(testDir, "deep", "logs", "triggers.jsonl");
    writeTrigger(deepPath, baseEntry);
    expect(existsSync(deepPath)).toBe(true);
  });

  it("deduplicates: does not write if pending entry already exists", () => {
    writeTrigger(triggerFilePath, baseEntry);
    const written2 = writeTrigger(triggerFilePath, { ...baseEntry, source: "poll" });
    expect(written2).toBe(false);

    const entries = readTriggerLog(triggerFilePath);
    expect(entries).toHaveLength(1);
  });

  it("deduplicates: does not write if spawned entry already exists", () => {
    writeTrigger(triggerFilePath, baseEntry);

    // Manually update status to "spawned" in the file
    const entries = readTriggerLog(triggerFilePath);
    const updated = entries.map((e) =>
      e.issueId === "CRU-123" ? { ...e, status: "spawned" as const } : e
    );

    writeFileSync(triggerFilePath, updated.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const written2 = writeTrigger(triggerFilePath, baseEntry);
    expect(written2).toBe(false);
  });

  it("allows writing a new entry for a different issueId", () => {
    writeTrigger(triggerFilePath, baseEntry);
    const written = writeTrigger(triggerFilePath, { ...baseEntry, issueId: "CRU-456", issueTitle: "Different issue" });
    expect(written).toBe(true);

    const entries = readTriggerLog(triggerFilePath);
    expect(entries).toHaveLength(2);
  });

  it("does NOT deduplicate skipped entries (allows re-trigger)", () => {
    writeTrigger(triggerFilePath, baseEntry);

    // Manually mark as "skipped"
    const entries = readTriggerLog(triggerFilePath);
    const updated = entries.map((e) =>
      e.issueId === "CRU-123" ? { ...e, status: "skipped" as const } : e
    );

    writeFileSync(triggerFilePath, updated.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const written2 = writeTrigger(triggerFilePath, baseEntry);
    expect(written2).toBe(true);
  });
});

// ─── Schema validation ────────────────────────────────────────────────────────

describe("TriggerEntry schema", () => {
  it("includes all required fields", () => {
    const now = new Date().toISOString();
    writeTrigger(triggerFilePath, {
      issueId: "CRU-99",
      issueTitle: "My issue",
      stateId: "99a123f5-1bda-48b0-b0b2-38246e2a50d2",
      triggeredAt: now,
      source: "poll",
      storyFilePath: "_bmad-output/stories/cruzbot/epic-2-story-2-test.md",
    });

    const entries = readTriggerLog(triggerFilePath);
    const entry = entries[0];

    expect(entry).toHaveProperty("issueId", "CRU-99");
    expect(entry).toHaveProperty("issueTitle", "My issue");
    expect(entry).toHaveProperty("stateId", "99a123f5-1bda-48b0-b0b2-38246e2a50d2");
    expect(entry).toHaveProperty("triggeredAt", now);
    expect(entry).toHaveProperty("source", "poll");
    expect(entry).toHaveProperty("status", "pending");
    expect(entry).toHaveProperty("storyFilePath", "_bmad-output/stories/cruzbot/epic-2-story-2-test.md");
  });

  it("stores null storyFilePath when not provided", () => {
    writeTrigger(triggerFilePath, {
      issueId: "CRU-100",
      issueTitle: "No story",
      stateId: "99a123f5-1bda-48b0-b0b2-38246e2a50d2",
      triggeredAt: new Date().toISOString(),
      source: "webhook",
      storyFilePath: null,
    });
    const entries = readTriggerLog(triggerFilePath);
    expect(entries[0].storyFilePath).toBeNull();
  });
});

// ─── extractStoryFilePath ─────────────────────────────────────────────────────

describe("extractStoryFilePath", () => {
  it("extracts path from issue description with standard BMAD pattern", () => {
    const desc = "See story file at _bmad-output/stories/cruzbot/epic-2-story-2-my-story.md for details.";
    expect(extractStoryFilePath(desc)).toBe("_bmad-output/stories/cruzbot/epic-2-story-2-my-story.md");
  });

  it("extracts path from markdown link syntax", () => {
    const desc = "Story: [link](_bmad-output/stories/cruzbot/epic-1-story-3-test.md)";
    expect(extractStoryFilePath(desc)).toBe("_bmad-output/stories/cruzbot/epic-1-story-3-test.md");
  });

  it("returns null when no story path found", () => {
    expect(extractStoryFilePath("No story file mentioned here.")).toBeNull();
    expect(extractStoryFilePath(null)).toBeNull();
    expect(extractStoryFilePath(undefined)).toBeNull();
    expect(extractStoryFilePath("")).toBeNull();
  });

  it("extracts path from quoted string", () => {
    const desc = `Story file: "_bmad-output/stories/cruzbot/epic-3-story-1-something.md"`;
    expect(extractStoryFilePath(desc)).toBe("_bmad-output/stories/cruzbot/epic-3-story-1-something.md");
  });
});

// ─── HMAC signature validation ────────────────────────────────────────────────

describe("verifySignature (HMAC SHA-256)", () => {
  const secret = "test-webhook-secret-abc123";
  const body = JSON.stringify({ type: "Issue", action: "update", data: { id: "xyz" } });

  it("returns true for a valid signature", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    expect(verifySignature(body, "deadbeefdeadbeef", secret)).toBe(false);
  });

  it("returns false when secret is empty", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(body, sig, "")).toBe(false);
  });

  it("returns false when signature is empty", () => {
    expect(verifySignature(body, "", secret)).toBe(false);
  });

  it("returns false for tampered body", () => {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    const tampered = body + "extra";
    expect(verifySignature(tampered, sig, secret)).toBe(false);
  });
});

// ─── readTriggerLog ───────────────────────────────────────────────────────────

describe("readTriggerLog", () => {
  it("returns empty array when file does not exist", () => {
    const entries = readTriggerLog(join(testDir, "nonexistent.jsonl"));
    expect(entries).toEqual([]);
  });

  it("parses multiple entries from JSONL", () => {
    const e1 = {
      issueId: "CRU-1",
      issueTitle: "First",
      stateId: "abc",
      triggeredAt: new Date().toISOString(),
      source: "webhook" as const,
      status: "pending" as const,
      storyFilePath: null,
    };
    const e2 = {
      issueId: "CRU-2",
      issueTitle: "Second",
      stateId: "abc",
      triggeredAt: new Date().toISOString(),
      source: "poll" as const,
      status: "spawned" as const,
      storyFilePath: "_bmad-output/stories/cruzbot/epic-1-story-1.md",
    };


    writeFileSync(triggerFilePath, [e1, e2].map((e) => JSON.stringify(e)).join("\n") + "\n");

    const entries = readTriggerLog(triggerFilePath);
    expect(entries).toHaveLength(2);
    expect(entries[0].issueId).toBe("CRU-1");
    expect(entries[1].issueId).toBe("CRU-2");
    expect(entries[1].status).toBe("spawned");
  });
});
