import { relative, resolve } from "node:path";
import { log } from "../util/logger.js";

export type AgentRole =
  | "spec-writer"
  | "builder"
  | "fixer"
  | "auditor"
  | "reviewer";

export interface GuardrailPolicy {
  role: AgentRole;
  /** Repo root — used to normalize absolute paths in tool inputs */
  root: string;
  /** If set, Write/Edit are only allowed under these relative prefixes */
  writePaths?: string[];
  /** Extra relative prefixes the spec explicitly declared (builder/fixer) */
  declaredPaths?: string[];
  /** Called for every allow/deny decision — feeds the evidence audit log */
  onToolUse?: (entry: ToolUseEntry) => void;
}

export interface ToolUseEntry {
  role: AgentRole;
  tool: string;
  detail: string;
  denied: boolean;
  reason?: string;
  at: string;
}

/**
 * Bash invocations no Ralph agent may run: the pipeline owns git history
 * and publishing, agents own file edits. Instructions say this too — these
 * gates make it enforcement instead of guidance.
 */
const DENIED_BASH: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+(commit|push|merge|rebase|reset|tag)\b/, reason: "git history is managed by the Ralph pipeline, not agents" },
  { pattern: /\bgit\s+checkout\b|\bgit\s+switch\b/, reason: "branch management is owned by the Ralph pipeline" },
  { pattern: /\bgh\s/, reason: "PR/issue operations are owned by the Ralph pipeline" },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, reason: "publishing is never an agent action" },
  { pattern: /\bgit\s+config\b/, reason: "git identity/config changes are not allowed" },
];

/**
 * Paths no agent may write without the spec explicitly declaring them:
 * CI workflows are deploy-grade risk, env files hold secrets.
 */
const SENSITIVE_WRITE_PATHS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)\.github\/workflows\//, reason: "CI workflow changes are high-risk and must be declared in the spec" },
  { pattern: /(^|\/)\.env(\.|$)/, reason: "env/secret files must never be written by agents" },
  { pattern: /(^|\/)\.git\//, reason: "direct .git manipulation is not allowed" },
];

interface PreToolUseInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
}

interface HookDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}

/**
 * Build the PreToolUse hook enforcing a role's guardrail policy.
 * Returned in the shape the Claude Agent SDK expects for
 * `options.hooks.PreToolUse[].hooks[]`.
 */
export function createGuardrailHook(policy: GuardrailPolicy) {
  return async (input: unknown): Promise<HookDecision> => {
    const hookInput = input as PreToolUseInput;
    const tool = hookInput.tool_name || "unknown";
    const toolInput = (hookInput.tool_input || {}) as Record<string, unknown>;

    const verdict = evaluateToolUse(policy, tool, toolInput);

    policy.onToolUse?.({
      role: policy.role,
      tool,
      detail: describeToolUse(tool, toolInput),
      denied: verdict !== null,
      reason: verdict ?? undefined,
      at: new Date().toISOString(),
    });

    if (verdict) {
      log(`  Guardrail denied ${tool} (${policy.role}): ${verdict}`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `${verdict}. Do not retry this action — it is outside your role's boundary.`,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    };
  };
}

/**
 * Returns a denial reason, or null when the call is allowed.
 */
export function evaluateToolUse(
  policy: GuardrailPolicy,
  tool: string,
  toolInput: Record<string, unknown>,
): string | null {
  if (tool === "Bash") {
    const cmd = String(toolInput.command || "");
    for (const rule of DENIED_BASH) {
      if (rule.pattern.test(cmd)) return rule.reason;
    }
    return null;
  }

  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
    const rawPath = String(toolInput.file_path || toolInput.path || "");
    if (!rawPath) return null;
    const rel = toRelative(policy.root, rawPath);

    // Ralph's own working dir is always writable (handoff reports etc.)
    if (rel.startsWith(".ralph/")) return null;

    const declared = policy.declaredPaths || [];
    const explicitlyDeclared = declared.some(
      (d) => rel === d.replace(/\/$/, "") || rel.startsWith(d.replace(/\/$/, "") + "/"),
    );

    for (const rule of SENSITIVE_WRITE_PATHS) {
      if (rule.pattern.test(rel) && !explicitlyDeclared) return rule.reason;
    }

    if (policy.writePaths && policy.writePaths.length > 0) {
      const allowed =
        explicitlyDeclared ||
        policy.writePaths.some((p) => {
          const normalized = p.replace(/\/$/, "");
          return normalized === "." || rel === normalized || rel.startsWith(normalized + "/");
        });
      if (!allowed) {
        return `writes are restricted to: ${policy.writePaths.join(", ")}`;
      }
    }
  }

  return null;
}

function toRelative(root: string, path: string): string {
  if (path.startsWith("/")) {
    const rel = relative(resolve(root), resolve(path));
    return rel.startsWith("..") ? path : rel;
  }
  return path.replace(/^\.\//, "");
}

function describeToolUse(tool: string, toolInput: Record<string, unknown>): string {
  if (tool === "Bash") return String(toolInput.command || "").slice(0, 200);
  const path = toolInput.file_path || toolInput.path;
  if (path) return String(path);
  return JSON.stringify(toolInput).slice(0, 120);
}
