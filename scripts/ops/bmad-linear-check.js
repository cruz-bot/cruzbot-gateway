#!/usr/bin/env node
/**
 * bmad-linear-check.js — BMAD → Linear Auto-Sync (CRU-89)
 *
 * Scans _bmad-output/stories/ for story files not yet synced to Linear.
 * Uses a manifest (.linear-sync.json) as the dedup gate.
 * For unsynced stories, calls bmad-to-linear-v2.js as a child process.
 *
 * Usage:
 *   node scripts/ops/bmad-linear-check.js [--dry-run] [--project <name>]
 *
 * Flags:
 *   --dry-run   Report what would be synced without creating anything
 *   --project   Linear project name (default: CruzBot)
 *
 * Exit: always 0 (errors are logged as warnings, never abort heartbeat)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Config ──────────────────────────────────────────────────────────────────

const WORKSPACE = path.resolve(__dirname, '..', '..');
const STORIES_DIR = path.join(WORKSPACE, '_bmad-output', 'stories');
const MANIFEST_PATH = path.join(STORIES_DIR, '.linear-sync.json');
const BMAD_SCRIPT = path.join(WORKSPACE, 'scripts', 'bmad-to-linear-v2.js');

/** Files whose names match these patterns (case-insensitive) are skipped. */
const SKIP_NAMES = ['INDEX.md', 'README.md', 'PLANNING.md', 'CHANGELOG.md'];

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const projectIdx = args.indexOf('--project');
const PROJECT = projectIdx !== -1 ? args[projectIdx + 1] : 'CruzBot';

// ── Manifest helpers ─────────────────────────────────────────────────────────

/**
 * @typedef {{ storyFilePath: string, issueId: string, issueIdentifier: string, syncedAt: string }} ManifestEntry
 * @typedef {{ version: number, entries: ManifestEntry[] }} Manifest
 */

/** Load manifest from disk (creates empty manifest if missing). */
function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { version: 1, entries: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.warn(`⚠️  Could not parse manifest — starting fresh: ${err.message}`);
    return { version: 1, entries: [] };
  }
}

/** Persist manifest to disk. */
function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** Build a Set of already-synced story paths (normalised to forward slashes). */
function syncedPaths(manifest) {
  return new Set(manifest.entries.map(e => normalizePath(e.storyFilePath)));
}

// ── Story scanning ───────────────────────────────────────────────────────────

/** True if the file looks like a story file (not an index/planning doc). */
function isStoryFile(filePath) {
  const name = path.basename(filePath);
  if (SKIP_NAMES.includes(name)) return false;
  if (!name.endsWith('.md')) return false;
  // Must contain "story" anywhere in the name (catches all known patterns)
  return /story/i.test(name);
}

/**
 * Recursively collect all story .md files under dir.
 * Returns paths relative to WORKSPACE (forward slashes).
 */
function scanStories(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanStories(fullPath));
    } else if (isStoryFile(fullPath)) {
      results.push(normalizePath(path.relative(WORKSPACE, fullPath)));
    }
  }
  return results;
}

/** Normalise Windows backslashes → forward slashes for consistent keys. */
function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

// ── Linear sync ──────────────────────────────────────────────────────────────

/**
 * Call bmad-to-linear-v2.js for a single story file.
 * Returns { success, issueId, issueIdentifier } or null on failure.
 *
 * NOTE: bmad-to-linear-v2.js currently operates on a *directory* + project name.
 * We call it with a temp dir containing only the target story file (symlink-free,
 * copy approach) so dedup remains in our manifest, not the upstream script.
 *
 * Alternatively, if the upstream script gains --story support, update this call.
 */
function syncStory(relPath) {
  const absPath = path.join(WORKSPACE, relPath.replace(/\//g, path.sep));

  // Create a temp directory with just this one file
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bmad-sync-'));
  const tmpFile = path.join(tmpDir, path.basename(absPath));

  try {
    fs.copyFileSync(absPath, tmpFile);

    const result = spawnSync(process.execPath, [BMAD_SCRIPT, tmpDir, PROJECT], {
      cwd: WORKSPACE,
      encoding: 'utf8',
      timeout: 60_000,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = result.stderr ? result.stderr.trim() : '(no stderr)';
      throw new Error(`Script exited ${result.status}: ${stderr}`);
    }

    // Parse issueIdentifier from stdout (e.g. "✅ Created CRU-123:")
    const stdout = result.stdout || '';
    const match = stdout.match(/Created\s+(CRU-\d+)\s*:/);
    const issueIdentifier = match ? match[1] : null;

    // Try to extract UUID from the Linear URL in stdout
    const urlMatch = stdout.match(/linear\.app\/[^/]+\/issue\/([a-f0-9-]{36})/);
    const issueId = urlMatch ? urlMatch[1] : null;

    return { success: true, issueId: issueId || 'unknown', issueIdentifier: issueIdentifier || 'unknown' };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log(`\n🔄 BMAD → Linear Auto-Sync${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`   Stories dir : ${STORIES_DIR}`);
  console.log(`   Manifest    : ${MANIFEST_PATH}`);
  console.log(`   Project     : ${PROJECT}\n`);

  // 1. Load manifest
  const manifest = loadManifest();
  const alreadySynced = syncedPaths(manifest);

  // 2. Scan stories
  const allStories = scanStories(STORIES_DIR);
  console.log(`📂 Found ${allStories.length} story file(s) total`);

  // 3. Gap detection
  const unsynced = allStories.filter(p => !alreadySynced.has(p));
  const syncedCount = allStories.length - unsynced.length;

  console.log(`✅ Already synced : ${syncedCount}`);
  console.log(`⚠️  Unsynced      : ${unsynced.length}\n`);

  if (unsynced.length === 0) {
    console.log('🎉 All stories are synced. Nothing to do.');
    return;
  }

  // 4. Report or sync
  if (DRY_RUN) {
    console.log('📋 Would sync the following stories:');
    for (const story of unsynced) {
      console.log(`   • ${story}`);
    }
    console.log(`\n[DRY RUN] No issues created. Run without --dry-run to sync.`);
    return;
  }

  // 5. Sync each unsynced story
  let successCount = 0;
  let failCount = 0;

  for (const relPath of unsynced) {
    process.stdout.write(`   Syncing ${path.basename(relPath)} ... `);
    const result = syncStory(relPath);

    if (result.success) {
      const entry = {
        storyFilePath: relPath,
        issueId: result.issueId,
        issueIdentifier: result.issueIdentifier,
        syncedAt: new Date().toISOString(),
      };
      manifest.entries.push(entry);
      saveManifest(manifest); // Save after each success (partial sync safety)
      console.log(`✅ ${result.issueIdentifier}`);
      successCount++;
    } else {
      console.log(`⚠️  WARN: ${result.error}`);
      failCount++;
    }
  }

  console.log(`\n📊 Sync complete: ${successCount} created, ${failCount} failed`);
  if (failCount > 0) {
    console.log(`   ⚠️  Failures are non-fatal. Re-run to retry failed stories.`);
  }
  console.log(`   📄 Manifest: ${MANIFEST_PATH}`);
}

// Always exit 0 — errors are warnings, never block the heartbeat
try {
  main();
} catch (err) {
  console.error(`⚠️  Unexpected error in bmad-linear-check: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
}
process.exit(0);
