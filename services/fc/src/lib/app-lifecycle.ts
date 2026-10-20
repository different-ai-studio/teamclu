import { ApiError } from './http-utils.js';
export const UNDEPLOY_STEPS = ['httpTrigger', 'originDomain', 'function', 'artifact', 'oauthClient'] as const;
export type UndeployStep = typeof UNDEPLOY_STEPS[number];
export type UndeploySteps = Partial<Record<UndeployStep, {
    status: 'succeeded' | 'failed' | 'skipped';
    error?: string;
}>>;
export type AppDeploymentResourceSnapshot = {
    appId: string;
    slug: string | null;
    functionName: string | null;
    oauthClientId: string | null;
    originDomain?: string | null;
};
export type AppUndeployOperation = {
    id: string;
    appId: string;
    status: 'pending' | 'running' | 'failed' | 'succeeded';
    startedAt: string;
    updatedAt: string;
    steps: UndeploySteps;
    error: string | null;
};
export function operationView(row: any): AppUndeployOperation {
    return { id: row.id, appId: row.app_id, status: row.status, startedAt: row.started_at, updatedAt: row.updated_at, steps: row.steps ?? {}, error: row.error ?? null };
}
export function assertLifecycleAvailable(status: string | null | undefined) {
    if (status === 'uninstalling' || status === 'uninstall_failed')
        throw new ApiError(409, 'lifecycle_conflict', 'deployment cleanup must finish before deploying');
}
export async function lifecycleRpc(client: any, name: string, args: Record<string, unknown>) {
    const { data, error } = await client.rpc(name, args);
    if (error) {
        if (error.code === '55000' && error.message?.includes('provider_outcome_unknown'))
            throw new ApiError(409, 'provider_outcome_unknown', 'Provider outcome unknown; operator reconciliation is required before retry or redeploy.');
        if (error.code === '55000')
            throw new ApiError(409, 'lifecycle_conflict', 'another deployment lifecycle operation is active');
        if (error.code === 'P0002')
            throw new ApiError(404, 'not_found', 'app not found');
        throw error;
    }
    return data;
}
