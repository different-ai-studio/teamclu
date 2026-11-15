import { createHash } from "node:crypto";

const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const INTERNAL_PATH = /^\/internal\/api\/v1\/[A-Za-z0-9._~!$&'()+,;=:@/-]*$/;
const DENIED_HEADERS = [
  "X-TeamClu-Caller-App",
  "X-TeamClu-User-Id",
  "X-TeamClu-User-Email",
];

/** All fields must come from the approved server-side grant snapshot. */
export interface ApprovedRoute {
  targetAppId: string;
  gatewayHost: string;
  upstreamOrigin: string;
  method: string;
  path: string;
  callerAppIds: string[];
  keyId: string;
  privateKeyPath: string;
}

export interface KongRouteSpec {
  service: { name: string; url: string; tags: string[] };
  route: {
    name: string;
    service: { name: string };
    expression: string;
    priority: number;
    strip_path: false;
    preserve_host: false;
    protocols: ["http"];
    tags: string[];
  };
  plugins: {
    name: string;
    service: { name: string };
    config: Record<string, unknown>;
    tags: string[];
  }[];
}

function assertAppId(value: string): void {
  if (!APP_ID.test(value)) throw new Error("invalid App ID");
}

/** Compile one exact method/path permission boundary; never emits a fallback Route. */
export function compileKongRoute(input: ApprovedRoute): KongRouteSpec {
  assertAppId(input.targetAppId);
  if (!HOST.test(input.gatewayHost) || input.gatewayHost !== input.gatewayHost.toLowerCase()) {
    throw new Error("invalid gateway Host");
  }
  if (!METHODS.has(input.method)) throw new Error("unsupported HTTP method");
  if (!INTERNAL_PATH.test(input.path) || input.path.includes("//") || input.path.split("/").some(part => part === "." || part === "..")) {
    throw new Error("path must be a literal internal API path");
  }
  if (!input.callerAppIds.length || new Set(input.callerAppIds).size !== input.callerAppIds.length) {
    throw new Error("at least one distinct approved caller is required");
  }
  input.callerAppIds.forEach(assertAppId);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(input.keyId)) throw new Error("invalid key ID");
  if (!/^\/run\/secrets\/app-jwt\/[A-Za-z0-9._-]+\.pem$/.test(input.privateKeyPath)) {
    throw new Error("private key must be a mounted versioned PEM");
  }
  let upstream: URL;
  try {
    upstream = new URL(input.upstreamOrigin);
  } catch {
    throw new Error("invalid upstream origin");
  }
  if (!(["http:", "https:"].includes(upstream.protocol)) || !HOST.test(upstream.hostname) ||
      upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("upstream must be a trusted HTTP origin without path or credentials");
  }

  const identity = `${input.targetAppId}\0${input.gatewayHost}\0${input.method}\0${input.path}`;
  const name = `tc-app-api-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
  const service = { name, url: upstream.origin, tags: ["teamclu-app-api"] };
  const serviceRef = { name };
  const plugins = [
    { name: "basic-auth", service: serviceRef, config: { hide_credentials: true }, tags: ["teamclu-app-api"] },
    { name: "acl", service: serviceRef, config: { allow: input.callerAppIds.map(id => `app-${id}`).sort(), hide_groups_header: true }, tags: ["teamclu-app-api"] },
    { name: "kong-upstream-jwt", service: serviceRef, config: {
      issuer: "teamclu-app-internal-kong",
      target_app_id: input.targetAppId,
      key_id: input.keyId,
      private_key_location: input.privateKeyPath,
      header: "X-TeamClu-Origin-Token",
      include_credential_type: false,
    }, tags: ["teamclu-app-api"] },
    { name: "request-transformer", service: serviceRef, config: { remove: { headers: DENIED_HEADERS } }, tags: ["teamclu-app-api"] },
  ];
  return {
    service,
    route: {
      name,
      service: serviceRef,
      expression: `http.host == ${JSON.stringify(input.gatewayHost)} && http.method == ${JSON.stringify(input.method)} && http.path == ${JSON.stringify(input.path)}`,
      priority: 100,
      strip_path: false,
      preserve_host: false,
      protocols: ["http"],
      tags: ["teamclu-app-api"],
    },
    plugins,
  };
}
