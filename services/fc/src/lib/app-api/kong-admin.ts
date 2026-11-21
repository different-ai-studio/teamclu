import type { KongPublicationAdmin } from "./kong-publisher.js";

const ORIGIN = "http://127.0.0.1:8001";
const TAG = "teamclu-app-api";
const segment = (value: string) => encodeURIComponent(value);
const consumerName = (appId: string) => `tc-app-api-caller-${appId}`;

interface Page<T> { data: T[]; next?: string | null }

/** Only a process sharing the Kong Pod network namespace can use this adapter. */
export function createLoopbackKongAdmin(fetcher: typeof fetch = fetch): KongPublicationAdmin {
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !url.pathname.startsWith("/")) throw new Error("invalid Kong Admin path");
    let response: Response;
    try {
      response = await fetcher(url.toString(), { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error("Kong Admin transport unavailable");
    }
    if (!response.ok) throw new Error(`Kong Admin rejected ${init.method ?? "GET"} ${url.pathname} (${response.status})`);
    return response;
  }

  async function json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const body = await (await request(path, init)).json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid Kong Admin response");
    return body as Record<string, unknown>;
  }

  async function pages<T extends { id?: string; name?: string }>(path: string): Promise<T[]> {
    const rows: T[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const url = new URL(path, ORIGIN);
      if (url.origin !== ORIGIN || seen.has(url.toString())) throw new Error("invalid Kong pagination URL");
      seen.add(url.toString());
      const body = await json(url.toString()) as unknown as Page<T>;
      if (!Array.isArray(body.data)) throw new Error("invalid Kong Admin page");
      rows.push(...body.data);
      if (!body.next) return rows;
      const next = new URL(body.next, ORIGIN);
      if (next.origin !== ORIGIN || next.pathname !== url.pathname ||
          next.searchParams.get("tags") !== url.searchParams.get("tags")) {
        throw new Error("invalid Kong pagination URL");
      }
      path = next.toString();
    }
    throw new Error("Kong pagination limit exceeded");
  }

  const write = async (method: string, path: string, body?: unknown): Promise<void> => {
    await request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  };

  async function replaceCollection(path: string, field: "basic-auth" | "acls", replacement: Record<string, unknown>): Promise<void> {
    const old = await pages<{ id: string }>(path);
    for (const item of old) {
      if (typeof item.id !== "string") throw new Error(`invalid Kong ${field} record`);
      await write("DELETE", `${path}/${segment(item.id)}`);
    }
    await write("POST", path, replacement);
  }

  return {
    async listManaged(kind) {
      const path = `/${kind}?tags=${TAG}`;
      const rows = await pages<{ name?: string; username?: string }>(path);
      const names = rows.map(row => kind === "consumers" ? row.username : row.name);
      if (names.some(name => typeof name !== "string" || !name.startsWith("tc-app-api-"))) {
        throw new Error("invalid managed Kong entity");
      }
      return names as string[];
    },
    deleteRoute: name => write("DELETE", `/routes/${segment(name)}`),
    putService: spec => write("PUT", `/services/${segment(spec.name)}`, spec),
    async replaceServicePlugins(name, plugins) {
      const path = `/services/${segment(name)}/plugins`;
      const old = await pages<{ id: string }>(path);
      for (const plugin of old) {
        if (typeof plugin.id !== "string") throw new Error("invalid Kong plugin record");
        await write("DELETE", `/plugins/${segment(plugin.id)}`);
      }
      for (const plugin of plugins) await write("POST", path, { name: plugin.name, config: plugin.config, tags: plugin.tags });
    },
    putConsumer: caller => write("PUT", `/consumers/${segment(consumerName(caller.appId))}`, { username: consumerName(caller.appId), tags: [TAG] }),
    replaceCallerCredential: caller => replaceCollection(`/consumers/${segment(consumerName(caller.appId))}/basic-auth`, "basic-auth", { username: caller.username, password: caller.password }),
    replaceCallerGroups: (appId, groups) => replaceCollection(`/consumers/${segment(consumerName(appId))}/acls`, "acls", { group: groups[0] }),
    async putRoute(spec) {
      const service = await json(`/services/${segment(spec.service.name)}`);
      if (typeof service.id !== "string" || !service.id) throw new Error("Kong Service ID unavailable");
      await write("PUT", `/routes/${segment(spec.name)}`, { ...spec, service: { id: service.id } });
    },
    async readRoute(spec) {
      const route = await json(`/routes/${segment(spec.name)}`);
      if (route.name !== spec.name || route.expression !== spec.expression ||
          route.priority !== spec.priority || route.strip_path !== spec.strip_path ||
          route.preserve_host !== spec.preserve_host ||
          !Array.isArray(route.protocols) || !route.protocols.includes("http")) return false;
      const service = await json(`/services/${segment(spec.service.name)}`);
      const ref = route.service;
      return !!ref && typeof ref === "object" && !Array.isArray(ref) &&
        (ref as { id?: unknown }).id === service.id;
    },
    deleteService: name => write("DELETE", `/services/${segment(name)}`),
    deleteConsumer: name => write("DELETE", `/consumers/${segment(name)}`),
  };
}
