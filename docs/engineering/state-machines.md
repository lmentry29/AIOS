# AIOS State Machines (Tier 4) — Lifecycle Diagrams

**Status: Proposed.** Renders `AIOS-Canonical-Object-Model.md` §4's lifecycle-substate tables as formal Mermaid state diagrams. Every transition below is sourced from a table already in the COM or an ADR — no new states are introduced here.

**AI task allocation: Ollama Suitable.** Mechanical rendering of already-fixed tables into diagram syntax; low architectural risk.

---

## 1. Canonical base lifecycle (all five entity types, ADR-0003)

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Validated
    Validated --> Active
    Active --> Monitored
    Monitored --> Active
    Active --> Suspended
    Monitored --> Suspended
    Suspended --> Active
    Active --> Completed
    Monitored --> Completed
    Completed --> Archived
    Archived --> [*]

    note right of Suspended
        Optional stage per ADR-0003 —
        entities MAY skip Suspended entirely
    end note
```

---

## 2. Agent lifecycle (Agent Execution Loop, ADR-0002, substates per COM §4.1)

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Validated: capability/authorization check
    Validated --> Active
    state Active {
        [*] --> Planning
        Planning --> Reasoning
        Reasoning --> Executing
        Executing --> Monitoring
        Monitoring --> Planning: replan
        Monitoring --> [*]: step complete
    }
    Active --> Suspended: paused mid-loop
    Suspended --> Active: resumed
    Active --> Completed: loop terminated normally
    Completed --> Archived
    Archived --> [*]
```

---

## 3. Task lifecycle (base lifecycle + Action sub-execution, COM §4.2)

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Validated
    Validated --> Active
    state Active {
        [*] --> ActionsExecuting
        state ActionsExecuting {
            [*] --> Pending
            Pending --> Executing
            Executing --> Completed
            Executing --> Failed
        }
    }
    Active --> Monitored
    Monitored --> Active
    Active --> Suspended
    Active --> Completed: all Actions completed
    Completed --> Archived
    Archived --> [*]

    note right of ActionsExecuting
        Actions are sub-objects, not
        independently lifecycle-tracked
        entities (COM §2a) — this nested
        state is Task-internal only.
    end note
```

---

## 4. Workflow lifecycle (System Execution Loop, ADR-0002, steps = ordered Tasks)

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Validated
    Validated --> Active
    state Active {
        [*] --> StepDispatch
        StepDispatch --> AwaitingStep: dispatch next Task in steps[]
        AwaitingStep --> StepDispatch: Task completed, more steps remain
        AwaitingStep --> [*]: Task completed, no steps remain
    }
    Active --> Monitored
    Active --> Suspended
    Active --> Completed: all steps completed
    Completed --> Archived
    Archived --> [*]
```

---

## 5. Canonical Object lifecycle (Object Lifecycle Loop, ADR-0002, substates per COM §4.5)

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Validated
    Validated --> Active
    state Active {
        [*] --> Mutating
        Mutating --> Persisting
        Persisting --> Synchronizing
        Synchronizing --> Mutating: further mutation
        Synchronizing --> [*]: stable
    }
    Active --> Monitored
    Active --> Suspended: e.g. conflict resolution lock
    Suspended --> Active
    Active --> Completed: finalized, no further mutation expected
    Completed --> Archived
    Archived --> [*]
```

---

## 6. Memory Object lifecycle (Canonical Object specialization, immutability rule per COM §5.1)

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Validated
    Validated --> Active
    Active --> Monitored
    Active --> Completed: published
    Completed --> Archived
    Archived --> [*]

    Completed --> NewVersionCreated: mutation attempted post-completion
    NewVersionCreated --> Created: new entity_id, relationship: supersedes -> prior version

    note right of Completed
        Immutable after this point (Spec Part VIII Ch.5).
        No transition back to Active on the SAME entity_id.
        "Evolution" always produces a new entity_id.
    end note
```

---

## 7. Plugin lifecycle (install status is orthogonal to base lifecycle, COM §4.4)

```mermaid
stateDiagram-v2
    state "Base Lifecycle" as base {
        [*] --> Created
        Created --> Validated
        Validated --> Active
        Active --> Completed
        Completed --> Archived
        Archived --> [*]
    }
    state "Install Status (orthogonal)" as install {
        [*] --> Available
        Available --> Installed
        Installed --> Enabled
        Enabled --> Disabled
        Disabled --> Enabled
        Enabled --> Removed
        Disabled --> Removed
        Removed --> [*]
    }

    note right of install
        A Plugin can be lifecycle_state: active
        AND install_status: disabled simultaneously.
        Lowest-confidence model in this whole
        artifact set — see COM §4.4.
    end note
```

---

## 8. Three-loop relationship (ADR-0002, system view)

```mermaid
sequenceDiagram
    participant SEL as System Execution Loop
    participant AEL as Agent Execution Loop
    participant OLL as Object Lifecycle Loop

    SEL->>AEL: dispatch Task to Agent
    AEL->>AEL: planning -> reasoning -> executing -> monitoring
    AEL->>OLL: mutate Canonical Object(s)
    OLL->>OLL: validate -> mutate -> persist -> synchronize
    OLL-->>AEL: mutation confirmed
    AEL-->>SEL: Task complete
    SEL->>SEL: coordinate next dispatch
```
