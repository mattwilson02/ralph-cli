import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../util/logger.js";

export interface AgentOptions {
  model: string;
  allowedTools: string[];
  cwd: string;
  permissionMode?: string;
  maxTurns?: number;
  systemPromptAppend?: string;
}

interface AgentResult {
  result: string;
  subtype: string;
  turns: number;
  cost: number;
  sessionId?: string;
}

/**
 * Run a Claude agent with automatic resumption on max_turns / context exhaustion.
 */
export async function runAgent(
  prompt: string,
  opts: AgentOptions,
  maxResumeAttempts: number = 3,
): Promise<string> {
  const queryOpts = {
    model: opts.model,
    allowedTools: opts.allowedTools,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode || "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: opts.maxTurns || 200,
    systemPrompt: opts.systemPromptAppend
      ? {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: "\n" + opts.systemPromptAppend,
        }
      : undefined,
  };

  let sessionId: string | undefined;
  let totalTurns = 0;
  let totalCost = 0;

  for (let attempt = 0; attempt <= maxResumeAttempts; attempt++) {
    const isResume = attempt > 0 && sessionId;
    const currentPrompt = isResume
      ? "You were interrupted because you ran out of turns. Continue exactly where you left off — do NOT restart or re-read files you already processed. Pick up the task and finish it."
      : prompt;

    const currentOpts = isResume
      ? { ...queryOpts, sessionId, maxTurns: queryOpts.maxTurns }
      : queryOpts;

    if (isResume) {
      log(
        `  Resuming agent (attempt ${attempt + 1}/${maxResumeAttempts}, session: ${sessionId})`,
      );
    }

    const agentResult = await runAgentOnce(currentPrompt, currentOpts);
    totalTurns += agentResult.turns;
    totalCost += agentResult.cost;

    if (!sessionId && agentResult.sessionId) {
      sessionId = agentResult.sessionId;
    }

    if (agentResult.subtype === "success") {
      log(
        `  Agent completed (${totalTurns} turns, $${totalCost.toFixed(4)})`,
      );
      return agentResult.result;
    }

    if (agentResult.subtype === "error_max_turns") {
      log(
        `  Agent hit max turns (${totalTurns} total, $${totalCost.toFixed(4)})`,
      );
      if (attempt === maxResumeAttempts) {
        log("  Agent exhausted all resume attempts — continuing with partial work");
        return agentResult.result;
      }
      continue;
    }

    // Any other error — don't retry
    log(
      `  Agent stopped with: ${agentResult.subtype} (${totalTurns} turns, $${totalCost.toFixed(4)})`,
    );
    return agentResult.result;
  }

  return "";
}

async function runAgentOnce(
  prompt: string,
  opts: Record<string, unknown>,
): Promise<AgentResult> {
  let sessionId: string | undefined;
  let result = "";
  let subtype = "success";
  let turns = 0;
  let cost = 0;

  for await (const message of query({
    prompt,
    options: opts,
  } as Parameters<typeof query>[0])) {
    const msg = message as Record<string, unknown>;

    if (
      msg.type === "system" &&
      msg.subtype === "init" &&
      typeof msg.session_id === "string"
    ) {
      sessionId = msg.session_id;
    }

    if (msg.type === "result") {
      result = typeof msg.result === "string" ? msg.result : "";
      subtype = typeof msg.subtype === "string" ? msg.subtype : "success";
      turns = typeof msg.num_turns === "number" ? msg.num_turns : 0;
      cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
    }
  }

  return { result, subtype, turns, cost, sessionId };
}
