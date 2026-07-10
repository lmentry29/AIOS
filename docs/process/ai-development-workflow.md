# AI Development Workflow — Task Allocation Guidance

**Status:** Working guidance, not an ADR (process decision, not architecture). Supersedes the "maximize local-first" framing from the 2026-07-09 founder decisions with a risk-based allocation, per founder acceptance the same day.

## Principle
Allocate by **blast radius**, not by "could a local model technically do this."

## Claude (high-blast-radius work)
- Canonical Object Model design and changes
- Execution engine (System / Agent / Object Lifecycle loops — ADR-0002)
- Lifecycle state machine implementation (ADR-0003)
- Memory architecture / Memory Engine internals
- AI orchestration logic
- Core runtime
- Any change touching more than one of the above at once
- Code review of local-model output before it lands in any of the above

## Ollama / local models (lower-risk work)
- Boilerplate and scaffolding
- Tests (once the thing under test is Claude-reviewed)
- CLI tooling
- Plugin/integration glue that doesn't touch core runtime semantics
- Utilities
- Iterative/exploratory development where a wrong turn is cheap to discard

## Rationale
Small local models (realistically quantized 7B–14B class, given 16GB unified memory) are meaningfully weaker than Claude-class models on tasks where subtle design mistakes compound — state machine edge cases, concurrency, schema drift. Those are concentrated in the "high-blast-radius" list above. Confidence on this split is Medium-Low on the exact model-size cutoff (not benchmarked against your specific Ollama setup) — worth spot-checking one of the harder modules against your actual local models before fully trusting the boundary.

## Open
This is guidance, not a hard gate. If a specific local model proves capable on a high-blast-radius task after review, that's evidence to revise this doc, not a reason to silently deviate from it.
