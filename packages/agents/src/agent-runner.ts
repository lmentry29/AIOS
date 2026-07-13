import type { AgentEntity as AgentEntityType, LifecycleState } from '@aios/core';
import { AgentEntity } from '@aios/core';
import type { TaskStore } from '@aios/work-hierarchy';

/**
 * Minimal Agent Execution Loop runner (ADR-0002): planning → reasoning
 * → executing → monitoring → completion, mapped onto the base
 * lifecycle_state/lifecycle_substate fields per COM §4.1's table.
 *
 * This is the vertical slice's final mandated step: run one Agent
 * through its full lifecycle against one real Task from
 * @aios/work-hierarchy's TaskStore, then stop — per the mandated
 * checkpoint. No orchestration, no multi-agent coordination, no System
 * Execution Loop; those belong to @aios/orchestration and are
 * deliberately out of scope here.
 */
export class AgentRunner {
  private readonly agents = new Map<string, AgentEntityType>();

  constructor(private readonly taskStore: TaskStore) {}

  createAgent(agent: AgentEntityType): AgentEntityType {
    const parsed = AgentEntity.parse(agent);
    this.agents.set(parsed.entity_id, parsed);
    return parsed;
  }

  getAgent(agentId: string): AgentEntityType | undefined {
    return this.agents.get(agentId);
  }

  private transitionAgent(
    agentId: string,
    newState: LifecycleState,
    substate: string | undefined,
    actor: string
  ): AgentEntityType {
    const current = this.agents.get(agentId);
    if (!current) {
      throw new Error(`No agent found with entity_id "${agentId}".`);
    }

    const updated = AgentEntity.parse({
      ...current,
      lifecycle_state: newState,
      lifecycle_substate: substate,
      lifecycle_history: [
        ...current.lifecycle_history,
        { state: newState, substate, entered_at: new Date().toISOString(), actor },
      ],
      version: current.version + 1,
      modified_at: new Date().toISOString(),
    });

    this.agents.set(agentId, updated);
    return updated;
  }

  /**
   * Runs agentId through its full Agent Execution Loop against taskId:
   * created → validated → active(planning) → active(reasoning) →
   * active(executing) → active(monitoring) → completed. During
   * active(executing), assigns the Agent to the Task via TaskStore and
   * transitions the Task to active/executing too — the cross-package
   * interaction the vertical slice mandate exists to exercise.
   */
  runFullLifecycle(
    agentId: string,
    taskId: string
  ): { agent: AgentEntityType; task: ReturnType<TaskStore['getTask']> } {
    const actor = agentId;

    this.transitionAgent(agentId, 'validated', undefined, actor);
    this.transitionAgent(agentId, 'active', 'planning', actor);
    this.transitionAgent(agentId, 'active', 'reasoning', actor);

    this.taskStore.updateTask(taskId, { assigned_agent: agentId });
    this.transitionAgent(agentId, 'active', 'executing', actor);
    this.taskStore.transitionTaskLifecycle(taskId, 'active', actor, 'executing');

    this.transitionAgent(agentId, 'active', 'monitoring', actor);
    const finalTask = this.taskStore.transitionTaskLifecycle(taskId, 'completed', actor);
    const finalAgent = this.transitionAgent(agentId, 'completed', undefined, actor);

    return { agent: finalAgent, task: finalTask };
  }
}
