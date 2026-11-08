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
function cloneAgent(agent: AgentEntityType): AgentEntityType {
  const cloneValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]),
      );
    }
    return value;
  };
  return cloneValue(agent) as AgentEntityType;
}

export class AgentRunner {
  private readonly agents = new Map<string, AgentEntityType>();

  constructor(private readonly taskStore: TaskStore) {}

  createAgent(agent: AgentEntityType): AgentEntityType {
    const parsed = AgentEntity.parse(agent);
    if (this.agents.has(parsed.entity_id)) {
      throw new Error(`Agent entity_id "${parsed.entity_id}" already exists and cannot be reused.`);
    }
    this.agents.set(parsed.entity_id, parsed);
    return cloneAgent(parsed);
  }

  getAgent(agentId: string): AgentEntityType | undefined {
    const agent = this.agents.get(agentId);
    return agent ? cloneAgent(agent) : undefined;
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
    return cloneAgent(updated);
  }

  /**
   * Runs the Agent through its complete execution loop against a Task.
   * Agent-specific substates remain on the Agent. The Task records only its
   * canonical lifecycle transitions because COM §4.2 defines no Task substate
   * vocabulary; duplicating the Agent's 'executing' substate onto Task would
   * make the persisted Task invalid and conflate two entity contracts.
   */
  runFullLifecycle(
    agentId: string,
    taskId: string
  ): { agent: AgentEntityType; task: ReturnType<TaskStore['getTask']> } {
    const actor = agentId;
    const existingAgent = this.agents.get(agentId);
    if (!existingAgent) {
      throw new Error(`No agent found with entity_id "${agentId}".`);
    }
    if (existingAgent.lifecycle_state !== 'created') {
      throw new Error(
        `Agent "${agentId}" must be in created state to start its execution loop; found "${existingAgent.lifecycle_state}".`,
      );
    }

    const existingTask = this.taskStore.getTask(taskId);
    if (!existingTask) {
      throw new Error(`No task found with entity_id "${taskId}".`);
    }
    if (existingTask.lifecycle_state !== 'created') {
      throw new Error(
        `Task "${taskId}" must be in created state to start agent execution; found "${existingTask.lifecycle_state}".`,
      );
    }

    this.transitionAgent(agentId, 'validated', undefined, actor);
    this.transitionAgent(agentId, 'active', 'planning', actor);
    this.transitionAgent(agentId, 'active', 'reasoning', actor);

    this.taskStore.updateTask(taskId, { assigned_agent: agentId });
    this.transitionAgent(agentId, 'active', 'executing', actor);
    this.taskStore.transitionTaskLifecycle(taskId, 'active', actor);

    this.transitionAgent(agentId, 'active', 'monitoring', actor);
    const finalTask = this.taskStore.transitionTaskLifecycle(taskId, 'completed', actor);
    const finalAgent = this.transitionAgent(agentId, 'completed', undefined, actor);

    return { agent: finalAgent, task: finalTask };
  }
}
