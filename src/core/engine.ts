import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProjectContext } from "../context/types.js";
import type { EngineOptions, SprintOutcome } from "../types.js";
import { loadState, saveState, clearState } from "./state.js";
import { EvidenceLedger } from "./evidence.js";
import { assessRisk, resolveAutonomy } from "./risk.js";
import { writeSpec } from "../phases/spec-writer.js";
import { runBuilders } from "../phases/builder.js";
import { verifyAndFix } from "../phases/verifier.js";
import { auditSpec, AUDIT_PARSE_FAILURE } from "../phases/auditor.js";
import { checkAmbiguity } from "../phases/ambiguity.js";
import { checkScope } from "../phases/scope-check.js";
import { ship } from "../phases/shipper.js";
import { confirm, isInteractive } from "../util/prompt.js";
import {
  createBranch,
  renameBranch,
  checkoutBranch,
  pullLatest,
  listBranches,
  isBranchMergedInto,
  ensureGitignore,
} from "../util/git.js";
import { cleanupStaleSessions } from "./agent.js";
import { log, initLogger } from "../util/logger.js";

export async function runEngine(
  ctx: ProjectContext,
  opts: EngineOptions,
): Promise<void> {
  initLogger(ctx.root);
  cleanupStaleSessions(ctx.root);
  log("═".repeat(60));
  log(`  Ralph — ${ctx.name}`);
  log(`  Base branch: ${ctx.git.baseBranch}`);
  log(`  Starting at sprint: ${opts.startSprint}`);
  log(`  Max sprints: ${opts.maxSprints}`);
  if (opts.task) log(`  Task: ${opts.task}`);
  if (opts.greenfield) log(`  Mode: greenfield`);
  if (opts.improve) log(`  Mode: improve`);
  log(`  Sprint timeout: ${opts.sprintTimeout} min`);
  log("═".repeat(60));

  const endSprint = opts.startSprint + opts.maxSprints;

  // Find the previous sprint's branch for chaining (if starting at sprint > 1)
  let previousBranch: string | null = null;
  if (opts.startSprint > 1) {
    previousBranch = findPreviousSprintBranch(ctx.root, opts.startSprint, ctx.git.baseBranch);
    if (previousBranch) {
      log(`  Chaining from previous sprint branch: ${previousBranch}`);
    }
  }

  for (let sprint = opts.startSprint; sprint < endSprint; sprint++) {
    const startTime = Date.now();

    log("");
    log("═".repeat(60));
    log(`  SPRINT ${sprint}`);
    log("═".repeat(60));

    // Check for saved state (resume from crash)
    let state = loadState(ctx.root);
    let specName = state?.specName;
    let specPath = state?.specPath;
    let branchName = state?.branchName;

    const resuming = state !== null && state.sprint === sprint;
    const startPhase = resuming ? state!.phase : "spec";

    // Sprint is parked at a human gate — `ralph approve` (or --approve)
    // is the only way past it.
    if (resuming && state!.awaitingApproval && !opts.approve) {
      log(`Sprint ${sprint} is paused at the ${state!.gate || "approval"} gate.`);
      log(`  Spec: ${state!.specPath}`);
      log("  Review it, then run `ralph approve` and re-run `ralph run` to continue.");
      return;
    }
    if (resuming && state!.awaitingApproval && opts.approve) {
      state = { ...state!, awaitingApproval: false, approved: true };
      saveState(ctx.root, state);
    }

    // Determine parent branch for chaining
    const parentBranch = previousBranch || ctx.git.baseBranch;

    if (!resuming) {
      // Chain sprints: branch from previous sprint if available, otherwise from base
      checkoutBranch(ctx.root, parentBranch);
      if (!previousBranch) {
        // Only pull from remote when starting from base branch
        pullLatest(ctx.root, ctx.git.baseBranch);
      }
      createBranch(ctx.root, `sprint/${sprint}`);
      log(`  Branched from: ${parentBranch}`);
      ensureGitignore(ctx.root);
    }

    const timeoutMs = opts.sprintTimeout * 60 * 1000;
    const isTimedOut = () => Date.now() - startTime > timeoutMs;

    // Audit trail for this sprint — persisted to .ralph/evidence/ so it
    // survives crash recovery alongside the phase state.
    const ledger = new EvidenceLedger(ctx.root, sprint);
    ledger.setGoal(deriveGoal(ctx, opts));

    try {
      // ── Phase: Spec ──
      if (shouldRun(startPhase, "spec")) {
        const spec = await writeSpec(ctx, sprint, opts.models.specWriter, {
          task: opts.task,
          greenfield: opts.greenfield,
          improve: opts.improve,
          goal: opts.goal,
        });
        specName = spec.name;
        specPath = spec.path;
        branchName = `sprint/${specName}`;
        renameBranch(ctx.root, branchName);

        saveState(ctx.root, {
          sprint,
          phase: "build",
          specName,
          specPath,
          branchName,
        });
      }

      if (!specPath || !specName || !branchName) {
        throw new Error("No spec available — cannot continue");
      }

      ledger.setSpec(specName, specPath);
      ledger.setBranch(branchName);

      // ── Phase: Build ──
      if (shouldRun(startPhase, "build")) {
        const gatesApproved = state?.approved === true || opts.approve === true;
        const specContent = readFileSync(specPath, "utf-8");

        const risk = assessRisk(ctx, specContent, { greenfield: opts.greenfield });
        ledger.recordRisk(risk);
        log(`Risk assessment: ${risk.level.toUpperCase()}`);
        for (const reason of risk.reasons) log(`  - ${reason}`);

        if (!gatesApproved) {
          // Plan-first gate: explicit human choice overrides Ralph's
          // risk-based judgment; high risk means the plan is approved
          // before any code is generated.
          const mode = resolveAutonomy(opts.autonomy, risk);
          if (mode === "plan-first") {
            log(`Workflow: plan-first (${opts.autonomy ? "set by --autonomy" : "Ralph's judgment from risk level"})`);
            const approved = await gateForHuman(ctx.root, "plan", {
              sprint,
              specName,
              specPath,
              branchName,
              question: `Plan-first gate — review the sprint spec (${relative(ctx.root, specPath)}). Proceed with build?`,
            });
            if (!approved) return;
          }

          // Ambiguity gate: catch spec errors before they masquerade as
          // implementation errors 200 turns later.
          const ambiguity = await checkAmbiguity(ctx, specPath, opts.models.auditor);
          if (!ambiguity.actionable) {
            const questionsPath = writeQuestionsFile(ctx.root, sprint, specPath, ambiguity.ambiguities);
            log("The spec needs human input before building:");
            for (const q of ambiguity.ambiguities) log(`  ? ${q}`);
            log(`  Questions written to ${relative(ctx.root, questionsPath)}`);
            const approved = await gateForHuman(ctx.root, "ambiguity", {
              sprint,
              specName,
              specPath,
              branchName,
              question: "Ambiguity gate — proceed with build anyway (or answer by editing the spec first)?",
            });
            if (!approved) return;
          }
        }

        log(`Entering build phase (specPath: ${specPath})`);
        await runBuilders(ctx, specPath, opts.models.builder, ledger);

        // Scope containment: tests passing does not excuse out-of-scope
        // changes — containment violations escalate regardless.
        const scope = checkScope(ctx, readFileSync(specPath, "utf-8"));
        ledger.recordScope(scope);
        if (scope.outOfScope.length > 0) {
          ledger.escalate(
            `Scope violation: files changed outside the spec's declared scope: ${scope.outOfScope.join(", ")}`,
          );
        }

        saveState(ctx.root, {
          sprint,
          phase: "build_verify",
          specName,
          specPath,
          branchName,
        });
      }

      // ── Phase: Build Verify (with fix loop) ──
      if (shouldRun(startPhase, "build_verify") && !isTimedOut()) {
        const hasBackend = ctx.workspaces.some(
          (w) => w.type === "backend" || w.type === "shared",
        );
        const hasFrontend = ctx.workspaces.some(
          (w) => w.type === "frontend",
        );

        if (hasBackend && hasFrontend) {
          // Verify backend first, then full
          await verifyAndFix(
            ctx,
            "backend",
            specPath,
            opts.models.fixAgent,
            opts.maxFixAttempts,
            ledger,
          );
        }

        saveState(ctx.root, {
          sprint,
          phase: "full_verify",
          specName,
          specPath,
          branchName,
        });
      }

      // ── Phase: Full Verify ──
      if (shouldRun(startPhase, "full_verify") && !isTimedOut()) {
        const result = await verifyAndFix(
          ctx,
          "full",
          specPath,
          opts.models.fixAgent,
          opts.maxFixAttempts,
          ledger,
        );

        // Policy gate: a failed verification changes the outcome, not just
        // the log line. (The stalled-fix-loop case escalates inside
        // verifyAndFix; this covers exhausting all attempts.)
        if (!result.passed && !ledger.hasEscalations) {
          ledger.escalate(
            `Full verification failed after ${opts.maxFixAttempts} fix attempts: ${result.failedChecks.join(", ")}`,
          );
        }

        saveState(ctx.root, {
          sprint,
          phase: "audit",
          specName,
          specPath,
          branchName,
        });
      }

      // ── Phase: Audit ──
      if (shouldRun(startPhase, "audit") && !isTimedOut()) {
        const audit = await auditSpec(ctx, specPath, opts.models.auditor);
        ledger.recordAudit(audit);

        // Unknown is not the same as passed
        if (audit.issues.includes(AUDIT_PARSE_FAILURE)) {
          ledger.escalate(
            "Spec audit output could not be parsed — spec conformance is unknown",
          );
        }

        if (audit.missing.length > 0) {
          log(`Audit found ${audit.missing.length} missing items — attempting to fix`);
          // Re-run builder for missing items, then re-verify
          await runBuilders(ctx, specPath, opts.models.builder, ledger);
          const recovery = await verifyAndFix(
            ctx,
            "full",
            specPath,
            opts.models.fixAgent,
            opts.maxFixAttempts,
            ledger,
          );
          if (!recovery.passed) {
            ledger.escalate(
              `Audit recovery rebuild still failing verification: ${recovery.failedChecks.join(", ")}`,
            );
          }
        }

        saveState(ctx.root, {
          sprint,
          phase: "pr",
          specName,
          specPath,
          branchName,
        });
      }

      if (isTimedOut()) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        log(`\nSprint timeout after ${elapsed} min — escalating with current state`);
        ledger.escalate(
          `Sprint timed out after ${elapsed} min — later phases were skipped and the work is unverified`,
        );
      }

      // ── Phase: PR ──
      const outcome = resolveOutcome(ledger, opts);
      ledger.setOutcome(outcome);

      if (shouldRun(startPhase, "pr")) {
        ship(ctx, branchName, specName, {
          parentBranch: previousBranch || undefined,
          outcome,
          evidenceMarkdown: ledger.renderMarkdown(),
        });
      }

      // Sprint complete
      clearState(ctx.root);
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      log(`\nSprint ${sprint} finished in ${elapsed} minutes — outcome: ${outcome.toUpperCase()}`);

      if (outcome !== "shipped") {
        // Escalation ladder: a sprint that needs human judgment ends the
        // run — chaining further sprints onto unverified work compounds
        // the failure.
        for (const reason of ledger.escalations) log(`  - ${reason}`);
        if (outcome === "blocked") process.exitCode = 1;
        log("Stopping: this sprint needs human review before Ralph continues.");
        break;
      }

      // Track this branch so the next sprint chains from it
      previousBranch = branchName;

      if (opts.singleMode) {
        log("Single mode — stopping after one sprint");
        break;
      }
    } catch (err) {
      log(`Sprint ${sprint} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  log("\nRalph finished.");
}

/**
 * Pause the sprint at a human gate. Interactive runs ask inline; headless
 * runs park the sprint (state saved with awaitingApproval) and exit so
 * `ralph approve` can release it later. Returns true when the human
 * approved inline.
 */
async function gateForHuman(
  root: string,
  gate: "plan" | "ambiguity",
  info: {
    sprint: number;
    specName: string;
    specPath: string;
    branchName: string;
    question: string;
  },
): Promise<boolean> {
  if (isInteractive()) {
    const approved = await confirm(`\n${info.question}`);
    if (approved) return true;
  }

  saveState(root, {
    sprint: info.sprint,
    phase: "build",
    specName: info.specName,
    specPath: info.specPath,
    branchName: info.branchName,
    awaitingApproval: true,
    gate,
  });
  log(`\nSprint ${info.sprint} paused at the ${gate} gate.`);
  log(`  Spec: ${info.specPath}`);
  log("  Review/edit it, then run `ralph approve` and re-run `ralph run` to continue.");
  return false;
}

function writeQuestionsFile(
  root: string,
  sprint: number,
  specPath: string,
  ambiguities: string[],
): string {
  const dir = join(root, ".ralph");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `questions-sprint-${sprint}.md`);
  writeFileSync(
    path,
    [
      `# Sprint ${sprint} — open questions before build`,
      "",
      `Spec: \`${relative(root, specPath)}\``,
      "",
      "The pre-build review found ambiguities that need a human decision.",
      "Answer them by editing the spec, then run `ralph approve` and re-run `ralph run`.",
      "",
      ...ambiguities.map((q) => `- [ ] ${q}`),
      "",
    ].join("\n"),
  );
  return path;
}

/**
 * The first link of the audit trail: what was Ralph asked to achieve?
 */
function deriveGoal(ctx: ProjectContext, opts: EngineOptions): string {
  if (opts.goal) return opts.goal;
  if (opts.task) return `Directed task: ${opts.task}`;
  if (opts.improve)
    return "Improvement mode: highest-value quality fixes found in the codebase (no product spec)";
  if (ctx.productSpec)
    return `Next increment of the product spec: \`${relative(ctx.root, ctx.productSpec)}\``;
  return "(no goal recorded)";
}

/**
 * Resolve the sprint outcome from accumulated escalations and the
 * configured failure policy.
 */
function resolveOutcome(ledger: EvidenceLedger, opts: EngineOptions): SprintOutcome {
  if (!ledger.hasEscalations) return "shipped";
  switch (opts.onVerifyFailure) {
    case "ship":
      return "shipped";
    case "block":
      return "blocked";
    default:
      return "escalated";
  }
}

/**
 * Find the branch for the previous sprint by scanning local branches.
 * Returns null if no branch found OR if it's already merged into base
 * (in which case base branch has all the work and is the better parent).
 */
function findPreviousSprintBranch(
  root: string,
  currentSprint: number,
  baseBranch: string,
): string | null {
  const branches = listBranches(root);
  const prevNumber = currentSprint - 1;
  const match = branches.find((b) =>
    b.match(new RegExp(`^sprint/sprint-${prevNumber}-`)),
  );
  if (!match) return null;

  // If the branch is already merged into base, use base instead
  if (isBranchMergedInto(root, match, baseBranch)) {
    log(`  Previous sprint branch ${match} already merged into ${baseBranch} — starting from ${baseBranch}`);
    return null;
  }

  return match;
}

const PHASE_ORDER = [
  "spec",
  "build",
  "build_verify",
  "full_verify",
  "audit",
  "pr",
] as const;

function shouldRun(startPhase: string, currentPhase: string): boolean {
  const startIdx = PHASE_ORDER.indexOf(
    startPhase as (typeof PHASE_ORDER)[number],
  );
  const currentIdx = PHASE_ORDER.indexOf(
    currentPhase as (typeof PHASE_ORDER)[number],
  );
  return currentIdx >= startIdx;
}
