import { describe, expect, it } from "vitest";
import {
  AgentEntity,
  CanonicalObjectEntity,
  PluginEntity,
  TaskEntity,
  WorkflowEntity,
} from "@aios/core";
import { ObjectStore } from "@aios/objects";
import { FOUNDER, makeAgent, makeCanonicalObject, makeTask } from "./fixtures.js";

/**
 * Regression coverage for entity-specific lifecycle substates.
 * COM §3.2 makes substate an entity-type-specific specialization of one canonical
 * lifecycle state. COM §4.1 defines Agent substates; COM §4.2 defines none for Task.
 */
describe("Lifecycle substate conformance (COM §3.2, §4.1, §4.2)", () => {
  it("enforces the Canonical Object contract on the public base schema", () => {
    const valid = makeCanonicalObject({
      lifecycle_state: "active",
      lifecycle_substate: "persisting",
    });
    expect(CanonicalObjectEntity.parse(valid).lifecycle_substate).toBe("persisting");
    expect(() =>
      CanonicalObjectEntity.parse({
        ...valid,
        lifecycle_substate: "executing",
      }),
    ).toThrow();
  });

  it("rejects invalid Canonical Object history substates", () => {
    const object = makeCanonicalObject({
      lifecycle_state: "active",
      lifecycle_history: [
        {
          state: "active",
          substate: "executing",
          entered_at: new Date().toISOString(),
          actor: FOUNDER,
        },
      ],
    });
    expect(() => CanonicalObjectEntity.parse(object)).toThrow();
  });

  it("rejects lifecycle substates on Workflow and Plugin entities", () => {
    const workflow = makeCanonicalObject({
      entity_type: "workflow",
      steps: [],
      governing_loop: "system_execution_loop",
      lifecycle_state: "active",
      lifecycle_substate: "executing",
    });
    expect(() => WorkflowEntity.parse(workflow)).toThrow();

    const plugin = makeCanonicalObject({
      entity_type: "plugin",
      governing_layer: "tool_abstraction_layer",
      install_status: "available",
      lifecycle_history: [
        {
          state: "active",
          substate: "installing",
          entered_at: new Date().toISOString(),
          actor: FOUNDER,
        },
      ],
    });
    expect(() => PluginEntity.parse(plugin)).toThrow();
  });

  it.each(["planning", "reasoning", "executing", "monitoring"])(
    "accepts Agent substate %s only under active",
    (substate) => {
      const agent = makeAgent({
        lifecycle_state: "active",
        lifecycle_substate: substate,
        lifecycle_history: [
          {
            state: "active",
            substate,
            entered_at: new Date().toISOString(),
            actor: FOUNDER,
          },
        ],
      });
      expect(AgentEntity.parse(agent).lifecycle_substate).toBe(substate);
    },
  );

  it("rejects unknown Agent substates", () => {
    expect(() =>
      AgentEntity.parse(
        makeAgent({
          lifecycle_state: "active",
          lifecycle_substate: "shipping",
        }),
      ),
    ).toThrow();
  });

  it("rejects Agent substates outside active", () => {
    expect(() =>
      AgentEntity.parse(
        makeAgent({
          lifecycle_state: "created",
          lifecycle_substate: "planning",
        }),
      ),
    ).toThrow();
  });

  it("rejects history substates outside active", () => {
    expect(() =>
      AgentEntity.parse(
        makeAgent({
          lifecycle_history: [
            {
              state: "completed",
              substate: "executing",
              entered_at: new Date().toISOString(),
              actor: FOUNDER,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects top-level Task substates", () => {
    expect(() =>
      TaskEntity.parse(
        makeTask({
          lifecycle_state: "active",
          lifecycle_substate: "executing",
        }),
      ),
    ).toThrow();
  });

  it("rejects Task history substates", () => {
    expect(() =>
      TaskEntity.parse(
        makeTask({
          lifecycle_history: [
            {
              state: "active",
              substate: "executing",
              entered_at: new Date().toISOString(),
              actor: FOUNDER,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("enforces entity-specific substates through ObjectStore transitions", () => {
    const taskStore = new ObjectStore(TaskEntity);
    const task = taskStore.create(makeTask());
    expect(() =>
      taskStore.transitionLifecycle(task.entity_id, "active", FOUNDER, "executing"),
    ).toThrow();
    const unchangedTask = taskStore.get(task.entity_id);
    expect(unchangedTask?.lifecycle_state).toBe("created");
    expect(unchangedTask?.lifecycle_history).toHaveLength(0);
    expect(unchangedTask?.version).toBe(task.version);

    const agentStore = new ObjectStore(AgentEntity);
    const agent = agentStore.create(makeAgent());
    agentStore.transitionLifecycle(agent.entity_id, "validated", FOUNDER);
    const active = agentStore.transitionLifecycle(agent.entity_id, "active", FOUNDER, "planning");
    expect(active.lifecycle_substate).toBe("planning");
    expect(active.lifecycle_history[1]?.substate).toBe("planning");
  });
});
