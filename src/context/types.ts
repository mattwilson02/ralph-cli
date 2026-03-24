export interface ProjectContext {
  root: string;
  name: string;
  description: string;
  isMonorepo: boolean;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | "pip" | "none";
  workspaces: Workspace[];
  stack: StackInfo;
  git: GitInfo;
  productSpec: string;
  sprintsDir: string;
  docs: string[];
}

export interface Workspace {
  name: string;
  path: string;
  type: "backend" | "frontend" | "shared" | "unknown";
  framework?: string;
  checks: Check[];
  dependencies: string[];
}

export interface Check {
  name: string;
  cmd: string;
  cwd: string;
}

export interface StackInfo {
  languages: string[];
  frameworks: string[];
  database?: string;
  testRunner?: string;
  linter?: string;
  buildTool?: string;
}

export type GitProvider = "github" | "gitea" | "unknown";

export interface GitInfo {
  baseBranch: string;
  remote: string;
  repoUrl?: string;
  provider: GitProvider;
  /** Gitea API base URL (e.g., "https://git.citadelsigma.com/api/v1"). Only set when provider is "gitea". */
  giteaApiUrl?: string;
  /** Gitea repo owner/name (e.g., "matt/imperium-v2"). Only set when provider is "gitea". */
  giteaRepo?: string;
}
