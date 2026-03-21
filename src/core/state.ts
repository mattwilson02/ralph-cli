import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SprintState } from "../types.js";
import { log } from "../util/logger.js";

const STATE_FILE = ".ralph-state.json";

export function loadState(root: string): SprintState | null {
  const path = join(root, STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as SprintState;
    log(`Resuming from saved state: sprint ${state.sprint}, phase ${state.phase}`);
    return state;
  } catch {
    return null;
  }
}

export function saveState(root: string, state: SprintState): void {
  writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2));
}

export function clearState(root: string): void {
  const path = join(root, STATE_FILE);
  if (existsSync(path)) unlinkSync(path);
}
