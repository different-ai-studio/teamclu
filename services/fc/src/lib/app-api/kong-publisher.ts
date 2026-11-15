import { compileKongRoute, type ApprovedRoute, type KongRouteSpec } from "./kong-route-spec.js";

const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApprovedCaller {
  appId: string;
  username: string;
  password: string;
}

/** Trusted control-plane output, never a client body or a hand-authored route list. */
export interface ApprovedKongSnapshot {
  generation: number;
  routes: ApprovedRoute[];
  callers: ApprovedCaller[];
}

export interface KongPublicationAdmin {
  listManaged(kind: "routes" | "services" | "consumers"): Promise<string[]>;
  deleteRoute(name: string): Promise<void>;
  putService(spec: KongRouteSpec["service"]): Promise<void>;
  replaceServicePlugins(name: string, plugins: KongRouteSpec["plugins"]): Promise<void>;
  putConsumer(consumer: ApprovedCaller): Promise<void>;
  replaceCallerCredential(caller: ApprovedCaller): Promise<void>;
  replaceCallerGroups(appId: string, groups: string[]): Promise<void>;
  putRoute(spec: KongRouteSpec["route"]): Promise<void>;
  readRoute(spec: KongRouteSpec["route"]): Promise<boolean>;
  deleteService(name: string): Promise<void>;
  deleteConsumer(name: string): Promise<void>;
}

/** The implementation must hold a cross-process lock and reject superseded generations. */
export interface PublicationFence {
  withExclusivePublication<T>(generation: number, run: (assertCurrent: () => Promise<void>) => Promise<T>): Promise<T>;
}

function prepare(snapshot: ApprovedKongSnapshot): { specs: KongRouteSpec[]; callers: ApprovedCaller[] } {
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
      !Array.isArray(snapshot.routes) || !Array.isArray(snapshot.callers)) {
    throw new Error("invalid approved snapshot");
  }
  const callers = new Map<string, ApprovedCaller>();
  for (const caller of snapshot.callers) {
    if (!APP_ID.test(caller.appId) || callers.has(caller.appId) ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(caller.username) || !caller.password) {
      throw new Error("invalid approved caller");
    }
    callers.set(caller.appId, caller);
  }
  const specs = snapshot.routes.map(compileKongRoute);
  const names = new Set<string>();
  for (const [index, spec] of specs.entries()) {
    if (names.has(spec.route.name)) throw new Error("duplicate approved route");
    names.add(spec.route.name);
    for (const id of snapshot.routes[index].callerAppIds) {
      if (!callers.has(id)) throw new Error("approved route references missing caller");
    }
  }
  return {
    specs: specs.sort((a, b) => a.route.name.localeCompare(b.route.name)),
    callers: [...callers.values()].sort((a, b) => a.appId.localeCompare(b.appId)),
  };
}

/** Remove old entry routes first. A failed publish leaves traffic denied until retry. */
export async function publishApprovedKongSnapshot(
  snapshot: ApprovedKongSnapshot,
  admin: KongPublicationAdmin,
  fence: PublicationFence,
): Promise<{ generation: number; routeNames: string[] }> {
  const { specs, callers } = prepare(snapshot);
  return fence.withExclusivePublication(snapshot.generation, async assertCurrent => {
    await assertCurrent();
    const existingRoutes = await admin.listManaged("routes");
    for (const name of existingRoutes.sort()) {
      await assertCurrent();
      await admin.deleteRoute(name);
    }
    const desiredServices = new Set(specs.map(spec => spec.service.name));
    for (const name of (await admin.listManaged("services")).sort()) {
      if (desiredServices.has(name)) continue;
      await assertCurrent();
      await admin.deleteService(name);
    }
    const desiredConsumers = new Set(callers.map(caller => `tc-app-api-caller-${caller.appId}`));
    for (const name of (await admin.listManaged("consumers")).sort()) {
      if (desiredConsumers.has(name)) continue;
      await assertCurrent();
      await admin.deleteConsumer(name);
    }
    for (const spec of specs) {
      await assertCurrent();
      await admin.putService(spec.service);
      await assertCurrent();
      await admin.replaceServicePlugins(spec.service.name, spec.plugins);
    }
    for (const caller of callers) {
      await assertCurrent();
      await admin.putConsumer(caller);
      await assertCurrent();
      await admin.replaceCallerCredential(caller);
      await assertCurrent();
      await admin.replaceCallerGroups(caller.appId, [`app-${caller.appId}`]);
    }
    for (const spec of specs) {
      await assertCurrent();
      await admin.putRoute(spec.route);
      if (!await admin.readRoute(spec.route)) throw new Error("Kong route readback failed");
    }
    return { generation: snapshot.generation, routeNames: specs.map(spec => spec.route.name) };
  });
}
