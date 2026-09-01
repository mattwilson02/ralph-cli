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
  /**
   * Wall-clock backstop in minutes. NOT the sprint budget — it exists only
   * to kill a genuinely hung process. Effort is budgeted by `maxToolCalls`
   * because wall-clock time measures the API's mood, not the sprint's size:
   * across one 14-sprint run throughput varied 20x (0.17 to 3.53 tool calls
   * per minute) on flat workload, so a fixed minute budget bought a whole
   * sprint at one hour of the day and eight tool calls at another.
   */
  sprintTimeout: number;
  /** Effort budget: hard cap on agent tool calls per sprint. */
  maxToolCalls: number;
  /**
   * Stall detector: escalate after this many consecutive tool calls with no
   * progress signal. This is what catches a spinning agent — fast but not
   * advancing — which is the failure the wall clock used to catch by
   * accident, along with every slow-but-working sprint.
   */
  stallWindow: number;
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
  /** Agent tool calls consumed by this sprint — the effort meter */
  toolCalls?: number;
  /** Tool-call index at which a progress signal last fired */
  lastProgressAtCall?: number;
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
  /**
   * Failures counted per check name. The check NAME is too coarse to detect
   * progress — "Unit Tests" stays in `failedChecks` whether 40 tests fail or
   * 1 — so the fix loop compares these counts instead.
   */
  failureCounts: Record<string, number>;
}
