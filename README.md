<p align="center">
  <img src="docs/ralph.png" alt="Ralph" width="200" />
</p>

<h1 align="center">ralph</h1>

<p align="center">
  <em>"Me fail English? That's unpossible."</em>
  <br /><br />
  <strong>Autonomous AI dev agent.</strong><br />
  Point it at your codebase — it builds, verifies, and ships.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#modes">Modes</a> &middot;
  <a href="#supported-stacks">Supported Stacks</a> &middot;
  <a href="#cli-reference">CLI Reference</a>
</p>

---

## What is Ralph?

Ralph is a zero-config autonomous sprint runner. It reads your codebase, figures out your stack, and gets to work:

1. **Scans your project** — detects stack, frameworks, test runners, monorepo structure. Zero config.
2. **Writes sprint specs** — breaks your product spec into small, shippable increments
3. **Builds the code** — scoped builder agents that follow your existing patterns
4. **Verifies everything** — runs your project's own checks (build, typecheck, test, lint)
5. **Fixes failures** — if checks fail, a fix agent debugs and patches until they pass
6. **Audits against spec** — compares the implementation against the sprint spec
7. **Ships a PR** — commits, pushes, and opens a pull request for review

Then it moves on to the next sprint.

## Quick Start

### Prerequisites

- Node.js 20+
- [Claude Code](https://claude.com/claude-code) authenticated (`claude login`) — Ralph runs on your Claude subscription (Pro/Max)
  - Or: `ANTHROPIC_API_KEY` environment variable if you prefer API tokens
- `gh` CLI authenticated (for creating PRs — optional, Ralph still commits without it)
- Git repository

### Install

```bash
npm install -g ralph-agent
```

### Usage

```bash
# Scan your project — see what Ralph detects
ralph init

# Run a single sprint
ralph run --single

# Give Ralph a specific task
ralph run --task "add rate limiting to all API endpoints"

# Run 3 sprints starting from sprint 5
ralph run --sprint 5 --max-sprints 3

# Run against a different directory
ralph run --dir ~/projects/my-app
```

## Modes

Ralph adapts to your project automatically. One command, smart behavior.

### Sprint Mode (default)

You have a product spec. Ralph reads it, plans sprints, builds them.

```bash
ralph init --spec PRODUCT_SPEC.md   # save your spec path
ralph run --single                   # build the next sprint
```

### Task Mode

You have a specific thing you want done. Ralph explores the codebase, writes a focused spec, builds it, ships a PR.

```bash
ralph run --task "fix the login crash when email is empty"
ralph run --task "increase test coverage for the auth module"
ralph run --task "add pagination to the users API"
```

### Improvement Mode

No product spec? Ralph analyzes the codebase and finds the most impactful quality improvements — broken tests, missing error handling, security gaps, dead code.

```bash
ralph run --single   # auto-detects no spec, enters improvement mode
```

### Draft Spec Generation

Don't have a product spec? Ralph can generate one from your codebase.

```bash
ralph spec                     # generates PRODUCT_SPEC.md
# review and edit it, then:
ralph init --spec PRODUCT_SPEC.md
ralph run --single
```

### Greenfield

New project with no code yet? Ralph detects this automatically and scaffolds the project before building features — directory structure, configs, base patterns.

```bash
ralph run --single   # auto-detects greenfield, scaffolds first
```

## How It Works

```
ralph run
  |
  +-- Scan codebase (zero-config detection)
  |
  +-- For each sprint:
       |
       +-- 1. Spec Writer (Opus)
       |     Reads product spec + previous sprints
       |     Outputs a scoped sprint spec (max 15 files, max 5 tasks)
       |
       +-- 2. Builder Agents (Sonnet)
       |     Backend-first, then frontend (in monorepos)
       |     Adapts: follows existing patterns in mature codebases,
       |     establishes best practices in early-stage ones
       |
       +-- 3. Verify + Fix Loop (Sonnet)
       |     Runs your checks (build, test, lint, typecheck)
       |     Fix agent patches failures, retries up to 3x
       |
       +-- 4. Audit (Opus)
       |     Compares implementation against sprint spec
       |     Re-runs builder if items are missing
       |
       +-- 5. Ship
             git commit -> git push -> gh pr create
```

### Crash Recovery

Ralph saves state before each phase transition to `.ralph-state.json`. If it crashes or times out, re-run the same command and it picks up where it left off.

### Models

| Phase | Default Model | Role |
|-------|--------------|------|
| Spec Writer | `claude-opus-4-6` | Strategic planning, sprint scoping |
| Builder | `claude-sonnet-4-6` | Code generation, pattern matching |
| Fix Agent | `claude-sonnet-4-6` | Debugging, targeted fixes |
| Auditor | `claude-opus-4-6` | Spec compliance verification |

All models are overridable via CLI flags.

## Supported Stacks

Ralph auto-detects your project with zero configuration:

| Language | Frameworks | Package Managers |
|----------|-----------|-----------------|
| TypeScript / JavaScript | NestJS, Express, Fastify, Hono, Next.js, Nuxt, Remix, Expo, React Native, Svelte, Vue, Angular, Solid, Astro | npm, yarn, pnpm, bun |
| Python | Flask, FastAPI, Django, Sanic, Starlette, Tornado, Litestar | pip (requirements.txt, pyproject.toml, Pipfile) |
| Go | Gin, Fiber, Echo, Chi, Gorilla | go mod |
| Rust | Actix, Axum, Rocket, Warp | cargo |

**Databases:** Prisma, Drizzle, TypeORM, Mongoose, SQLAlchemy, ChromaDB, SQLx, Diesel, Sea-ORM

**Test Runners:** Vitest, Jest, Mocha, Playwright, Cypress, pytest, `go test`, `cargo test`

**Linters:** Biome, ESLint, Prettier, Ruff, Flake8, Black, golangci-lint, Clippy

**Project Structures:** Monorepos (npm/yarn/pnpm workspaces, Turborepo, Nx), polyglot multi-service repos, single-app repos, Docker Compose setups

## CLI Reference

### `ralph init [dir]`

Scan a project and display detected configuration.

| Flag | Description |
|------|-------------|
| `--spec <path>` | Set the product spec path (saved to `.ralph.yaml`) |
| `--base-branch <branch>` | Set the base branch (saved to `.ralph.yaml`) |

```
$ ralph init

  Project:         my-app
  Monorepo:        yes
  Package manager: pnpm
  Languages:       typescript
  Frameworks:      nestjs, nextjs
  Database:        prisma
  Test runner:     vitest
  Linter:          biome
  Build tool:      turbo
  Base branch:     main

  Workspaces:
    @my-app/api -- backend (nestjs) [apps/api]
      Checks: Build, Type Check, Unit Tests, E2E Tests, Lint
    @my-app/web -- frontend (nextjs) [apps/web]
      Checks: Build, Lint

  Ready. Run `ralph run` to start sprinting.
```

### `ralph run [options]`

Start autonomous sprint execution. Adapts behavior based on project state.

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --dir <path>` | `.` | Project directory |
| `-s, --sprint <n>` | `1` | Starting sprint number |
| `--max-sprints <n>` | `10` | Maximum sprints to run |
| `--single` | `false` | Run one sprint then stop |
| `-t, --task <desc>` | - | Directed task (skips spec writer, builds from description) |
| `--spec <path>` | auto-detected | Path to product spec |
| `--max-fix-attempts <n>` | `3` | Max fix attempts per verify cycle |
| `--spec-model <model>` | `claude-opus-4-6` | Model for spec writer |
| `--build-model <model>` | `claude-sonnet-4-6` | Model for builders |
| `--fix-model <model>` | `claude-sonnet-4-6` | Model for fix agents |
| `--audit-model <model>` | `claude-opus-4-6` | Model for auditor |

### `ralph spec [dir]`

Generate a draft `PRODUCT_SPEC.md` from the codebase. Uses Opus to analyze the project and write a starting point for you to edit.

## Configuration

Ralph is designed to work with **zero configuration**. It reads your codebase and figures out the rest.

### Product Spec

Ralph looks for your product spec in this order:

1. `.ralph.yaml` `spec:` field (set via `ralph init --spec`)
2. `--spec` flag
3. `PRODUCT_SPEC.md`
4. `SPEC.md`
5. `docs/PRODUCT_SPEC.md`
6. `docs/product-spec.md`
7. `VISION.md`

No spec? Ralph runs in **improvement mode** automatically.

### `.ralph.yaml`

Optional config file, created by `ralph init --spec`:

```yaml
# Ralph configuration (generated by ralph init, editable)
spec: docs/VISION.md
```

### Sprint Specs

Generated sprint specs are saved to `docs/sprints/`. You can pre-write sprint specs (`sprint-1-my-feature.md`) and Ralph will use them instead of generating new ones.

## Authentication

Ralph uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and supports two authentication methods:

1. **Claude subscription (recommended)** — Log in with `claude login`. Ralph runs on your existing Claude Pro or Max plan. No API tokens needed.
2. **API key** — Set `ANTHROPIC_API_KEY` for direct Anthropic API access (usage-based billing).

## License

MIT
