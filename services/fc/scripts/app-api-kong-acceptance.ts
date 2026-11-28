import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoopbackKongAdmin } from "../src/lib/app-api/kong-admin.js";
import { publishApprovedKongSnapshot, type ApprovedKongSnapshot } from "../src/lib/app-api/kong-publisher.js";
import { compileKongRoute } from "../src/lib/app-api/kong-route-spec.js";

const A = "4fddbe81-a0e4-41c2-b74a-feccd0d9f959";
const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AcceptanceCredentials {
  bId: string;
  bPassword: string;
  cId: string;
  cPassword: string;
}

/** Fixed, temporary Hangzhou FC fixture. Never use it as a production grant source. */
export function acceptanceSnapshot(action: "publish" | "revoke", credentials: AcceptanceCredentials): ApprovedKongSnapshot {
  if (!APP_ID.test(credentials.bId) || !APP_ID.test(credentials.cId) ||
      credentials.bId === credentials.cId || credentials.bId === A || credentials.cId === A) {
    throw new Error("two distinct temporary caller App IDs required");
  }
  const route = {
    targetAppId: A,
    gatewayHost: `app-${A}.apps-internal.teamclu.cn`,
    upstreamOrigin: "https://teamclug-target-mwsjjxhwgp.cn-hangzhou-vpc.fcapp.run",
    method: "GET",
    path: "/internal/api/v1/orders",
    callerAppIds: [credentials.bId],
    keyId: "fc-acceptance-1115",
    privateKeyPath: "/run/secrets/app-jwt/fc-acceptance-1115.pem",
  };
  if (action === "revoke") return { generation: 2, routes: [], callers: [] };
  if (!credentials.bPassword || !credentials.cPassword) throw new Error("two temporary caller passwords required");
  return {
    generation: 1,
    routes: [route],
    callers: [
      { appId: credentials.bId, username: `app-${credentials.bId}`, password: credentials.bPassword },
      { appId: credentials.cId, username: `app-${credentials.cId}`, password: credentials.cPassword },
    ],
  };
}

export function assertAcceptanceInventory(
  inventory: { routes: string[]; services: string[]; consumers: string[] },
  _snapshot: ApprovedKongSnapshot,
  credentials: AcceptanceCredentials,
): void {
  const route = compileKongRoute({
    targetAppId: A,
    gatewayHost: `app-${A}.apps-internal.teamclu.cn`,
    upstreamOrigin: "https://teamclug-target-mwsjjxhwgp.cn-hangzhou-vpc.fcapp.run",
    method: "GET",
    path: "/internal/api/v1/orders",
    callerAppIds: [credentials.bId],
    keyId: "fc-acceptance-1115",
    privateKeyPath: "/run/secrets/app-jwt/fc-acceptance-1115.pem",
  });
  const expected = {
    routes: new Set([route.route.name]),
    services: new Set([route.service.name]),
    consumers: new Set([`tc-app-api-caller-${credentials.bId}`, `tc-app-api-caller-${credentials.cId}`]),
  };
  for (const kind of ["routes", "services", "consumers"] as const) {
    if (inventory[kind].some(name => !expected[kind].has(name))) {
      throw new Error("unrelated managed Kong entity exists; acceptance publisher refuses to run");
    }
  }
}

async function main(): Promise<void> {
  if (process.env.APP_API_ACCEPTANCE_ONLY !== "yes-temporary-fc-a-b-c") {
    throw new Error("temporary FC acceptance confirmation required");
  }
  const action = process.argv[2];
  if (action !== "publish" && action !== "revoke") throw new Error("usage: acceptance publish|revoke");
  const credentials = {
    bId: process.env.APP_API_ACCEPTANCE_B_ID ?? "",
    bPassword: process.env.APP_API_ACCEPTANCE_B_PASSWORD ?? "",
    cId: process.env.APP_API_ACCEPTANCE_C_ID ?? "",
    cPassword: process.env.APP_API_ACCEPTANCE_C_PASSWORD ?? "",
  };
  const snapshot = acceptanceSnapshot(action, credentials);
  const admin = createLoopbackKongAdmin();
  const inventory = {
    routes: await admin.listManaged("routes"),
    services: await admin.listManaged("services"),
    consumers: await admin.listManaged("consumers"),
  };
  assertAcceptanceInventory(inventory, snapshot, credentials);
  const result = await publishApprovedKongSnapshot(snapshot, admin, {
    // This fixture is allowed only while the production control-plane publisher is absent.
    // The durable exclusive generation fence is a required integration dependency.
    withExclusivePublication: async (_generation, run) => run(async () => {}),
  });
  process.stdout.write(`${action} complete: generation ${result.generation}, routes ${result.routeNames.length}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "acceptance failed"}\n`);
    process.exitCode = 1;
  });
}
