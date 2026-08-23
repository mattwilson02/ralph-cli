export type SprintPhase =
  | "spec"
  | "build"
  | "build_verify"
  | "full_verify"
  | "audit"
  | "pr";

export interface SprintState {
  sprint: number;
  phase: SprintPhase;
  specName?: string;
  specPath?: string;
  branchName?: string;
  /** Sprint is paused waiting for human approval at a gate */
  awaitingApproval?: boolean;
  /** Which gate paused the sprint (for messaging) */
  gate?: "plan" | "ambiguity";
  /** Human approved the pending gate via `ralph approve` */
  approved?: boolean;
}

/**
 * Workflow mode: "plan-first" pauses after the spec is written for human
 * approval before any code is built; "auto" plans and executes in one run.
 */
export type AutonomyMode = "auto" | "plan-first";

export interface EngineOptions {
  startSprint: number;
  maxSprints: number;
  singleMode: boolean;
  improve: boolean;
  specPath?: string;
  task?: string;
  greenfield: boolean;
  maxFixAttempts: number;
  maxResumeAttempts: number;
  sprintTimeout: number;
  models: ModelConfig;
  onVerifyFailure: VerifyFailurePolicy;
  /** Explicit human choice of workflow mode — overrides Ralph's risk judgment */
  autonomy?: AutonomyMode;
  /** Resume past a gate that was approved via `ralph approve` / `--approve` */
  approve?: boolean;
  /** Codeowner goal inherited at intake — the first link of the audit trail */
  goal?: string;
}

/**
 * What to do when verification still fails after all fix attempts.
 * - "draft-pr": open a draft PR led by the failure evidence (default)
 * - "block": commit locally, skip the PR, exit non-zero
 * - "ship": open a normal PR anyway (legacy behavior)
 */
export type VerifyFailurePolicy = "draft-pr" | "block" | "ship";

export type SprintOutcome = "shipped" | "escalated" | "blocked";

export interface CheckAttemptRecord {
  check: string;
  cmd: string;
  passed: boolean;
  /** Which verify attempt this belongs to (0 = initial run) */
  attempt: number;
  /** Commit the working tree was based on when the check ran */
  commit: string;
  /** Truncated failure output (only kept for failures) */
  output?: string;
}

export interface FixAttemptRecord {
  attempt: number;
  failedChecks: string[];
  /** Truncated fix-agent summary of what it tried */
  summary: string;
}

export interface EvidenceRecord {
  sprint: number;
  /**
   * Which attempt at this sprint this record covers. 1 unless the sprint
   * has been re-run; earlier passes are archived beside it.
   */
  pass?: number;
  goal?: string;
  specName?: string;
  specPath?: string;
  branchName?: string;
  checks: CheckAttemptRecord[];
  fixAttempts: FixAttemptRecord[];
  audit?: { completed: string[]; missing: string[]; issues: string[] };
  /** Deterministic risk assessment of the sprint spec */
  risk?: { level: string; reasons: string[] };
  /** Post-build scope containment result */
  scope?: { declared: string[]; changed: string[]; outOfScope: string[] };
  /** Reasons this sprint cannot ship as a normal PR */
  escalations: string[];
  outcome?: SprintOutcome;
  startedAt: string;
  finishedAt?: string;
}

export interface ModelConfig {
  specWriter: string;
  builder: string;
  fixAgent: string;
  auditor: string;
}

export const DEFAULT_MODELS: ModelConfig = {
  specWriter: "claude-opus-5",
  builder: "claude-opus-5",
  fixAgent: "claude-sonnet-5",
  auditor: "claude-opus-5",
};

export interface VerifyResult {
  passed: boolean;
  output: string;
  failedChecks: string[];
}
