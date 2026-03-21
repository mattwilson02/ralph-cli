# Ralph User Flows

Every path through the CLI, from first install to shipping PRs.

---

## 1. First-Time Setup

```
npm install -g ralph-cli
claude login                    # authenticate with Claude subscription
```

That's it. No config files, no API keys (unless you prefer `ANTHROPIC_API_KEY`).

---

## 2. Existing Project with Product Spec

**You have:** A codebase and a product spec describing what to build.

```
cd my-project

ralph init --spec docs/PRODUCT_SPEC.md
# → Scans project, detects stack, saves spec path to .ralph.yaml
# → Shows: languages, frameworks, workspaces, checks

ralph run --single
# → Sprint 1: writes spec → builds → verifies → fixes → audits → PR

ralph run --sprint 2 --max-sprints 3
# → Sprints 2-4: chains from sprint 1 branch, accumulates work
# → Each sprint PRs against the previous sprint's branch
```

**Flow:**
```
init → scan → save config
                ↓
run → spec writer (Opus) → builder (Sonnet) → verify + fix loop → audit (Opus) → PR
       ↓                                                                          ↓
  reads product spec                                              commits, pushes, gh pr create
  reads previous sprints                                          chains to next sprint
```

---

## 3. Existing Project, No Spec

**You have:** A codebase but no product spec. Two options:

### Option A: Generate a spec
```
ralph spec
# → Opus analyzes your codebase, writes PRODUCT_SPEC.md
# → Review and edit it

ralph init --spec PRODUCT_SPEC.md
ralph run --single
```

### Option B: Improvement mode
```
ralph run --single
# → No spec detected, enters improvement mode automatically
# → Analyzes codebase for: broken tests, missing error handling,
#   security gaps, dead code, incomplete features
# → Writes an improvement sprint spec, builds fixes, ships PR
```

**Flow:**
```
No spec detected
       ↓
 ┌─────┴──────┐
 │  ralph spec │ ──→ generates PRODUCT_SPEC.md ──→ init --spec ──→ sprint mode
 └─────────────┘
       or
 ┌─────────────┐
 │  ralph run   │ ──→ improvement mode ──→ analyzes codebase ──→ fixes quality issues
 └─────────────┘
```

---

## 4. Directed Task

**You have:** A specific thing you want done, not a full sprint.

```
ralph run --task "add rate limiting to all API endpoints"
ralph run --task "fix the login crash when email is empty"
ralph run --task "increase test coverage for the auth module"
```

**Flow:**
```
--task flag
    ↓
skip pre-written spec lookup
    ↓
spec writer explores codebase → writes focused sprint spec for this task
    ↓
builder → verify → fix → audit → PR
```

Task mode always runs a single sprint (no `--max-sprints`).

---

## 5. Greenfield Project

**You have:** An empty repo (or near-empty) with a product spec that includes an Architecture section.

```
mkdir my-new-app && cd my-new-app
git init

# Write a PRODUCT_SPEC.md with:
#   - What to build
#   - ## Architecture section (stack, framework, database, patterns)

ralph init --spec PRODUCT_SPEC.md
# → Detects greenfield (no workspaces, no checks)
# → Warns if spec is missing Architecture section

ralph run --single
# → Sprint 1 scaffolds: directory structure, configs, base patterns, initial feature
# → Establishes the foundation future sprints build on
```

**Flow:**
```
Empty repo + spec with Architecture
    ↓
init detects greenfield
    ↓
spec writer includes scaffolding instructions
    ↓
builder establishes patterns (not "follow existing" — "create best practices")
    ↓
verify + PR
    ↓
Sprint 2+ builds features on top of scaffold
```

---

## 6. Non-Standard Base Branch

**You have:** A project where the main branch isn't `main` or `master`.

```
ralph init --base-branch develop
# → Saves to .ralph.yaml, all sprints branch from develop

ralph run --single
# → Branches from develop, PRs target develop
```

Ralph auto-detects `dev`, `develop`, `main`, `master` in that order. Use `--base-branch` to override.

---

## 7. Multi-Sprint Run with Chaining

```
ralph run --sprint 1 --max-sprints 5
```

**Sprint chaining flow:**
```
Sprint 1: branch from main → build → PR against main
                                         ↓
Sprint 2: branch from sprint-1-* → build → PR against main
                                              ↓
Sprint 3: branch from sprint-2-* → build → PR against main
                                              ↓
...continues
```

Each sprint branches from the previous sprint's branch (so it has all the code and specs), but PRs always target the base branch. GitHub auto-shrinks the diff once earlier PRs are merged.

**After merging PRs and continuing later:**
```
# Merge all PRs into main, then:
ralph run --sprint 6 --max-sprints 3

# Ralph checks: is sprint-5-* branch merged into main?
# → Yes, already merged — starts from main (which has all the work)
# → No, still unmerged — chains from sprint-5-* branch
```

---

## 8. Crash Recovery

Ralph saves state to `.ralph-state.json` before each phase transition.

```
ralph run --single
# → Crashes during build phase

ralph run --single
# → Detects .ralph-state.json
# → Resumes at build phase (skips spec writing)
# → Continues: build → verify → fix → audit → PR
```

**State file contains:** sprint number, current phase, spec name/path, branch name.

To force a fresh start, delete `.ralph-state.json`.

---

## 9. Pre-Written Sprint Specs

You can write sprint specs yourself and Ralph will use them instead of generating new ones.

```
# Write docs/sprints/sprint-3-my-feature.md manually

ralph run --sprint 3 --single
# → Finds pre-written spec, skips spec writer
# → Builds from your spec directly
```

File naming: `sprint-{number}-{descriptive-name}.md` in the sprints directory.

---

## 10. Non-GitHub Projects

Ralph works with any Git host (GitLab, Gitea, Bitbucket, self-hosted).

```
ralph run --single
# → Commits and pushes to your remote
# → PR creation fails (gh CLI only works with GitHub)
# → Logs: "PR creation failed — create a PR manually"
# → Sprint still completes, code is on the branch
```

---

## Config Reference

### `.ralph.yaml`

```yaml
# Ralph configuration (generated by ralph init, editable)
spec: docs/PRODUCT_SPEC.md
baseBranch: develop
```

Created by `ralph init --spec` or `ralph init --base-branch`. Merged on each save (adding `--spec` won't overwrite `baseBranch`).

### Product Spec Search Order

If no `--spec` flag and no `.ralph.yaml`, Ralph checks:
1. `PRODUCT_SPEC.md`
2. `SPEC.md`
3. `docs/PRODUCT_SPEC.md`
4. `docs/product-spec.md`
5. `VISION.md`
6. `docs/VISION.md`

### Sprint Spec Location

Generated specs go to `docs/sprints/`. Ralph checks for existing directories in order:
1. `docs/sprints/`
2. `sprints/`
3. `.ralph/sprints/`

Falls back to creating `docs/sprints/`.

---

## Decision Tree

```
ralph run
    │
    ├── --task flag? ──→ Task Mode (single sprint, focused spec)
    │
    ├── Product spec found? ──→ Sprint Mode (plan from spec)
    │   │
    │   └── Greenfield detected? ──→ Greenfield Mode (scaffold first)
    │
    └── No spec ──→ Improvement Mode (fix quality issues)
```
