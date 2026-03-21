import { run, runSafe } from "./exec.js";
import { log } from "./logger.js";

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

export function createBranch(root: string, name: string): void {
  run(`git checkout -b ${name}`, root);
}

export function renameBranch(root: string, newName: string): void {
  const { ok, output } = runSafe("git branch --show-current", root);
  if (ok && output !== newName) {
    run(`git branch -m ${output} ${newName}`, root);
  }
}

export function commitAll(root: string, message: string): void {
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
): string {
  const escapedBody = body.replace(/"/g, '\\"').replace(/`/g, "\\`");
  const output = run(
    `gh pr create --title "${title}" --body "${escapedBody}" --base ${baseBranch}`,
    root,
  );
  const prUrl = output.split("\n").pop() || output;
  log(`  PR created: ${prUrl}`);
  return prUrl;
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
