import { describe, expect, it } from 'vitest';
import { LearningService, MemoryApprovalError } from '../src/index.js';
import type { MemoryApprovalAuthorityPort } from '../src/index.js';

const FOUNDER = 'human:founder';
const AGENT = '11111111-1111-4111-8111-111111111111';
const allowAll: MemoryApprovalAuthorityPort = { authorize: async () => true };
const denyAll: MemoryApprovalAuthorityPort = { authorize: async () => false };

function service(
  options: { now?: () => Date; ttl?: number; authority?: MemoryApprovalAuthorityPort } = {},
): LearningService {
  return new LearningService(undefined, undefined, undefined, options.authority ?? allowAll, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttl === undefined ? {} : { approval_ttl_ms: options.ttl }),
  });
}

async function approve(
  svc: LearningService,
  id: string,
  stage: 'published' | 'institutional_standard',
): Promise<string> {
  const approval = await svc.requestPermanentPromotion(id, stage, FOUNDER);
  await svc.decidePermanentPromotion(approval.approval_id, 'approved', FOUNDER);
  return approval.approval_id;
}

describe('permanent Memory approval binding', () => {
  it('refuses every permanent promotion without an approval and persists no stage change', async () => {
    const svc = service();
    const id = await svc.recordObservation('unapproved finding', { value: 1 });

    await expect(svc.promote(id, 'published')).rejects.toThrow(MemoryApprovalError);
    await expect(svc.promote(id, 'institutional_standard')).rejects.toThrow(MemoryApprovalError);

    expect(svc.getKnowledge(id)?.stage).toBe('observation');
    expect(svc.listByStage('published')).toEqual([]);
    expect(svc.listByStage('institutional_standard')).toEqual([]);
  });

  it('refuses an approval identifier that was never recorded', async () => {
    const svc = service();
    const id = await svc.recordObservation('finding', {});
    await expect(
      svc.promote(id, 'published', '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');
  });

  it('performs an approved promotion and consumes the approval exactly once', async () => {
    const svc = service();
    const id = await svc.recordObservation('reviewed finding', { value: 1 });
    const approvalId = await approve(svc, id, 'published');

    await svc.promote(id, 'published', approvalId);

    expect(svc.getKnowledge(id)?.stage).toBe('published');
    expect(svc.getMemoryApproval(approvalId)).toMatchObject({
      status: 'consumed',
      memory_id: id,
      target_stage: 'published',
      decided_by: FOUNDER,
    });
    expect(svc.getMemoryApproval(approvalId)?.consumed_at).toBeDefined();

    // A consumed approval is not a standing grant for another permanent promotion.
    await expect(svc.promote(id, 'institutional_standard', approvalId))
      .rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe('published');
  });

  it('records a rejection and leaves the record at its draft stage', async () => {
    const svc = service();
    const id = await svc.recordObservation('rejected finding', {});
    const approval = await svc.requestPermanentPromotion(id, 'published', FOUNDER);
    await svc.decidePermanentPromotion(approval.approval_id, 'rejected', FOUNDER, 'insufficient evidence');

    await expect(svc.promote(id, 'published', approval.approval_id))
      .rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');
    expect(svc.getMemoryApproval(approval.approval_id)).toMatchObject({
      status: 'rejected',
      decided_by: FOUNDER,
      reason: 'insufficient evidence',
    });
  });

  it('refuses to decide or write with an expired approval', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const svc = service({ now: () => now, ttl: 1_000 });
    const id = await svc.recordObservation('expiring finding', {});
    const approval = await svc.requestPermanentPromotion(id, 'published', FOUNDER);

    now = new Date('2026-01-01T00:00:02.000Z');
    await expect(svc.decidePermanentPromotion(approval.approval_id, 'approved', FOUNDER))
      .rejects.toThrow(/expired/);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');
    expect(svc.getMemoryApproval(approval.approval_id)?.status).toBe('pending');

    // An approval that was valid when decided still expires before the write.
    const fresh = await svc.requestPermanentPromotion(id, 'published', FOUNDER);
    // The clock is already past the fresh approval's expiry because it inherits the same now.
    await expect(svc.promote(id, 'published', fresh.approval_id))
      .rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');
  });

  it('refuses an approved approval after its expiry at write time', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const svc = service({ now: () => now, ttl: 60_000 });
    const id = await svc.recordObservation('expiring approved finding', {});
    const approval = await svc.requestPermanentPromotion(id, 'published', FOUNDER);
    await svc.decidePermanentPromotion(approval.approval_id, 'approved', FOUNDER);

    now = new Date('2026-01-01T00:01:01.000Z');
    await expect(svc.promote(id, 'published', approval.approval_id))
      .rejects.toThrow(/expired/);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');
    expect(svc.getMemoryApproval(approval.approval_id)?.status).toBe('approved');
  });

  it('requires an allowing authorization boundary for the human decision', async () => {
    const svc = service({ authority: denyAll });
    const id = await svc.recordObservation('policy-denied finding', {});
    const approval = await svc.requestPermanentPromotion(id, 'published', FOUNDER);

    await expect(svc.decidePermanentPromotion(approval.approval_id, 'approved', FOUNDER))
      .rejects.toThrow(/denied/);
    expect(svc.getMemoryApproval(approval.approval_id)?.status).toBe('pending');
    await expect(svc.promote(id, 'published', approval.approval_id))
      .rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');
  });

  it('refuses an agent principal even when the boundary would allow it', async () => {
    const svc = service();
    const id = await svc.recordObservation('agent-requested finding', {});
    const approval = await svc.requestPermanentPromotion(id, 'published', AGENT);

    await expect(svc.decidePermanentPromotion(approval.approval_id, 'approved', AGENT))
      .rejects.toThrow(/human principal/);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');
  });

  it('binds the approval to the exact record, transition, and content', async () => {
    const svc = service();
    const id = await svc.recordObservation('bound finding', { value: 1 });
    const approvalId = await approve(svc, id, 'published');

    // Target-stage mismatch: the approval is only for published.
    await expect(svc.promote(id, 'institutional_standard', approvalId))
      .rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');

    // Source-stage mismatch: advancing to validated first invalidates the old approval.
    await svc.promote(id, 'validated');
    await expect(svc.promote(id, 'published', approvalId))
      .rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe('validated');
  });

  it('leaves draft promotions and ephemeral observations unchanged', async () => {
    const svc = service();
    const id = await svc.recordObservation('draft finding', { value: 1 });

    await svc.promote(id, 'candidate');
    await svc.promote(id, 'validated');

    expect(svc.getKnowledge(id)?.stage).toBe('validated');
    expect(svc.getMemoryApproval('not-used')).toBeUndefined();
  });

  it('refuses a second decision on the same approval', async () => {
    const svc = service();
    const id = await svc.recordObservation('double-decided finding', {});
    const approval = await svc.requestPermanentPromotion(id, 'published', FOUNDER);
    await svc.decidePermanentPromotion(approval.approval_id, 'approved', FOUNDER);

    await expect(svc.decidePermanentPromotion(approval.approval_id, 'rejected', FOUNDER))
      .rejects.toThrow(/already approved/);
    expect(svc.getMemoryApproval(approval.approval_id)?.status).toBe('approved');
  });

  it('denies by default when no authorization boundary is configured', async () => {
    const svc = new LearningService();
    const id = await svc.recordObservation('default-deny finding', {});
    const approval = await svc.requestPermanentPromotion(id, 'published', FOUNDER);

    await expect(svc.decidePermanentPromotion(approval.approval_id, 'approved', FOUNDER))
      .rejects.toThrow(/denied/);
    await expect(svc.promote(id, 'published', approval.approval_id))
      .rejects.toThrow(MemoryApprovalError);
    expect(svc.getKnowledge(id)?.stage).toBe('observation');
  });

  it('refuses to request approval for a draft-only stage', async () => {
    const svc = service();
    const id = await svc.recordObservation('draft finding', {});
    await expect(
      svc.requestPermanentPromotion(id, 'candidate' as never, FOUNDER),
    ).rejects.toThrow(MemoryApprovalError);
  });
});
