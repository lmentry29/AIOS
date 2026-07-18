---
name: feedback-jsdoc-and-shapes
description: qwen2.5-coder:7b produces functionally-correct code but thin, generic JSDoc and guesses internal data shapes it wasn't shown — both need a manual pass before writing to disk.
metadata:
  type: feedback
---

qwen2.5-coder:7b's code logic is generally correct for bounded, schema-fixed CRUD tasks
(confirmed again on `packages/containers/src/project-store.ts` `deleteProject` — the method
body it drafted was right on the first try), but two things reliably need a manual fix pass:

1. **JSDoc is generic/thin unless the exact prose is supplied.** This codebase's convention
   (see every method in `project-store.ts`) is to cite the specific COM section/ADR number,
   name the invariant being preserved, and cross-reference sibling methods that touch an
   adjacent but independent axis (e.g. `setProjectStatus` vs `lifecycle_state` vs
   `setProjectPhase` — the "no aliasing" pattern). qwen's draft JSDoc for `deleteProject` said
   only "Soft deletes a project by transitioning its lifecycle state" — correct but missing
   the ADR citation and the cross-reference to `setProjectStatus` that this file's existing
   docs always include. Always rewrite JSDoc by hand to match the file's actual citation
   density rather than passing the draft through.

2. **Don't trust qwen (or your own from-memory guess) on internal data shapes it wasn't shown
   — verify against the source.** When writing test assertions against a wrapped store's
   internal record shape (e.g. `lifecycle_history` entries), the field name is easy to get
   wrong by pattern-matching against similar-sounding conventions. Confirmed example: assumed
   `{ to_state, actor }` for a `lifecycle_history` entry; the actual shape in
   `packages/objects/src/store.ts` `transitionLifecycle()` is `{ state, substate, entered_at,
   actor }`. Always grep the actual store/schema file for the literal object shape before
   writing assertions against it, rather than inferring it from the method name or from a
   similar-looking field elsewhere.

**Why:** both failure modes are "plausible-looking but wrong" — exactly the category
[[package-allocation]] flags as the reason certain packages stay with Claude even when the
code is otherwise simple. For Ollama-suitable packages like `containers`, the code-generation
itself is fine; the review pass has to specifically hunt for (a) under-cited documentation
relative to the file's own convention, and (b) unverified internal shapes in test assertions.

**How to apply:** for any future `containers`/`learning`/`tools`-scaffolding delegation: (1)
before delegating, grep the exact shape of any internal record/history entry the new code or
tests will touch, and paste that literal shape into the prompt or just write assertions
against it directly rather than delegating test-writing wholesale; (2) after receiving a
draft, diff its JSDoc density against a sibling method in the same file and rewrite if it's
thinner.
