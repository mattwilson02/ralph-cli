# Ralph Roadmap

## v0.1.0 — Beta (current)

Zero-config autonomous sprint runner. Scans your codebase, generates sprint specs from your product spec, builds, verifies, and ships PRs.

### What's in
- **Polyglot scanner** — TypeScript, JavaScript, Python, Go, Rust. Monorepos, polyglot, single-app, Docker.
- **Sprint modes** — Sprint (product spec), Task (`--task`), Improvement (specless), Greenfield (auto-scaffold)
- **Sprint chaining** — each sprint branches from the previous, PRs stack cleanly
- **Draft spec generation** — `ralph spec` analyzes your codebase and writes a PRODUCT_SPEC.md
- **Crash recovery** — state saved between phases, resume on re-run
- **Config** — `.ralph.yaml` for spec path, base branch
- **Auth** — Claude subscription (OAuth) or ANTHROPIC_API_KEY
- **Graceful fallbacks** — non-GitHub remotes, no remote, no spec

---

## v0.2.0 — Post-Beta

### Webhook Integration
- [ ] Ralph emits events (`sprint.started`, `phase.completed`, `sprint.completed`, `sprint.failed`)
- [ ] POST to configurable webhook URL
- [ ] Ralph Dashboard receives and displays sprint events in real-time

### Cost & Budget
- [ ] Track API cost per sprint, per project
- [ ] Budget limits — stop at threshold (`--budget 10.00`)
- [ ] Cost summary at end of run

### CI/CD Integration
- [ ] GitHub Action — run Ralph on schedule or PR trigger
- [ ] GitLab CI template
- [ ] `ralph run --ci` mode — non-interactive, structured JSON output

### Parallel Execution
- [ ] Parallel builder agents (backend + frontend concurrently in monorepos)
- [ ] `ralph run --projects a,b,c` — orchestrate sprints across multiple repos

### Ralph Watch TUI
- [ ] Ink-based terminal UI showing live sprint progress
- [ ] Phase timeline, live logs, cost ticker
- [ ] Multi-project view

---

## v0.3.0 — Polish

### Multi-Platform Agent Support
- [ ] Abstract `runAgent` into a provider interface (`ClaudeProvider`, `CodexProvider`, etc.)
- [ ] OpenAI Codex CLI / API backend
- [ ] Google Gemini backend
- [ ] Ollama / local model backend
- [ ] `--provider` flag or `.ralph.yaml` config (`provider: codex`)

### Scanner Improvements
- [ ] Java/Kotlin (Maven, Gradle)
- [ ] Ruby (Gemfile, Rails/Sinatra)
- [ ] C#/.NET (`.csproj`, `.sln`)
- [ ] PHP (composer.json, Laravel/Symfony)
- [ ] Elixir (mix.exs, Phoenix)
- [ ] Swift (Package.swift)
- [ ] Rust Cargo workspace members
- [ ] Deeper Python (Poetry, PDM, Hatch)
- [ ] Makefile-based check detection

### Engine
- [ ] Configurable phase pipeline (skip audit, skip verify, custom phases)
- [ ] Dry-run mode (`ralph run --dry-run` — spec only)
- [ ] Per-workspace check overrides
- [ ] Ignore patterns (files the builder should never touch)

### CLI
- [ ] `ralph status` — current sprint state, branch, phase
- [ ] `ralph verify` — run verification checks only
- [ ] Interactive init (`ralph init --interactive`)
- [ ] Log levels (debug, info, warn, error)
- [ ] Better error messages (human-readable, not stack traces)
