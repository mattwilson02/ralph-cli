import type { ProjectContext } from "../context/types.js";
import type { AutonomyMode } from "../types.js";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

/** Spec content that signals security- or data-sensitive work. */
const SENSITIVE_TOPICS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bmigrations?\b/i, label: "database migrations" },
  { pattern: /\bauth(entication|orization)?\b/i, label: "auth changes" },
  { pattern: /\bpasswords?\b/i, label: "password handling" },
  { pattern: /\bpayments?\b|\bbilling\b/i, label: "payments/billing" },
  { pattern: /\bsecrets?\b|\bcredentials?\b|\bapi[ -]?keys?\b/i, label: "secrets/credentials" },
];

/** Paths whose modification is infrastructure-level risk regardless of topic. */
const SENSITIVE_PATHS: { pattern: RegExp; label: string }[] = [
  { pattern: /\.github\/workflows\//, label: "CI workflows (.github/workflows/)" },
  { pattern: /\binfra\//, label: "infrastructure (infra/)" },
  { pattern: /\bterraform\b|\.tf\b/, label: "Terraform" },
  { pattern: /\bDockerfile\b|docker-compose/, label: "Docker/deploy config" },
  { pattern: /\.env\b/, label: ".env files" },
];

const FILE_COUNT_WARN = 12;

/**
 * Deterministic risk scoring for a sprint spec — no LLM judgment involved.
 *
 * Mirrors the risk-tier model from GitHub's agentic guidance: docs and
 * formatting are low risk, app code and dependencies are medium, and
 * infra / workflows / auth / unverifiable work are high. The result decides
 * whether Ralph may plan-and-execute or must pause for plan approval.
 */
export function assessRisk(
  ctx: ProjectContext,
  specContent: string,
  opts: { greenfield?: boolean } = {},
): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskLevel = "low";

  const raise = (to: RiskLevel, reason: string) => {
    reasons.push(reason);
    if (to === "high" || (to === "medium" && level === "low")) level = to;
  };

  if (opts.greenfield) {
    raise("high", "Greenfield project — architecture decisions have long-lived consequences");
  }

  for (const topic of SENSITIVE_TOPICS) {
    if (topic.pattern.test(specContent)) {
      raise("high", `Spec involves ${topic.label}`);
    }
  }

  for (const path of SENSITIVE_PATHS) {
    if (path.pattern.test(specContent)) {
      raise("high", `Spec touches ${path.label}`);
    }
  }

  const uncheckedWorkspaces = ctx.workspaces.filter((w) => w.checks.length === 0);
  if (ctx.workspaces.length > 0 && uncheckedWorkspaces.length === ctx.workspaces.length) {
    raise("high", "No verification checks exist — nothing can validate the work");
  } else if (uncheckedWorkspaces.length > 0) {
    raise(
      "medium",
      `Workspaces without checks: ${uncheckedWorkspaces.map((w) => w.path).join(", ")}`,
    );
  }

  const declared = parseDeclaredFiles(specContent);
  if (declared.length >= FILE_COUNT_WARN) {
    raise("medium", `Large changeset declared (${declared.length} files)`);
  }

  if (/\bdelete\b|\bremove\b.*\bfiles?\b/i.test(specContent)) {
    raise("medium", "Spec mentions deleting/removing files");
  }

  if (reasons.length === 0) {
    reasons.push("No sensitive topics, sensitive paths, or oversized changesets detected");
  }

  return { level, reasons };
}

/**
 * Parse the machine-readable `## Declared Files` section the spec writer
 * is instructed to emit: one backticked path per bullet line. Falls back
 * to scanning "Files to create/modify" style bullets anywhere in the spec.
 */
export function parseDeclaredFiles(specContent: string): string[] {
  const files = new Set<string>();

  let body = specContent;
  const headerIdx = specContent.search(/^##\s*Declared Files\s*$/m);
  if (headerIdx >= 0) {
    const sectionLines: string[] = [];
    for (const line of specContent.slice(headerIdx).split("\n").slice(1)) {
      if (/^##\s/.test(line)) break;
      sectionLines.push(line);
    }
    body = sectionLines.join("\n");
  }

  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1].trim();
    // Path-shaped: contains a slash or a file extension, no spaces
    if (!/\s/.test(candidate) && (/\//.test(candidate) || /\.\w+$/.test(candidate))) {
      files.add(candidate.replace(/^\.\//, ""));
    }
  }

  return [...files];
}

/**
 * Who decides the workflow mode.
 *
 * An explicit human choice is now the ONLY thing that opens the plan-first
 * gate. `assessRisk` still runs and is still recorded in the evidence
 * ledger, but it no longer drives autonomy, because as a keyword matcher
 * over spec prose it saturates: on the IoM CIS build every one of 14
 * sprints graded high — "payments" 14x, "auth changes" 14x,
 * "secrets/credentials" 13x — in an app whose whole domain is payments.
 * A grader that returns the same answer every time is a constant, not a
 * signal, and gating on a constant means gating on everything.
 *
 * Absolute risk saturates; relative risk would not. When this comes back it
 * should judge the DIFF against the rest of the codebase ("is this change
 * unusually risky for this project?") rather than pattern-matching the
 * spec's vocabulary.
 */
export function resolveAutonomy(
  explicit: AutonomyMode | undefined,
): AutonomyMode {
  return explicit ?? "auto";
}
