# CLAUDE.md — Radar Zamówień

## Before making changes

1. Read `docs/MASTER_PROMPT.md` (project constitution).
2. Read `docs/STATE.md` (where we are, next action).
3. Read `docs/PR_PLAN.md` (scope + acceptance criteria of the active PR).
4. Inspect `git status` and recent `git log`.
5. Identify the active PR.
6. Do not work outside the active PR scope. Out-of-scope ideas go to `docs/STATE.md` → "Next action"/notes, not into code.

Also useful: `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DECISIONS.md`, `docs/AGENTS.md`.

## Key rules

- **Exactly 3 agents**: `coder`, `code-and-safety-reviewer`, `quality-reviewer` (`.claude/agents/`). The main session coordinates and is not an agent. Never add a fourth. Never let one agent do both reviews. Workflow: `docs/AGENTS.md`.
- **Modular monolith**, one TypeScript/Node.js process + PostgreSQL + cron. No microservices, queues, Redis, Kafka, Kubernetes, ElasticSearch, CQRS or event sourcing.
- **No overengineering**: design for 10–100 customers; no abstractions for hypothetical features; prefer one table / one process / cron / a plain adapter.
- **Responsible data collection**: public data only, no CAPTCHA/anti-bot/auth bypass, rate limited, bounded. See `docs/SECURITY.md`.
- **Never invent data**: a missing value stays `null`, never `0` or a guess.
- **No destructive git operations** (force push, `reset --hard`, branch deletion, history rewrite) without explicit user confirmation. Never `--no-verify`.
- **Test before declaring completion**: `pnpm check` (format, lint, typecheck, tests) must pass. Never weaken or edit a correct test to make new code pass.
- **Update `docs/STATE.md`** after meaningful work.

## Commands

```bash
pnpm install        # Node >= 22.19, pnpm 10 (see packageManager in package.json)
pnpm check          # format:check + lint + typecheck + test
pnpm health         # run the health command from source
pnpm build && pnpm start health
```
