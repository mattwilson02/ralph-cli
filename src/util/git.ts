import { readFileSync, writeFileSync } from "node:fs";
import { run, runSafe } from "./exec.js";
import { log } from "./logger.js";
import type { GitProvider } from "../context/types.js";

export function isBranchMergedInto(root: string, branch: string, target: string): boolean {
  const { ok, output } = runSafe(`git merge-base --is-ancestor ${branch} ${target}`, root);
  return ok;
}

export function detectBaseBranch(root: string): string {
  const candidates = ["dev", "develop", "main", "master"];
  const { ok, output } = runSafe("git branch -r", root);
  if (!ok) return "main";

  const remoteBranches = output
    .split("\n")
    .map((b) => b.trim().replace("origin/", ""));

  for (const candidate of candidates) {
    if (remoteBranches.includes(candidate)) return candidate;
  }
  return "main";
}

export function detectRemoteUrl(root: string): string | undefined {
  const { ok, output } = runSafe("git remote get-url origin", root);
  return ok ? output : undefined;
}

export function detectGitProvider(remoteUrl?: string): GitProvider {
  if (!remoteUrl) return "unknown";
  if (remoteUrl.includes("github.com")) return "github";
  // Gitea instances: check for known patterns or fall back to probing
  // Common self-hosted Gitea: git.*, gitea.*, or any non-github remote with /api/v1
  if (remoteUrl.includes("github.com")) return "github";
  // If not GitHub, assume Gitea for any SSH or HTTPS git remote
  // This works because the only other provider Ralph supports is Gitea
  return "gitea";
}

export function parseGiteaRemote(remoteUrl: string): { apiUrl: string; repo: string } | undefined {
  // HTTPS: https://git.citadelsigma.com/matt/imperium-v2.git
  const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      apiUrl: `https://${httpsMatch[1]}/api/v1`,
      repo: httpsMatch[2],
    };
  }
  // SSH: git@git.citadelsigma.com:matt/imperium-v2.git
  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      apiUrl: `https://${sshMatch[1]}/api/v1`,
      repo: sshMatch[2],
    };
  }
  return undefined;
}

export function createBranch(root: string, name: string): void {
  const branches = listBranches(root);
  if (branches.includes(name)) {
    log(`  Branch ${name} already exists — deleting and recreating`);
    run(`git branch -D ${name}`, root);
  }
  run(`git checkout -b ${name}`, root);
}

export function renameBranch(root: string, newName: string): void {
  const { ok, output } = runSafe("git branch --show-current", root);
  if (ok && output !== newName) {
    run(`git branch -m ${output} ${newName}`, root);
  }
}

/**
 * Ralph's own files, and how git must treat them.
 *
 * `ralph.log` and `.ralph-state.json` are transient run state and never belong
 * in a repository. `.ralph/` is different: it holds the transient session data
 * AND `.ralph/evidence/sprint-N.json`, the audit trail. The governance judge
 * runs in CI against a fresh `actions/checkout`, so evidence that was never
 * committed does not exist as far as the judge is concerned — six of its nine
 * checks read that file, and all six fail on a repository that ignores it.
 *
 * So the directory's CONTENTS are excluded and `evidence/` is re-included.
 * The distinction matters: a bare `.ralph/` exclusion cannot be undone by a
 * later negation, because git never descends into an excluded directory to
 * discover what was re-included inside it.
 */
const RALPH_IGNORES = [
  "ralph.log",
  ".ralph-state.json",
  ".ralph/*",
  "!.ralph/evidence/",
];

/** A bare `.ralph/` (or `.ralph`) rule — the form that hides the audit trail. */
function isBlanketRalphRule(line: string): boolean {
  const t = line.trim();
  return t === ".ralph/" || t === ".ralph";
}

/**
 * Bring a .gitignore's Ralph rules up to date, in place.
 *
 * Returns the new content, or null when nothing needed changing — so callers
 * can stay quiet on the common path instead of logging every sprint.
 */
export function applyRalphIgnores(content: string): string | null {
  const lines = content.split("\n");
  let changed = false;

  // Migrate repositories written by an earlier Ralph, which excluded the whole
  // directory and so shipped a judge that could not read its own evidence.
  const blanket = lines.findIndex(isBlanketRalphRule);
  if (blanket !== -1) {
    lines.splice(blanket, 1, ".ralph/*", "!.ralph/evidence/");
    changed = true;
  }

  // Exact-line matching, not substring: `.ralph/*` contains `.ralph/`, so a
  // substring test would report the blanket rule as already present and skip
  // the migration above.
  const present = new Set(lines.map((l) => l.trim()));
  const missing = RALPH_IGNORES.filter((rule) => !present.has(rule));
  if (missing.length > 0) {
    const body = lines.join("\n").trimEnd();
    return `${body}\n\n# Ralph working files\n${missing.join("\n")}\n`;
  }

  return changed ? lines.join("\n") : null;
}

export function ensureGitignore(root: string): void {
  const gitignorePath = `${root}/.gitignore`;
  const { ok } = runSafe(`test -f ${gitignorePath}`, root);

  if (!ok) {
    const defaults = [
      "node_modules/",
      "dist/",
      "build/",
      ".env",
      ".env.*",
      "*.log",
      ".DS_Store",
      "__pycache__/",
      "*.pyc",
      ".venv/",
      "venv/",
      "coverage/",
      ".nyc_output/",
      ...RALPH_IGNORES,
    ];
    writeFileSync(gitignorePath, defaults.join("\n") + "\n");
    log("  Created .gitignore with sensible defaults");
    return;
  }

  const updated = applyRalphIgnores(readFileSync(gitignorePath, "utf-8"));
  if (updated !== null) {
    writeFileSync(gitignorePath, updated);
    log("  Updated Ralph's rules in .gitignore (evidence ledger is committed)");
  }
}

export function commitAll(root: string, message: string): void {
  ensureGitignore(root);
  run("git add -A", root);
  const { ok } = runSafe("git diff --cached --quiet", root);
  if (ok) {
    log("  No changes to commit");
    return;
  }
  run(`git commit -m "${message.replace(/"/g, '\\"')}"`, root);
}

export function push(root: string, branch: string): void {
  run(`git push -u origin ${branch}`, root);
}

export function createPR(
  root: string,
  title: string,
  body: string,
  baseBranch: string,
  provider: GitProvider = "github",
  giteaApiUrl?: string,
  giteaRepo?: string,
  draft: boolean = false,
): string {
  if (provider === "gitea" && giteaApiUrl && giteaRepo) {
    return createGiteaPR(root, title, body, baseBranch, giteaApiUrl, giteaRepo, draft);
  }
  return createGithubPR(root, title, body, baseBranch, draft);
}

function createGithubPR(
  root: string,
  title: string,
  body: string,
  baseBranch: string,
  draft: boolean,
): string {
  const escapedBody = body.replace(/"/g, '\\"').replace(/`/g, "\\`");
  const output = run(
    `gh pr create --title "${title}" --body "${escapedBody}" --base ${baseBranch}${draft ? " --draft" : ""}`,
    root,
  );
  const prUrl = output.split("\n").pop() || output;
  log(`  PR created (GitHub${draft ? ", draft" : ""}): ${prUrl}`);
  return prUrl;
}

function createGiteaPR(
  root: string,
  title: string,
  body: string,
  baseBranch: string,
  apiUrl: string,
  repo: string,
  draft: boolean = false,
): string {
  // Get current branch name as the head branch
  const { ok, output: headBranch } = runSafe("git branch --show-current", root);
  if (!ok) throw new Error("Could not determine current branch");

  // Gitea API token from GITEA_TOKEN env var
  const token = process.env.GITEA_TOKEN;
  if (!token) {
    throw new Error("GITEA_TOKEN environment variable is required for Gitea PR creation");
  }

  // Gitea has no draft flag in the create-PR API — the WIP: title prefix
  // is the Gitea convention for marking a PR as work-in-progress.
  const payload = JSON.stringify({
    title: draft ? `WIP: ${title}` : title,
    body,
    base: baseBranch,
    head: headBranch,
  });

  const escapedPayload = payload.replace(/'/g, "'\\''");
  const output = run(
    `curl -s -X POST "${apiUrl}/repos/${repo}/pulls" -H "Authorization: token ${token}" -H "Content-Type: application/json" -d '${escapedPayload}'`,
    root,
  );

  // Parse response to extract PR URL
  try {
    const response = JSON.parse(output);
    if (response.html_url) {
      log(`  PR created (Gitea): ${response.html_url}`);
      return response.html_url;
    }
    if (response.message) {
      throw new Error(`Gitea API error: ${response.message}`);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Gitea API returned invalid JSON: ${output.substring(0, 200)}`);
    }
    throw err;
  }

  return "";
}

export function checkoutBranch(root: string, branch: string): void {
  run(`git checkout ${branch}`, root);
}

export function listBranches(root: string): string[] {
  const { ok, output } = runSafe("git branch", root);
  if (!ok) return [];
  return output
    .split("\n")
    .map((b) => b.replace(/^\*?\s*/, "").trim())
    .filter(Boolean);
}

export function pullLatest(root: string, branch: string): void {
  const { ok } = runSafe(`git pull origin ${branch}`, root);
  if (!ok) {
    log("  No remote to pull from — continuing with local state");
  }
}
