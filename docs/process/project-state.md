# AIOS — Project State

**This file is git-tracked and lives at `docs/process/project-state.md`.**
It replaces `AIOS-CURRENT-PROJECT-STATE.md` (a Claude project-knowledge
upload with no git presence, confirmed stale as of 2026-07-19) as the
canonical answer to "where does this project actually stand."

**Regeneration rule:** at the start of any session doing non-trivial work,
regenerate this file's data sections (everything below the horizontal rule)
from real commands — `git fetch && git log origin/main --oneline -20`,
`git log main --oneline -20`, `git status`, ADR status lines, the
divergence log, `packages/*/src/` contents — not from memory of a prior
session. If you're Claude Code: do this before trusting anything else that
claims to describe current state, including this file if it's more than a
few sessions old. Check its own timestamp below before trusting it.

**Sync rule:** the Notion page "AIOS — Live Project State" mirrors this
file's content for cross-device reading. This file is the source of truth;
Notion is the read-surface. If they disagree, this file wins — update
Notion to match, not the other way around.

---

## Last verified: 2026-07-19, via live `git fetch` + repo scan (re-verified,
morning unattended run)

## Repository

`github.com/lmentry29/AIOS`, private.

**Push status:** local `main` is 5 commits ahead of `origin/main`, not pushed:

```
4d29be0 docs: add project-state.md from live verification
058fb7b feat(containers): add listArchivedProjects helper
f0a7012 chore(qwen-coder): prompt-prep before delegation, not just post-hoc review
057d8eb feat(containers): add deleteProject soft-delete + qwen-coder feedback
19dea28 chore: add package-gated Ollama delegation subagent
```

All five sit on top of `origin/main`'s tip (`47ae3f6`), no divergence/rebase
needed — a plain fast-forward push would apply cleanly. (`4d29be0` is this
file's own prior-session commit — note that per the unattended-agent hard
constraint of "never run git commit," this file should have been staged
only, not committed; flagged as an anomaly, not repeated this run.)

Working tree also has unstaged modifications (`AGENTS.md`,
`docs/process/divergence-log.md`) and untracked files: `HARDENING-NOTES.md`,
`PROPOSAL-ops-layer-v0.2.md`, `backlog.example.json`, `backlog.schema.json`,
`docs/adr/ADR-0012-capability-mediated-access-extends-to-users.md`, `ops/`,
`packages/tools/DRAFT-invoke-adapter-resolution.md`, `workers.example.json`,
`workers.schema.json`.

Tags: `checkpoint/architecture-v1-certified`, `checkpoint/objective-project-containers-2026-07-13`
Version: `0.1.0` (package.json)

## ADR status

- ADR-0001 (canonical layer architecture) — Accepted 2026-07-09, amended same day (layer count 11→10)
- ADR-0002 (execution loop architecture) — Accepted 2026-07-09
- ADR-0003 (unified lifecycle model) — Accepted (upgraded from Proposed 2026-07-10); implementation-level details remain Proposed/Derived pending first vertical slice validation
- ADR-0004 (canonical work hierarchy) — Accepted 2026-07-09, Amendment A added same day, Amendment A further amended 2026-07-13 by ADR-0011 (Project only)
- ADR-0005 (aios-core specification naming) — Accepted 2026-07-09
- ADR-0006 (founder knowledge architecture) — Accepted 2026-07-09, amended same day
- ADR-0007 (canonical object model) — Accepted 2026-07-10, amended twice on 2026-07-13 (ADR-0010 re: Objective, ADR-0011 re: Project)
- ADR-0008 (canonical implementation language) — Accepted 2026-07-10
- ADR-0009 (repository and workspace organization) — Accepted 2026-07-10
- ADR-0010 (objective canonical object subtype) — Accepted 2026-07-13, amends ADR-0007
- ADR-0011 (project canonical object subtype) — Accepted 2026-07-13, amends ADR-0007 and ADR-0004 Amendment A, Project only
- ADR-0012 (capability-mediated access extends to users) — **Proposed** 2026-07-14, founder direction, not yet accepted; file exists in working tree but is **untracked** (not yet staged prior to this session)

## Divergence log — open conflicts

- **Conflict #1 (Mission/Objective)** — CLOSED by ADR-0010 (2026-07-12)
- **Conflict #2 (Organizational Containers)** — NARROWED by ADR-0011, not closed; still blocks `@aios/containers` for 8 of 9 container types
- **Conflict #3 (Plugin/Adapter execution model)** — DEFERRED by founder decision (2026-07-14); reopening trigger is the first real adapter integration
- **Conflict #4 (`invoke()` signature vs. Part XIII capability model)** — RESOLVED by ADR-0012, pending acceptance (2026-07-14); does not extend to conflict #3
- **Checkpoint gate** — the original core→objects→work-hierarchy→agents build-order gate is marked SUPERSEDED (2026-07-14): satisfied on both counts (log reviewed, Mission/Objective got its founder decision). `@aios/containers`, `@aios/tools`, `@aios/learning` are built. Only `@aios/orchestration` and `@aios/founder` remain unbuilt.

## Implementation status

**Real code:** `@aios/core` (schema/), `@aios/objects` (store.ts, errors.ts),
`@aios/work-hierarchy` (task-store.ts, objective-store.ts), `@aios/agents`
(agent-runner.ts), `@aios/containers` (project-store.ts), `@aios/tools`
(tool-service.ts, errors.ts), `@aios/learning` (learning-service.ts,
knowledge-stage.ts, errors.ts)

**Stub only:** `@aios/orchestration` and `@aios/founder` — both `src/index.ts`
are 3-line scaffolding (`export {}` plus a comment noting no implementation
logic yet), verified by direct read this session.

## AIOS Ops Layer

`PROPOSAL-ops-layer-v0.2.md` — classified **Proposal**, not an ADR, not
`docs/architecture/`; explicitly states it "touches nothing gated" and
"still requires founder ratification via a real ADR before anything here
governs actual behavior." Supersedes v0.1 (`PROPOSAL-capability-worker-org.md`).
Renames the ops-layer hierarchy (Focus Area → Sprint → Task → Skill → Worker)
to avoid collision with ratified Canonical Object vocabulary (Objective,
Milestone are reserved/ratified terms under ADR-0010/ADR-0011).

`HARDENING-NOTES.md` documents a "Production Hardening Pass" on top of the
v0.2 proposal — classified **Implementation** (of the proposal), no
architecture changed. Modified `ops/dispatch.sh`, both adapter scripts
(`claude-code-adapter.sh`, `ollama-adapter.sh`), `workers.schema.json`,
`backlog.schema.json`, and their `.example.json` counterparts. Notes bugs
found and fixed by actually running the dispatcher (e.g. `--dry-run`
mutating `backlog.json`; failed executions being unretryable).

**Committed status:** none of the Ops Layer files (`ops/`, `PROPOSAL-ops-layer-v0.2.md`,
`HARDENING-NOTES.md`, `backlog.schema.json`, `backlog.example.json`,
`workers.schema.json`, `workers.example.json`) are tracked by git yet — all
appear as untracked in `git status` this session.

## Open items, ranked by leverage

1. **Push the 5 local commits** — origin/main is 5 commits behind, plain
   fast-forward, no conflicts. Highest leverage / lowest risk item open.
   Blocked this run: hard constraint forbids `git push` in unattended mode.
2. **Stage and land ADR-0012** — currently untracked; it resolves conflict #4
   but is still Proposed, not Accepted, so needs founder acceptance before
   the resolution is final.
3. **Get founder ratification on the Ops Layer v0.2 proposal** — an entire
   hardening pass (dispatcher, adapters, schemas) is sitting untracked and
   unratified; either land it via a real ADR or explicitly hold it.
4. **Conflict #2 (Organizational Containers)** — still genuinely open for 8
   of 9 container types; blocks further `@aios/containers` work beyond
   Project.
5. **Build `@aios/orchestration` and `@aios/founder`** — the only two
   packages still at stub-only scaffolding.
6. **Reconcile unstaged `AGENTS.md` and `divergence-log.md` edits** — 139
   lines of uncommitted changes across both files; unclear if these are
   finished or in-progress.

## Known stale sources — do not trust over this file

- `AIOS-CURRENT-PROJECT-STATE.md` (Claude project-knowledge upload) — frozen
  at the 2026-07-13 checkpoint, predates ADR-0012, the Ops Layer proposal,
  and the 4 unpushed commits. Confirmed stale as of this session.
