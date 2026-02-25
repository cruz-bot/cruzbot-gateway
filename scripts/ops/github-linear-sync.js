#!/usr/bin/env node
/**
 * github-linear-sync.js — CRU-92
 * Poll watched GitHub repos for recently merged PRs and auto-close linked Linear issues.
 *
 * Usage: node scripts/ops/github-linear-sync.js [--hours N] [--dry-run]
 *
 * Rules:
 *  - Node built-ins + gh CLI only (no npm deps)
 *  - LINEAR_API_KEY env var (no Bearer prefix)
 *  - Exit 0 always — failures are logged, never crash
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────

const GH_CLI = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const WATCHED_REPOS = ['VTOR-Tech/knowledgebase-console', 'cruz-bot/cruzbot-gateway'];
const DONE_STATE_ID = '83a9ff51-748f-4242-96d7-2df175e6c2bb';
const SKIP_STATE_NAMES = ['Done', 'Canceled', 'Duplicate'];
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;

const WORKSPACE = path.resolve(__dirname, '..', '..');
const DEDUP_LOG = path.join(WORKSPACE, 'logs', 'github-linear-sync.jsonl');

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const hoursIdx = args.indexOf('--hours');
const hoursArg = hoursIdx !== -1 ? parseInt(args[hoursIdx + 1], 10) : 2;
const LOOKBACK_HOURS = isNaN(hoursArg) ? 2 : hoursArg;
const DRY_RUN = args.includes('--dry-run');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function warn(msg) {
  console.warn(`[WARN] ${msg}`);
}

function log(msg) {
  console.log(msg);
}

/** Extract CRU-XXX from a string. Returns first match or null. */
function extractIssueId(text) {
  if (!text) return null;
  const match = text.match(/CRU-(\d+)/i);
  return match ? `CRU-${match[1]}` : null;
}

/**
 * Extract CRU-XXX from a PR object, in priority order:
 *   1. branch name (head.ref)
 *   2. PR title
 *   3. PR body
 */
function extractIssueIdFromPR(pr) {
  return (
    extractIssueId(pr.head && pr.head.ref) ||
    extractIssueId(pr.title) ||
    extractIssueId(pr.body) ||
    null
  );
}

/** Load existing dedup entries as a Set of "repo:prNumber" keys. */
function loadDedup() {
  const processed = new Set();
  if (!fs.existsSync(DEDUP_LOG)) return processed;
  try {
    const lines = fs.readFileSync(DEDUP_LOG, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line);
      processed.add(`${entry.repo}:${entry.prNumber}`);
    }
  } catch (e) {
    warn(`Failed to load dedup log: ${e.message}`);
  }
  return processed;
}

/** Append a dedup entry to the log. */
function appendDedup(entry) {
  if (DRY_RUN) { log(`[DRY-RUN] Would append dedup entry: ${JSON.stringify(entry)}`); return; }
  try {
    fs.mkdirSync(path.dirname(DEDUP_LOG), { recursive: true });
    fs.appendFileSync(DEDUP_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    warn(`Failed to append dedup log: ${e.message}`);
  }
}

/** Fetch merged PRs from a GitHub repo via gh CLI. */
function fetchMergedPRs(repo, lookbackMs) {
  const cutoff = new Date(Date.now() - lookbackMs);
  try {
    const raw = execFileSync(
      GH_CLI,
      ['api', `repos/${repo}/pulls?state=closed&sort=updated&per_page=30`],
      { encoding: 'utf8', timeout: 30000 }
    );
    const pulls = JSON.parse(raw);
    return pulls.filter((pr) => {
      if (!pr.merged_at) return false;
      return new Date(pr.merged_at) >= cutoff;
    });
  } catch (e) {
    warn(`Failed to fetch PRs for ${repo}: ${e.message}`);
    return [];
  }
}

/** Query Linear for issue state. Returns { id, name, stateId, stateName } or null. */
function getLinearIssue(issueId) {
  return new Promise((resolve) => {
    if (!LINEAR_API_KEY) {
      warn('LINEAR_API_KEY not set — skipping Linear lookup');
      return resolve(null);
    }
    const query = JSON.stringify({
      query: `{ issue(id: "${issueId}") { id title state { id name } } }`
    });
    const req = https.request(
      {
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: LINEAR_API_KEY,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const issue = parsed.data && parsed.data.issue;
            if (!issue) { warn(`Linear issue ${issueId} not found`); return resolve(null); }
            resolve({ id: issue.id, title: issue.title, stateName: issue.state.name, stateId: issue.state.id });
          } catch (e) {
            warn(`Failed to parse Linear response for ${issueId}: ${e.message}`);
            resolve(null);
          }
        });
      }
    );
    req.on('error', (e) => { warn(`Linear request error for ${issueId}: ${e.message}`); resolve(null); });
    req.write(query);
    req.end();
  });
}

/** Mark a Linear issue as Done. */
function markLinearDone(issueUuid) {
  return new Promise((resolve) => {
    if (!LINEAR_API_KEY) { warn('LINEAR_API_KEY not set — skipping Linear update'); return resolve(false); }
    if (DRY_RUN) { log(`[DRY-RUN] Would mark ${issueUuid} → Done`); return resolve(true); }
    const query = JSON.stringify({
      query: `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier state { name } } } }`,
      variables: { id: issueUuid, input: { stateId: DONE_STATE_ID } }
    });
    const req = https.request(
      {
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: LINEAR_API_KEY,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const ok = parsed.data && parsed.data.issueUpdate && parsed.data.issueUpdate.success;
            resolve(!!ok);
          } catch (e) {
            warn(`Failed to parse mark-done response: ${e.message}`);
            resolve(false);
          }
        });
      }
    );
    req.on('error', (e) => { warn(`Linear update error: ${e.message}`); resolve(false); });
    req.write(query);
    req.end();
  });
}

/** Post a comment on a Linear issue. */
function postLinearComment(issueUuid, body) {
  return new Promise((resolve) => {
    if (!LINEAR_API_KEY) { warn('LINEAR_API_KEY not set — skipping comment'); return resolve(false); }
    if (DRY_RUN) { log(`[DRY-RUN] Would post comment on ${issueUuid}: ${body}`); return resolve(true); }
    const query = JSON.stringify({
      query: `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`,
      variables: { id: issueUuid, body }
    });
    const req = https.request(
      {
        hostname: 'api.linear.app',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: LINEAR_API_KEY,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(!!(parsed.data && parsed.data.commentCreate && parsed.data.commentCreate.success));
          } catch (e) {
            warn(`Failed to parse comment response: ${e.message}`);
            resolve(false);
          }
        });
      }
    );
    req.on('error', (e) => { warn(`Linear comment error: ${e.message}`); resolve(false); });
    req.write(query);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n🔗 GitHub → Linear Sync (lookback: ${LOOKBACK_HOURS}h${DRY_RUN ? ', DRY-RUN' : ''})`);
  log(`   Watching: ${WATCHED_REPOS.join(', ')}\n`);

  const lookbackMs = LOOKBACK_HOURS * 60 * 60 * 1000;
  const dedup = loadDedup();

  const stats = { reposChecked: 0, prsFound: 0, prsDedupSkipped: 0, prsNoIssueId: 0, prsStateSkipped: 0, prsMarkedDone: 0, errors: 0 };

  for (const repo of WATCHED_REPOS) {
    stats.reposChecked++;
    log(`📦 ${repo}`);
    const prs = fetchMergedPRs(repo, lookbackMs);
    log(`   Found ${prs.length} merged PR(s) in last ${LOOKBACK_HOURS}h`);

    for (const pr of prs) {
      stats.prsFound++;
      const dedupKey = `${repo}:${pr.number}`;
      const prUrl = pr.html_url || `https://github.com/${repo}/pull/${pr.number}`;

      // ── Dedup check ──────────────────────────────────────────────────────
      if (dedup.has(dedupKey)) {
        log(`   ⏭  PR #${pr.number} already processed — skip`);
        stats.prsDedupSkipped++;
        continue;
      }

      // ── Extract issue ID ─────────────────────────────────────────────────
      const issueId = extractIssueIdFromPR(pr);
      if (!issueId) {
        log(`   ❓ PR #${pr.number} "${pr.title}" — no CRU-XXX found, skip`);
        stats.prsNoIssueId++;
        // Still dedup so we don't keep re-logging this
        dedup.add(dedupKey);
        appendDedup({ prNumber: pr.number, repo, issueId: null, action: 'no_match', prUrl, processedAt: new Date().toISOString() });
        continue;
      }

      log(`   🔍 PR #${pr.number} → ${issueId} (branch: ${pr.head && pr.head.ref})`);

      // ── Check Linear state ───────────────────────────────────────────────
      let linearIssue;
      try {
        linearIssue = await getLinearIssue(issueId);
      } catch (e) {
        warn(`Error fetching Linear issue ${issueId}: ${e.message}`);
        stats.errors++;
        continue;
      }

      if (!linearIssue) {
        log(`   ⚠️  ${issueId} not found in Linear — skip`);
        stats.errors++;
        dedup.add(dedupKey);
        appendDedup({ prNumber: pr.number, repo, issueId, action: 'not_found', prUrl, processedAt: new Date().toISOString() });
        continue;
      }

      if (SKIP_STATE_NAMES.includes(linearIssue.stateName)) {
        log(`   ✅ ${issueId} already "${linearIssue.stateName}" — skip`);
        stats.prsStateSkipped++;
        dedup.add(dedupKey);
        appendDedup({ prNumber: pr.number, repo, issueId, action: 'state_skipped', currentState: linearIssue.stateName, prUrl, processedAt: new Date().toISOString() });
        continue;
      }

      log(`   📝 ${issueId} is "${linearIssue.stateName}" → marking Done…`);

      // ── Mark Done ────────────────────────────────────────────────────────
      let marked = false;
      try {
        marked = await markLinearDone(linearIssue.id);
      } catch (e) {
        warn(`Error marking Done for ${issueId}: ${e.message}`);
        stats.errors++;
      }

      if (marked || DRY_RUN) {
        // ── Post comment ─────────────────────────────────────────────────
        const commentBody = `✅ PR #${pr.number} merged ([${repo}](${prUrl})) → auto-closed by github-linear-sync`;
        try {
          await postLinearComment(linearIssue.id, commentBody);
        } catch (e) {
          warn(`Error posting comment on ${issueId}: ${e.message}`);
        }

        log(`   ✅ ${issueId} → Done (PR #${pr.number})`);
        stats.prsMarkedDone++;
        dedup.add(dedupKey);
        appendDedup({ prNumber: pr.number, repo, issueId, action: 'marked_done', prUrl, processedAt: new Date().toISOString() });
      } else {
        warn(`Failed to mark ${issueId} Done`);
        stats.errors++;
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  log(`\n─────────────────────────────────────────`);
  log(`📊 Summary`);
  log(`   Repos checked:      ${stats.reposChecked}`);
  log(`   Merged PRs found:   ${stats.prsFound}`);
  log(`   Already processed:  ${stats.prsDedupSkipped}`);
  log(`   No issue ID:        ${stats.prsNoIssueId}`);
  log(`   State skip:         ${stats.prsStateSkipped}`);
  log(`   Marked Done:        ${stats.prsMarkedDone}`);
  log(`   Errors/warnings:    ${stats.errors}`);
  log(`─────────────────────────────────────────\n`);
}

main().catch((e) => {
  warn(`Unhandled error in main: ${e.message}`);
  // exit 0 always — never block heartbeat
  process.exit(0);
});
