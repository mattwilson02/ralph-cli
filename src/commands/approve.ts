import { resolve } from "node:path";
import { loadState, saveState } from "../core/state.js";
import { initLogger, log } from "../util/logger.js";

/**
 * Release a sprint that is parked at a human gate (plan-first or
 * ambiguity). Approval is recorded on the saved state; the next
 * `ralph run` resumes from the build phase with the gates satisfied.
 */
export function approve(dir: string): void {
  const root = resolve(dir);
  initLogger(root);

  const state = loadState(root);
  if (!state) {
    log("Nothing to approve — no sprint is in progress.");
    return;
  }

  if (!state.awaitingApproval) {
    log(`Sprint ${state.sprint} is not waiting at a gate (phase: ${state.phase}).`);
    return;
  }

  saveState(root, { ...state, awaitingApproval: false, approved: true });
  log(`Approved the ${state.gate || "pending"} gate for sprint ${state.sprint}.`);
  log(`  Spec: ${state.specPath}`);
  log("  Run `ralph run` to continue the sprint.");
}
