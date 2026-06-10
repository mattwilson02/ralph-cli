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
}

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
  goal?: string;
  specName?: string;
  specPath?: string;
  branchName?: string;
  checks: CheckAttemptRecord[];
  fixAttempts: FixAttemptRecord[];
  audit?: { completed: string[]; missing: string[]; issues: string[] };
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
  specWriter: "claude-opus-4-6",
  builder: "claude-sonnet-4-6",
  fixAgent: "claude-sonnet-4-6",
  auditor: "claude-opus-4-6",
};

export interface VerifyResult {
  passed: boolean;
  output: string;
  failedChecks: string[];
}
