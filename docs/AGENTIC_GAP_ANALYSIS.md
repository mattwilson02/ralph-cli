# Agentic System Gap Analysis

A theoretical review of Ralph's execution model against established agentic system principles. Not a bug list — a design-level analysis to inform future architectural decisions.

Derived from a study of GitHub's agentic controls documentation and applied to Ralph's current phase pipeline (spec → build → build_verify → full_verify → audit → pr).

---

## What Ralph already does correctly

Before the gaps: several things in the current design are genuinely aligned with best practice.

- **External signals for evaluation.** `verifyAndFix` runs actual commands via `runSafe` and injects real error output into the fix prompt. The model reads the signal — it does not generate it. This is the correct pattern.
- **Error context injected into retry.** The fix agent receives the actual failed output, not a generic "try again." Each retry is informed by the previous failure.
- **Scope-restricted fix agent.** The fix agent system prompt explicitly forbids introducing new features or deleting failing tests. Constraints are declared at the agent boundary.
- **Phase state persistence.** Crash recovery is handled via `.ralph-state.json` — the engine resumes at the correct phase rather than restarting blind.
- **Spec conformance audit.** The auditor reads the spec and the code and checks whether declared items were implemented. A post-build conformance check exists.

---

## Identified gaps

### 1. Shipping on known verification failure

**Location:** `src/core/engine.ts` — full verify phase

**Current behaviour:** When `verifyAndFix` returns `false` (all fix attempts exhausted, checks still failing), the engine logs "shipping anyway with known issues" and proceeds to the PR phase.

**Why this is a problem:** This is the "blind trust in automation" anti-pattern. A failing verification signal is treated as non-blocking. The PR is raised against a codebase that the system itself knows is broken. Human reviewers may not notice the qualification buried in logs.

**Theoretical fix:** Introduce a policy gate — either a `strictVerify` flag that aborts the sprint on failure, or an explicit escalation path (e.g., raise a draft PR with a failure notice rather than a normal PR). The key principle is that a failed system signal should change the outcome, not just the log message.

---

### 2. Audit recovery path has no outcome gate

**Location:** `src/core/engine.ts` — audit phase

**Current behaviour:** When the auditor finds missing items, the engine re-runs the builder and then calls `verifyAndFix` — but discards the result. If the second verify also fails, execution proceeds to the PR phase regardless.

**Why this is a problem:** The audit recovery path has the same failure mode as gap 1, but more quietly. It runs a recovery loop, silently ignores whether that loop succeeded, and ships anyway.

**Theoretical fix:** Capture the result of the post-audit `verifyAndFix` call and apply the same policy gate as the primary verify path.

---

### 3. Auditor parse failure defaults to a clean pass

**Location:** `src/phases/auditor.ts`

**Current behaviour:** If the auditor agent returns output that cannot be parsed as JSON, the function returns `{ completed: [], missing: [], issues: [] }` — an empty, clean result. Execution continues as though the audit passed.

**Why this is a problem:** A parse failure is an unknown state, not a successful audit. Treating it as clean is a silent confidence-based fallback: the system cannot evaluate the output, so it assumes success. This is the failure mode the external signals principle is designed to prevent.

**Theoretical fix:** A parse failure should produce a non-empty `issues` array (e.g., `["audit-parse-failure"]`) so it surfaces in logs and, under a strict policy gate, blocks the sprint. Unknown is not the same as passed.

---

### 4. No scope violation check

**Location:** `src/phases/builder.ts` / `src/core/engine.ts` — post-build

**Current behaviour:** The builder agent can touch any file in the repository. Nothing compares the actual changeset (git diff) against the files and paths declared in the spec.

**Why this is a problem:** An agent that implements the spec correctly but also modifies unrelated files is a scope violation. This is not caught by verification (tests can still pass), not caught by the auditor (which checks completeness, not containment), and not visible until human review — if at all.

**Theoretical fix:** After the build phase, run a git diff to enumerate touched files. Compare against files and directories mentioned in the spec. Surface any out-of-scope touches as an audit signal, and treat them as a hard escalation regardless of whether other signals pass. Scope violations should not be overridden by a green test run.

---

### 5. No pre-action ambiguity gate

**Location:** `src/phases/builder.ts` — before execution

**Current behaviour:** The builder receives the spec and immediately begins execution (up to 200 turns). There is no mechanism for the builder to surface ambiguity or missing information before acting.

**Why this is a problem:** If the spec is underspecified or contradictory in a non-obvious way, the builder may reason confidently in the wrong direction for many turns before hitting a verification failure. The failure is then treated as an implementation error when it was actually a specification error — and the fix loop attempts to fix code rather than fix the spec.

This is also where agent confidence signals *are* appropriate: not as an evaluation of output, but as a pre-action signal of uncertainty before execution begins.

**Theoretical fix:** A short pre-build agent call — constrained to read-only tools, low turn limit — that reviews the spec and returns either "actionable" or a list of ambiguities to resolve. If ambiguities are surfaced, the sprint pauses for human input rather than running 200 turns of potentially misdirected execution.

---

## Priority assessment

| Gap | Value | Effort | Notes |
|-----|-------|--------|-------|
| 1 — Ship on failure | High | Low | One policy flag + abort path |
| 2 — Audit gate | High | Low | Capture and act on existing return value |
| 3 — Audit parse fallback | Medium | Low | Change default return value |
| 4 — Scope violation check | High | Medium | Requires git diff + spec path extraction |
| 5 — Pre-action ambiguity | Medium | Medium | New agent call, new prompt, new gate |

Gaps 1–3 are small code changes with meaningful correctness improvements. Gaps 4–5 are architectural additions that address the deeper problem of an agent operating without bounded scope or a way to signal uncertainty before acting.

---

## Underlying principle

These gaps share a common root: the system currently treats uncertainty and failure as log-level events rather than control-flow events. The principle from agentic systems design is that a failed or unknown signal should change what happens next — not just what gets written to a log. Ralph's evaluation loop is well-designed; the gaps are in what the loop does with a bad result.
