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

const AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no messages = hung
const AGENT_INIT_TIMEOUT_MS = 30 * 1000; // 30 seconds to get first message
const AGENT_CONNECT_RETRIES = 2;

async function runAgentOnce(
  prompt: string,
  opts: Record<string, unknown>,
): Promise<AgentResult> {
  // Retry connection failures (0 turns = never started)
  for (let connAttempt = 0; connAttempt <= AGENT_CONNECT_RETRIES; connAttempt++) {
    if (connAttempt > 0) {
      log(`  Retrying agent connection (attempt ${connAttempt + 1}/${AGENT_CONNECT_RETRIES + 1})...`);
    }

    const result = await runAgentStream(prompt, opts);

    // If we got 0 turns and timed out, the connection failed — retry
    if (result.subtype === "error_timeout" && result.turns === 0 && connAttempt < AGENT_CONNECT_RETRIES) {
      log("  Agent failed to connect (0 turns) — retrying...");
      continue;
    }

    return result;
  }

  return { result: "", subtype: "error_timeout", turns: 0, cost: 0 };
}

async function runAgentStream(
  prompt: string,
  opts: Record<string, unknown>,
): Promise<AgentResult> {
  try {
    return await runAgentStreamInner(prompt, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  Agent crashed: ${msg}`);
    return { result: "", subtype: "error_crash", turns: 0, cost: 0 };
  }
}

async function runAgentStreamInner(
  prompt: string,
  opts: Record<string, unknown>,
): Promise<AgentResult> {
  // The Agent SDK calls process.exit() after the agent completes,
  // which kills the entire Ralph process between phases.
  // Intercept exit calls during agent execution and restore after.
  const originalExit = process.exit;
  let exitIntercepted = false;
  process.exit = ((code?: number) => {
    exitIntercepted = true;
    log(`  Intercepted process.exit(${code}) from Agent SDK — continuing`);
  }) as never;

  let sessionId: string | undefined;
  let result = "";
  let subtype = "success";
  let turns = 0;
  let cost = 0;
  let gotFirstMessage = false;

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let resetTimer: () => void = () => {};

  const idlePromise = new Promise<"timeout">((resolve) => {
    resetTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      // Use shorter timeout if we haven't received any messages yet
      const timeout = gotFirstMessage ? AGENT_IDLE_TIMEOUT_MS : AGENT_INIT_TIMEOUT_MS;
      idleTimer = setTimeout(() => resolve("timeout"), timeout);
    };
    resetTimer();
  });

  const streamPromise = (async () => {
    for await (const message of query({
      prompt,
      options: opts,
    } as Parameters<typeof query>[0])) {
      gotFirstMessage = true;
      resetTimer();
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
    return "done" as const;
  })();

  try {
    const winner = await Promise.race([streamPromise, idlePromise]);

    if (idleTimer) clearTimeout(idleTimer);

    if (winner === "timeout") {
      if (!gotFirstMessage) {
        log("  Agent failed to connect (no response in 30s)");
      } else {
        log("  Agent idle for 5 minutes — treating as hung, moving on");
      }
      subtype = "error_timeout";
    }

    return { result, subtype, turns, cost, sessionId };
  } finally {
    process.exit = originalExit;
  }
}
