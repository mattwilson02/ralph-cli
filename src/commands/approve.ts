import { resolve } from "node:path";
import { loadState, saveState } from "../core/state.js";
import { approveArchitecture, loadArchitecture } from "../phases/architect.js";
import { initLogger, log } from "../util/logger.js";

/**
 * Release whatever is parked at a human gate: a sprint paused at the
 * plan-first/ambiguity gate, or a draft ARCHITECTURE.md from the
 * greenfield interview. The next `ralph run` continues past the gate.
 */
export function approve(dir: string): void {
  const root = resolve(dir);
  initLogger(root);

  const state = loadState(root);
  if (!state) {
    if (approveArchitecture(root)) {
      log("Approved ARCHITECTURE.md.");
      log("  Run `ralph run` to scaffold against it.");
      return;
    }
    log("Nothing to approve — no sprint is in progress and no draft architecture is pending.");
    return;
  }

  if (!state.awaitingApproval) {
    if (loadArchitecture(root)?.status === "draft" && approveArchitecture(root)) {
      log("Approved ARCHITECTURE.md.");
      log("  Run `ralph run` to scaffold against it.");
      return;
    }
    log(`Sprint ${state.sprint} is not waiting at a gate (phase: ${state.phase}).`);
    return;
  }

  saveState(root, { ...state, awaitingApproval: false, approved: true });
  log(`Approved the ${state.gate || "pending"} gate for sprint ${state.sprint}.`);
  log(`  Spec: ${state.specPath}`);
  log("  Run `ralph run` to continue the sprint.");
}
