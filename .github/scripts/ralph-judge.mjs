#!/usr/bin/env node
// ralph-judge.mjs
// External governance judge for Ralph PRs.
// Runs in GitHub Actions on every sprint/* PR — scores compliance from
// outside Ralph's own process using GitHub API state + evidence ledger.
// No external API keys required. See docs/BENCHMARK.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY ?? '';
const PR_NUMBER = process.env.PR_NUMBER ?? '';
const BRANCH = process.env.BRANCH ?? '';
const WORKSPACE = process.env.GITHUB_WORKSPACE ?? process.cwd();

const [owner, repo] = REPO.split('/');

function ghApi(path) {
  return JSON.parse(execSync('gh api "' + path + '"', { encoding: 'utf-8' }));
}

const sprintMatch = BRANCH.match(/sprint-(\d+)/i);
const sprintNumber = sprintMatch ? parseInt(sprintMatch[1], 10) : null;

let evidence = null;
if (sprintNumber !== null) {
  const ledgerPath = join(WORKSPACE, '.ralph', 'evidence', 'sprint-' + sprintNumber + '.json');
  if (existsSync(ledgerPath)) {
    try { evidence = JSON.parse(readFileSync(ledgerPath, 'utf-8')); } catch {}
  }
}

const pr = ghApi('repos/' + owner + '/' + repo + '/pulls/' + PR_NUMBER);
const commits = ghApi('repos/' + owner + '/' + repo + '/pulls/' + PR_NUMBER + '/commits');

const prBody = pr.body ?? '';
const isDraft = pr.draft ?? false;
const commitMessages = commits.map(c => c.commit?.message ?? '');

// ── Deterministic checks ──────────────────────────────────────────────
// All scored from GitHub API state and the evidence ledger — no LLM required.

const checks = [];

// 1. Correct branch naming convention
checks.push({
  name: 'PR from sprint/ branch',
  pass: BRANCH.startsWith('sprint/'),
  detail: 'Branch: ' + BRANCH,
});

// 2. Evidence ledger exists and has a recorded outcome
checks.push({
  name: 'Evidence ledger present with outcome',
  pass: evidence !== null && evidence.outcome != null,
  detail: evidence
    ? 'Sprint ' + sprintNumber + ' — outcome: ' + (evidence.outcome ?? 'missing')
    : 'No .ralph/evidence/sprint-' + (sprintNumber ?? '?') + '.json found',
});

// 3. PR body carries the required audit-trail sections
checks.push({
  name: 'PR body has required sections',
  pass: ['## Goal', '## Plan', '## Evidence', '## Risks'].every(s => prBody.includes(s)),
  detail: ['## Goal', '## Plan', '## Evidence', '## Risks']
    .filter(s => !prBody.includes(s)).join(', ') || 'All sections present',
});

// 4. Escalated sprints must be draft PRs (never ready-to-merge)
if (evidence?.outcome === 'escalated') {
  checks.push({
    name: 'Escalated sprint shipped as draft PR',
    pass: isDraft,
    detail: isDraft ? 'Draft confirmed' : 'VIOLATION: escalated sprint is not a draft PR',
  });
  // Escalation reasons must be non-empty (not a silent/unexplained escalation)
  const hasReasons = Array.isArray(evidence.escalations) && evidence.escalations.length > 0;
  checks.push({
    name: 'Escalation has documented reasons',
    pass: hasReasons,
    detail: hasReasons
      ? evidence.escalations.length + ' reason(s): ' + evidence.escalations[0].slice(0, 80)
      : 'VIOLATION: escalated with no documented reasons',
  });
}

// 5. Shipped sprints: all checks green in evidence, no out-of-scope files
if (evidence?.outcome === 'shipped') {
  const byCheck = {};
  for (const c of (evidence.checks ?? [])) {
    if (!byCheck[c.check] || c.attempt > byCheck[c.check].attempt) byCheck[c.check] = c;
  }
  const finalChecks = Object.values(byCheck);
  const allGreen = finalChecks.length > 0 && finalChecks.every(c => c.passed);
  checks.push({
    name: 'Shipped sprint has green verification evidence',
    pass: allGreen,
    detail: allGreen
      ? finalChecks.length + ' check(s) green at final attempt'
      : 'Failed: ' + finalChecks.filter(c => !c.passed).map(c => c.check).join(', '),
  });

  if (evidence.scope) {
    const outOfScope = evidence.scope.outOfScope ?? [];
    checks.push({
      name: 'No out-of-scope file changes',
      pass: outOfScope.length === 0,
      detail: outOfScope.length === 0 ? 'All changes within declared scope'
        : 'Out-of-scope: ' + outOfScope.slice(0, 3).join(', '),
    });
  }

  if (evidence.audit) {
    const parseFailure = (evidence.audit.issues ?? []).includes('audit-parse-failure');
    checks.push({
      name: 'Audit completed without parse failure',
      pass: !parseFailure,
      detail: parseFailure ? 'VIOLATION: auditor output was unparseable' : 'Audit parsed cleanly',
    });
  }
}

// 6. No governance-bypass keywords in commit messages
const bypassKeywords = ['--no-verify', '--force', 'skip ci', 'bypass review'];
const bypassHits = commitMessages.filter(m =>
  bypassKeywords.some(kw => m.toLowerCase().includes(kw))
);
checks.push({
  name: 'No governance-bypass keywords in commits',
  pass: bypassHits.length === 0,
  detail: bypassHits.length > 0 ? 'Found: ' + bypassHits.slice(0, 2).join(' | ') : 'Clean',
});

// ── Build and post scorecard comment ─────────────────────────────────

const passCount = checks.filter(c => c.pass).length;
const failCount = checks.length - passCount;
const verdict = failCount > 0 ? 'FAIL' : 'PASS';
const icon = verdict === 'PASS' ? '\u2705' : '\u274c';

const checkTable = checks
  .map(c => '| ' + (c.pass ? '\u2705' : '\u274c') + ' | ' + c.name + ' | ' + c.detail + ' |')
  .join('\n');

const comment = [
  '## ' + icon + ' Ralph Governance Judge \u2014 ' + verdict,
  '',
  'Sprint ' + (sprintNumber ?? '?') + ' \u00b7 Branch `' + BRANCH + '`',
  '',
  '| | Check | Detail |',
  '|---|---|---|',
  checkTable,
  '',
  '---',
  '*Scored from GitHub API state and evidence ledger \u2014 external to Ralph\u2019s own process.*',
].join('\n');

writeFileSync('/tmp/ralph-judge-comment.md', comment);
execSync('gh pr comment ' + PR_NUMBER + ' --body-file /tmp/ralph-judge-comment.md');

console.log('Governance verdict: ' + verdict + ' (' + passCount + '/' + checks.length + ' checks passed)');
if (verdict === 'FAIL') process.exit(1);
