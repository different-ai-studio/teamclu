import { appFcRouteHost } from '../apps-public-host.js';
import { appFunctionName, appOssObjectName } from './app-deploy.js';
import { UNDEPLOY_STEPS, type AppDeploymentResourceSnapshot, type UndeploySteps, type UndeployStep } from '../app-lifecycle.js';
export class CleanupYield extends Error {
}
export class CleanupOutcomeUnknown extends Error {
    constructor() { super("provider outcome unknown; deployment remains fenced until operator reconciliation"); }
}
export type AppUndeployDeps = {
    callTimeoutMs?: number;
    deadline?: number;
    deleteHttpTrigger?: (name: string) => Promise<void>;
    deleteCustomDomain?: (name: string) => Promise<void>;
    deleteFunction?: (name: string) => Promise<void>;
    deleteArtifact?: (name: string) => Promise<void>;
    disableOAuthClient?: (id: string) => Promise<void>;
};
/** Only explicit absence is success. Do not quote provider messages containing credentials. */
function absent(e: any) { return ['FunctionNotFound', 'TriggerNotFound', 'CustomDomainNotFound', 'NoSuchKey'].includes(e?.code ?? e?.data?.code) || e?.statusCode === 404; }
export function cleanupError(e: any): string {
    return typeof e?.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(e.code) ? e.code : 'resource cleanup failed; retry or check provider access';
}
export async function cleanupAppDeployment(deps: AppUndeployDeps, snapshot: AppDeploymentResourceSnapshot, completed: UndeploySteps, persist: (steps: UndeploySteps, phase?: {
    step: UndeployStep;
    inFlight: boolean;
}) => Promise<void>): Promise<UndeploySteps> {
    const steps = { ...completed };
    const fn = snapshot.functionName || appFunctionName(snapshot.appId);
    const domain = snapshot.originDomain !== undefined ? snapshot.originDomain : appFcRouteHost(snapshot.slug, snapshot.appId);
    const targets: Record<UndeployStep, [
        string | null | undefined,
        ((s: string) => Promise<void>) | undefined
    ]> = {
        httpTrigger: [fn, deps.deleteHttpTrigger], originDomain: [domain, deps.deleteCustomDomain], function: [fn, deps.deleteFunction],
        artifact: [appOssObjectName(snapshot.appId), deps.deleteArtifact], oauthClient: [snapshot.oauthClientId, deps.disableOAuthClient]
    };
    for (const step of UNDEPLOY_STEPS) {
        if (steps[step]?.status === 'succeeded' || steps[step]?.status === 'skipped')
            continue;
        const [target, remove] = targets[step];
        if (!target) {
            steps[step] = { status: 'skipped' };
            await persist(steps);
            continue;
        }
        if (!remove) {
            steps[step] = { status: 'failed', error: 'cleanup adapter unavailable' };
            await persist(steps);
            continue;
        }
        if (deps.deadline !== undefined && Date.now() + (deps.callTimeoutMs ?? 20000) > deps.deadline)
            throw new CleanupYield();
        await persist(steps, { step, inFlight: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([remove(target), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CleanupOutcomeUnknown()), deps.callTimeoutMs ?? 20000); })]);
            steps[step] = { status: 'succeeded' };
        }
        catch (e: any) {
            if (e instanceof CleanupOutcomeUnknown || /timeout|timedout|etimedout|econnreset/i.test(String(e?.code ?? ''))) {
                steps[step] = { status: 'failed', error: 'Provider outcome unknown; operator reconciliation required.' };
                await persist(steps, { step, inFlight: true });
                throw new CleanupOutcomeUnknown();
            }
            steps[step] = absent(e) ? { status: 'succeeded' } : { status: 'failed', error: cleanupError(e) };
        }
        finally {
            clearTimeout(timer);
        }
        await persist(steps, { step, inFlight: false });
    }
    return steps;
}
