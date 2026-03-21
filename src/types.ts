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
  models: ModelConfig;
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
