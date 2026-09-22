import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../http-utils.js";

interface WikiMaintainerHost {
  supabase: any;
  serviceRoleClient: (what: string) => Promise<any>;
  resolveCallerActorForTeam: (teamId: string) => Promise<{ id: string } | null>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
const STAGES = new Set(["idle", "ready_to_publish", "publishing", "sync_pending", "needs_attention"]);

function integer(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(400, "validation_failed", `${name} must be a non-negative integer`);
  }
  return parsed;
}

function requiredHash(value: unknown, name: string, pattern = SHA256_RE): string {
  const text = String(value ?? "").trim();
  if (!pattern.test(text)) {
    throw new ApiError(400, "validation_failed", `${name} is invalid`);
  }
  return text;
}

export function assertExpectedGeneration(current: number, expected: unknown): number {
  const parsed = integer(expected, "expectedGeneration");
  if (parsed !== current) {
    throw new ApiError(409, "checkpoint_conflict", "wiki checkpoint generation changed", {
      details: { currentGeneration: current, expectedGeneration: parsed },
    });
  }
  return parsed;
}

export function parseWikiConfigWrite(body: any) {
  const expectedVersion = integer(body?.expectedVersion, "expectedVersion");
  if (!body?.config || typeof body.config !== "object" || Array.isArray(body.config)) {
    throw new ApiError(400, "validation_failed", "config must be an object");
  }
  return { expectedVersion, config: body.config };
}

export function hashPublishToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapCheckpoint(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    generation: Number(row.generation),
    parentGeneration: Number(row.parent_generation),
    objectKey: row.object_key,
    sha256: row.sha256,
    size: Number(row.size),
    manifest: row.manifest,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapConfig(row: any) {
  return row
    ? {
        version: Number(row.version),
        config: row.config,
        updatedAt: row.updated_at,
      }
    : null;
}

function mapState(row: any, config: any, checkpoint: any) {
  return {
    config: mapConfig(config),
    generation: Number(row?.generation ?? 0),
    stage: STAGES.has(row?.stage) ? row.stage : "idle",
    checkpoint: mapCheckpoint(checkpoint),
    publishing: row?.publishing ?? null,
    syncStatus: row?.sync_status ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapRpcError(error: any): never {
  const message = String(error?.message ?? "");
  if (error?.code === "P0001" || /generation|version|publishing|token/i.test(message)) {
    throw new ApiError(409, "checkpoint_conflict", message || "wiki maintainer state changed");
  }
  throw error;
}

export function makeWikiMaintainerRepo(host: WikiMaintainerHost) {
  async function requireTeamAdmin(teamId: string): Promise<string> {
    const actor = await host.resolveCallerActorForTeam(teamId);
    if (!actor) throw new ApiError(403, "forbidden", "not a member of this team");
    const { data, error } = await host.supabase.rpc("current_team_role", {
      target_team_id: teamId,
    });
    if (error) throw error;
    if (data !== "owner" && data !== "admin") {
      throw new ApiError(403, "forbidden", "team owner or admin access required");
    }
    return actor.id;
  }

  async function admin(teamId: string, what: string) {
    const actorId = await requireTeamAdmin(teamId);
    return { actorId, db: await host.serviceRoleClient(what) };
  }

  async function load(teamId: string, what: string) {
    const { db } = await admin(teamId, what);
    const [{ data: config, error: configError }, { data: state, error: stateError }] =
      await Promise.all([
        db
          .from("wiki_maintainer_configs")
          .select("*")
          .eq("team_id", teamId)
          .maybeSingle(),
        db
          .from("wiki_maintainer_state")
          .select("*")
          .eq("team_id", teamId)
          .maybeSingle(),
      ]);
    if (configError) throw configError;
    if (stateError) throw stateError;
    let checkpoint = null;
    if (state?.current_checkpoint_id) {
      const { data, error } = await db
        .from("wiki_maintainer_checkpoints")
        .select("*")
        .eq("id", state.current_checkpoint_id)
        .maybeSingle();
      if (error) throw error;
      checkpoint = data;
    }
    return { db, config, state, checkpoint, view: mapState(state, config, checkpoint) };
  }

  async function rpc(db: any, name: string, args: any) {
    const { data, error } = await db.rpc(name, args);
    if (error) mapRpcError(error);
    return data;
  }

  return {
    async getWikiMaintainerStatus(teamId: string) {
      return (await load(teamId, "read wiki maintainer state")).view;
    },

    async putWikiMaintainerConfig(teamId: string, body: any = {}) {
      const parsed = parseWikiConfigWrite(body);
      const { actorId, db } = await admin(teamId, "update wiki maintainer config");
      return rpc(db, "wiki_maintainer_put_config", {
        p_team_id: teamId,
        p_expected_version: parsed.expectedVersion,
        p_config: parsed.config,
        p_actor_id: actorId,
      });
    },

    async prepareWikiMaintainerCheckpoint(teamId: string, body: any = {}) {
      const loaded = await load(teamId, "prepare wiki maintainer checkpoint");
      assertExpectedGeneration(loaded.view.generation, body.expectedGeneration);
      if (loaded.view.stage === "publishing") {
        throw new ApiError(409, "publish_in_progress", "wiki publish recovery must finish first");
      }
      const configVersion = integer(body.configVersion, "configVersion");
      if (configVersion !== Number(loaded.config?.version ?? 0)) {
        throw new ApiError(409, "config_conflict", "wiki maintainer config changed");
      }
      return {
        expectedGeneration: loaded.view.generation,
        configVersion,
        sha256: requiredHash(body.sha256, "sha256"),
        size: integer(body.size, "size"),
      };
    },

    async completeWikiMaintainerCheckpoint(teamId: string, body: any = {}) {
      const { actorId, db } = await admin(teamId, "complete wiki maintainer checkpoint");
      return rpc(db, "wiki_maintainer_complete_checkpoint", {
        p_team_id: teamId,
        p_expected_generation: integer(body.expectedGeneration, "expectedGeneration"),
        p_config_version: integer(body.configVersion, "configVersion"),
        p_object_key: String(body.objectKey ?? ""),
        p_sha256: requiredHash(body.sha256, "sha256"),
        p_size: integer(body.size, "size"),
        p_manifest: body.manifest ?? {},
        p_created_by: actorId,
      });
    },

    async getLatestWikiMaintainerCheckpoint(teamId: string) {
      const loaded = await load(teamId, "download wiki maintainer checkpoint");
      return mapCheckpoint(loaded.checkpoint);
    },

    async beginWikiMaintainerPublish(teamId: string, body: any = {}) {
      const { actorId, db } = await admin(teamId, "begin wiki maintainer publish");
      const token = randomBytes(32).toString("base64url");
      const state = await rpc(db, "wiki_maintainer_begin_publish", {
        p_team_id: teamId,
        p_generation: integer(body.generation, "generation"),
        p_config_version: integer(body.configVersion, "configVersion"),
        p_target_commit: requiredHash(body.targetCommit, "targetCommit", GIT_COMMIT_RE),
        p_target_tree_hash: requiredHash(body.targetTreeHash, "targetTreeHash"),
        p_base_tree_hash:
          body.baseTreeHash == null
            ? null
            : requiredHash(body.baseTreeHash, "baseTreeHash"),
        p_node_id: String(body.nodeId ?? ""),
        p_publish_token_hash: hashPublishToken(token),
        p_actor_id: actorId,
      });
      return { ...state, publishToken: token };
    },

    async completeWikiMaintainerPublish(teamId: string, body: any = {}) {
      const { db } = await admin(teamId, "complete wiki maintainer publish");
      const syncStatus = String(body.syncStatus ?? "");
      if (!["synced", "published_local_sync_pending"].includes(syncStatus)) {
        throw new ApiError(400, "validation_failed", "syncStatus is invalid");
      }
      return rpc(db, "wiki_maintainer_complete_publish", {
        p_team_id: teamId,
        p_publish_token_hash: hashPublishToken(String(body.publishToken ?? "")),
        p_sync_status: syncStatus,
      });
    },

    async recoverWikiMaintainerPublish(teamId: string) {
      const { actorId, db } = await admin(teamId, "recover wiki maintainer publish");
      const token = randomBytes(32).toString("base64url");
      const state = await rpc(db, "wiki_maintainer_recover_publish", {
        p_team_id: teamId,
        p_publish_token_hash: hashPublishToken(token),
        p_actor_id: actorId,
      });
      return { ...state, publishToken: token };
    },
  };
}
