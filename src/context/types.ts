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

export interface GitInfo {
  baseBranch: string;
  remote: string;
  repoUrl?: string;
}
