import type { ProjectContext } from "../context/types.js";
import { parseDeclaredFiles } from "../core/risk.js";
import { runSafe } from "../util/exec.js";
import { log } from "../util/logger.js";

export interface ScopeCheckResult {
  declared: string[];
  changed: string[];
  outOfScope: string[];
}

/**
 * Files Ralph or the toolchain may always touch without the spec
 * declaring them: dependency manifests/lockfiles change as a side effect
 * of installs, and Ralph manages its own working files.
 */
const ALWAYS_IN_SCOPE = [
  ".gitignore",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "requirements.txt",
];

const ALWAYS_IN_SCOPE_PREFIXES = [".ralph/", "docs/sprints/"];

/**
 * Scope containment check (post-build): compare what actually changed in
 * the working tree against what the spec declared. An agent that
 * implements the spec correctly but also modifies unrelated files is a
 * scope violation — and a green test run does not excuse it.
 */
export function checkScope(
  ctx: ProjectContext,
  specContent: string,
): ScopeCheckResult {
  const declared = parseDeclaredFiles(specContent);
  const changed = changedFiles(ctx.root);

  const outOfScope = changed.filter(
    (file) => !isInScope(file, declared),
  );

  if (outOfScope.length > 0) {
    log(`Scope check: ${outOfScope.length} file(s) changed outside declared scope:`);
    for (const f of outOfScope) log(`  - ${f}`);
  } else {
    log(`Scope check: all ${changed.length} changed file(s) within declared scope`);
  }

  return { declared, changed, outOfScope };
}

function isInScope(file: string, declared: string[]): boolean {
  if (ALWAYS_IN_SCOPE.includes(file)) return true;
  // Manifests inside workspaces (e.g. apps/api/package.json)
  const basename = file.split("/").pop() || file;
  if (ALWAYS_IN_SCOPE.includes(basename)) return true;
  if (ALWAYS_IN_SCOPE_PREFIXES.some((p) => file.startsWith(p))) return true;

  // A declared path matches exactly, or as a directory prefix (specs may
  // declare a directory for a set of new files)
  return declared.some((d) => {
    const normalized = d.replace(/\/$/, "");
    return file === normalized || file.startsWith(normalized + "/");
  });
}

/**
 * All working-tree changes (staged, unstaged, and untracked) relative to
 * HEAD — builders write files but never commit, so the diff lives in the
 * working tree until the ship phase.
 */
function changedFiles(root: string): string[] {
  // -uall lists files inside untracked directories individually
  const { ok, output } = runSafe("git status --porcelain -uall", root);
  if (!ok) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // Format: XY <path> (or XY <old> -> <new> for renames). Parse by
      // pattern, not column position — surrounding whitespace may have
      // been trimmed by the exec helper.
      const match = line.match(/^\s*[MADRCUT?!]{1,2}\s+(.*)$/);
      if (!match) return "";
      const path = match[1];
      const renameArrow = path.indexOf(" -> ");
      return renameArrow >= 0 ? path.slice(renameArrow + 4) : path;
    })
    .filter(Boolean)
    .map((p) => p.replace(/^"|"$/g, ""));
}
