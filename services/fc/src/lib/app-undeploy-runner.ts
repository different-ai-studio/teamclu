import { CleanupYield, CleanupOutcomeUnknown, cleanupAppDeployment, type AppUndeployDeps } from './provisioning/app-undeploy.js';
import { lifecycleRpc, type UndeploySteps } from './app-lifecycle.js';
export interface UndeployStore {
    list(): Promise<any[]>;
    claim(id: string): Promise<any | null>;
    save(id: string, owner: string, steps: UndeploySteps, phase?: {
        step: string;
        inFlight: boolean;
    }): Promise<void>;
    failUnknown?(id: string, owner: string): Promise<void>;
    finish(id: string, owner: string, steps: UndeploySteps): Promise<void>;
}
export function makeUndeployStore(db: any): UndeployStore {
    return {
        async list() { await lifecycleRpc(db, 'report_expired_app_undeploy_calls', {}); const { data, error } = await db.from('app_lifecycle_operations').select('id').eq('kind', 'undeploy').in('status', ['pending', 'running']).eq('in_flight', false).order('started_at').limit(4); if (error)
            throw error; return data ?? []; },
        claim: id => lifecycleRpc(db, 'claim_app_undeploy', { p_operation_id: id }),
        async save(id, owner, steps, phase) { const { data, error } = await db.from('app_lifecycle_operations').update({ steps, in_flight: phase?.inFlight ?? false, lease_until: new Date(Date.now() + 120000).toISOString(), updated_at: new Date().toISOString() }).eq('id', id).eq('lease_owner', owner).eq('status', 'running').select('id').maybeSingle(); if (error)
            throw error; if (!data)
            throw new Error('lifecycle lease lost'); },
        async failUnknown(id, owner) { await lifecycleRpc(db, 'fail_app_undeploy_unknown', { p_operation_id: id, p_owner: owner }); },
        async finish(id, owner, steps) { await lifecycleRpc(db, 'finish_app_undeploy', { p_operation_id: id, p_owner: owner, p_steps: steps }); },
    };
}
export async function runAppUndeployTick({ store, deps, maxTickMs = 45000 }: {
    store: UndeployStore;
    deps: AppUndeployDeps;
    maxTickMs?: number;
}): Promise<{
    processed: number;
}> {
    let processed = 0;
    const deadline = Date.now() + maxTickMs;
    for (const candidate of await store.list()) {
        if (Date.now() >= deadline)
            break;
        const op = await store.claim(candidate.id);
        if (!op)
            continue;
        try {
            const steps = await cleanupAppDeployment({ ...deps, deadline }, op.snapshot, op.steps ?? {}, (s, p) => store.save(op.id, op.lease_owner, s, p));
            await store.finish(op.id, op.lease_owner, steps);
            processed++;
        }
        catch (e) {
            if (e instanceof CleanupYield)
                break;
            if (!(e instanceof CleanupOutcomeUnknown))
                throw e;
            await store.failUnknown?.(op.id, op.lease_owner);
        }
    }
    return { processed };
}
