import { describe, expect, it } from 'vitest';
import { AgentEntity, TaskEntity } from '@aios/core';
import { ObjectStore } from '@aios/objects';
import { FOUNDER, makeAgent, makeTask } from './fixtures.js';

/**
 * Regression coverage for entity-specific lifecycle substates.
 * COM §3.2 makes substate an entity-type-specific specialization of one canonical
 * lifecycle state. COM §4.1 defines Agent substates; COM §4.2 defines none for Task.
 */
describe('Lifecycle substate conformance (COM §3.2, §4.1, §4.2)', () => {
  it.each(['planning', 'reasoning', 'executing', 'monitoring'])(
    'accepts Agent substate %s only under active',
    (substate) => {
      const agent = makeAgent({
        lifecycle_state: 'active',
        lifecycle_substate: substate,
        lifecycle_history: [{
          state: 'active',
          substate,
          entered_at: new Date().toISOString(),
          actor: FOUNDER,
        }],
      });
      expect(AgentEntity.parse(agent).lifecycle_substate).toBe(substate);
    },
  );

  it('rejects unknown Agent substates', () => {
    expect(() => AgentEntity.parse(makeAgent({
      lifecycle_state: 'active',
      lifecycle_substate: 'shipping',
    }))).toThrow();
  });

  it('rejects Agent substates outside active', () => {
    expect(() => AgentEntity.parse(makeAgent({
      lifecycle_state: 'created',
      lifecycle_substate: 'planning',
    }))).toThrow();
  });

  it('rejects history substates outside active', () => {
    expect(() => AgentEntity.parse(makeAgent({
      lifecycle_history: [{
        state: 'completed',
        substate: 'executing',
        entered_at: new Date().toISOString(),
        actor: FOUNDER,
      }],
    }))).toThrow();
  });

  it('rejects top-level Task substates', () => {
    expect(() => TaskEntity.parse(makeTask({
      lifecycle_state: 'active',
      lifecycle_substate: 'executing',
    }))).toThrow();
  });

  it('rejects Task history substates', () => {
    expect(() => TaskEntity.parse(makeTask({
      lifecycle_history: [{
        state: 'active',
        substate: 'executing',
        entered_at: new Date().toISOString(),
        actor: FOUNDER,
      }],
    }))).toThrow();
  });

  it('enforces entity-specific substates through ObjectStore transitions', () => {
    const taskStore = new ObjectStore(TaskEntity);
    const task = taskStore.create(makeTask());
    expect(() => taskStore.transitionLifecycle(task.entity_id, 'active', FOUNDER, 'executing')).toThrow();
    const unchangedTask = taskStore.get(task.entity_id);
    expect(unchangedTask?.lifecycle_state).toBe('created');
    expect(unchangedTask?.lifecycle_history).toHaveLength(0);
    expect(unchangedTask?.version).toBe(task.version);

    const agentStore = new ObjectStore(AgentEntity);
    const agent = agentStore.create(makeAgent());
    const active = agentStore.transitionLifecycle(agent.entity_id, 'active', FOUNDER, 'planning');
    expect(active.lifecycle_substate).toBe('planning');
    expect(active.lifecycle_history[0]?.substate).toBe('planning');
  });
});
