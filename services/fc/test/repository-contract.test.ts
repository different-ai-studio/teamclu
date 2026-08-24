import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { runBusinessRepositoryContract } from "../src/lib/repository-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

runBusinessRepositoryContract({
  test,
  assert,
  createRepository: () => contractRepo(),
});

test("golden response: GET /v1/sessions", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: {
      Authorization: "Bearer contract-token",
      "X-Request-Id": "contract_req_1",
    },
    queryParameters: { teamId: "team-1" },
  }, { createRepository: () => contractRepo() });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), fixture("session-list.json"));
});

test("golden response: GET /v1/sessions/{id}/messages", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/messages",
    headers: {
      Authorization: "Bearer contract-token",
      "X-Request-Id": "contract_req_2",
    },
  }, { createRepository: () => contractRepo() });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), fixture("message-list.json"));
});

test("golden response: GET /v1/ideas", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/ideas",
    headers: {
      Authorization: "Bearer contract-token",
      "X-Request-Id": "contract_req_ideas",
    },
    queryStringParameters: { teamId: "team-1" },
  }, { createRepository: () => contractRepo() });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), fixture("ideas-list.json"));
});

function contractRepo() {
  const shortcutStore: any[] = [
    { id: "shortcut-1", scope: "team", label: "Home", owner_member_id: null, team_id: "team-1", parent_id: null, icon: null, order: 0, node_type: "link", target: "", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
  ];
  const roleStore = [
    { id: "role-1", teamId: "team-1", code: "admin", name: "Admin" },
  ];
  // (team, device, owner) → agent actor, mirroring agents_team_device_uk.
  const deviceAgentStore = new Map<string, string>();
  let inviteSeq = 0;
  const permissionStore = [
    { resourceId: "resource-1", roleIds: ["role-1"] },
  ];
  const workspaceStore = [
    { id: "workspace-1", teamId: "team-1", name: "Alpha", slug: null, archived: false, metadata: null, createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
  ];
  const ideaStore = fixture("ideas-list.json").items.slice();
  const configStore: Record<string, any> = {};
  const messageStore: any[] = fixture("message-list.json").items.slice();
  const sessionStore: any[] = fixture("session-list.json").items.slice().map((s: any) => ({ ...s, participants: [{ sessionId: s.id, actorId: "actor-1", role: "owner", joinedAt: s.createdAt }] }));
  const gatewayBindings: Record<string, any> = {};
  const attachmentStore: Record<string, any> = {};
  const runtimeStore: Record<string, any> = {};
  const shareModeStore: Record<string, any> = {};
  const llmConfigStore: Record<string, any> = {};
  const feedbackStore = [];
  const reportStore = [];
  const skillStore = [];
  return {
    async enableShareMode(teamId, mode) {
      const row = {
        id: teamId,
        shareMode: mode,
        shareEnabledAt: "2026-05-28T00:00:00Z",
      };
      shareModeStore[teamId] = row;
      return row;
    },
    async disableShareMode(teamId) {
      shareModeStore[teamId] = {
        id: teamId,
        shareMode: null,
        shareEnabledAt: null,
        gitCredentialRef: null,
      };
      return {
        mode: null,
        enabledAt: null,
      };
    },
    async getShareMode(teamId) {
      const row = shareModeStore[teamId];
      return {
        mode: row?.shareMode ?? null,
        enabledAt: row?.shareEnabledAt ?? null,
      };
    },
    async setupLiteLlm(teamId) {
      return {
        aiGatewayEndpoint: `https://litellm.example.com/${teamId}`,
        litellmKey: `sk-litellm-${teamId}`,
      };
    },
    async ensureMemberKey(teamId) {
      // Fake caller resolution: contract fixtures use "actor-1" as the caller.
      return {
        key: `sk-tc-actor-1-${teamId}`,
        aiGatewayEndpoint: `https://litellm.example.com/${teamId}`,
      };
    },
    async listLiteLlmKeys(teamId) {
      return {
        teamId: `litellm-${teamId}`,
        keys: [
          { key: "sk-abcdefghij...", alias: "member-1", spend: 1.5, created_at: "2026-05-27T01:00:00Z" },
        ],
      };
    },
    async setLiteLlmBudget(teamId, { maxBudget }) {
      return { maxBudget: Number(maxBudget) };
    },
    async getWorkspaceConfig(teamId) {
      const row = shareModeStore[teamId];
      const llm = llmConfigStore[teamId];
      return {
        shareMode: row?.shareMode ?? null,
        syncMode: row?.shareMode === "oss" ? "oss" : (row?.shareMode ? "git" : null),
        litellmTeamId: null,
        llm: {
          enabled: llm?.enabled ?? false,
          baseUrl: llm?.baseUrl ?? null,
          models: llm?.models ?? [],
          availableModels: [],
          aiGatewayEndpoint: null,
        },
      };
    },
    async setLlmConfig(teamId, input) {
      llmConfigStore[teamId] = {
        enabled: input.enabled,
        baseUrl: input.baseUrl,
        models: input.models,
      };
      return { ...llmConfigStore[teamId] };
    },
    async listApps({ teamId, limit }: any) {
      assert.equal(teamId, "team-1");
      return [
        {
          id: "app-1",
          teamId: "team-1",
          name: "Contract App",
          slug: "contract-app",
          type: "tanstack",
          visibility: "team",
          workspaceId: "workspace-1",
          provisionStatus: "ready",
          fcStatus: null,
          createdAt: "2026-05-27T01:00:00Z",
          updatedAt: "2026-05-27T01:00:00Z",
        },
      ];
    },
    async listSessions({ teamId } = {}) {
      // Mirrors the repositories: the list is team-scoped, and a caller with no
      // team has no actor to resolve (20260804020000).
      if (!teamId) throw new Error("listSessions requires teamId");
      return fixture("session-list.json").items;
    },
    async getSession(sessionId) {
      return sessionStore.find(s => s.id === sessionId) ?? null;
    },
    async patchSession(sessionId, patch) {
      const s = sessionStore.find(s => s.id === sessionId);
      if (!s) return null;
      if (patch.title !== undefined) s.title = patch.title;
      return s;
    },
    async createSession(input) {
      const id = input.id ?? "session-new";
      const newS = { id, teamId: input.teamId, title: input.title, mode: input.mode, ideaId: null, lastMessageAt: null, lastMessagePreview: null, hasUnread: false, createdAt: "2026-05-27T03:00:00Z", updatedAt: "2026-05-27T03:00:00Z", participants: (input.participantActorIds ?? []).map(a => ({ sessionId: id, actorId: a, role: "member", joinedAt: null })) };
      sessionStore.push(newS);
      return newS;
    },
    async joinSession(sessionId) {
      const s = sessionStore.find(s => s.id === sessionId);
      if (!s) return null;
      if (!s.participants.some(p => p.actorId === "actor-2")) {
        s.participants.push({ sessionId, actorId: "actor-2", role: "member", joinedAt: null });
      }
      return s;
    },
    async markSessionViewed(sessionId) {},
    async listSessionParticipants(sessionId) {
      const s = sessionStore.find(s => s.id === sessionId);
      return { items: s?.participants ?? [] };
    },
    async upsertSessionParticipant(sessionId, input) {
      const s = sessionStore.find(s => s.id === sessionId);
      const existing = s?.participants?.find(p => p.actorId === input.actorId);
      if (existing) { existing.role = input.role ?? existing.role; return existing; }
      const newP = { sessionId, actorId: input.actorId, role: input.role ?? "member", joinedAt: null };
      if (s) s.participants.push(newP);
      return newP;
    },
    async updateParticipantModel(sessionId, actorId, { model }) {
      const s = sessionStore.find(s => s.id === sessionId);
      const p = s?.participants?.find(p => p.actorId === actorId);
      if (p) p.model = model;
    },
    async removeSessionParticipant(sessionId, actorId) {
      const s = sessionStore.find(s => s.id === sessionId);
      if (s?.participants) s.participants = s.participants.filter(p => p.actorId !== actorId);
    },
    async getSessionByAcp(acpSessionId) {
      return gatewayBindings[acpSessionId] ?? null;
    },
    async ensureGatewaySession(input) {
      const b = input.binding;
      if (gatewayBindings[b]) return { ...gatewayBindings[b], created: false };
      const r = { sessionId: "gw-" + b, gatewaySessionId: b, created: true };
      gatewayBindings[b] = r;
      return r;
    },
    async createCronSession(input) {
      return { sessionId: "cron-" + input.title };
    },
    async listMessages(sessionId) {
      assert.equal(sessionId, "session-1");
      return messageStore;
    },
    async insertMessage(_sessionId, input) {
      if (input.id === "duplicate-message") {
        throw { code: "23505", message: "duplicate key value violates unique constraint" };
      }
      const msg = {
        id: input.id,
        teamId: input.teamId,
        sessionId: "session-1",
        turnId: input.turnId ?? null,
        senderActorId: input.senderActorId,
        replyToMessageId: input.replyToMessageId ?? null,
        kind: input.kind ?? "text",
        content: input.content,
        metadata: input.metadata ?? null,
        model: input.model ?? null,
        createdAt: input.createdAt ?? "2026-05-27T01:00:00Z",
        updatedAt: null,
      };
      messageStore.push(msg);
      return msg;
    },
    async patchMessage(messageId, patch) {
      const msg = messageStore.find(m => m.id === messageId);
      if (!msg) return null;
      if (patch.content !== undefined) msg.content = patch.content;
      if (patch.metadata !== undefined) msg.metadata = patch.metadata;
      msg.updatedAt = "2026-05-27T02:00:00Z";
      return msg;
    },
    async deleteMessage(messageId) {
      const idx = messageStore.findIndex(m => m.id === messageId);
      if (idx >= 0) messageStore.splice(idx, 1);
    },
    async listWorkspaces(args) {
      assert.equal(args.teamId, "team-1");
      return { items: workspaceStore };
    },
    async upsertWorkspace(input) {
      const existing = workspaceStore.find(w => w.id === input.id);
      if (existing) {
        Object.assign(existing, input);
        return existing;
      }
      const newW = {
        id: input.id ?? "workspace-new",
        teamId: input.teamId,
        name: input.name,
        slug: input.slug ?? null,
        archived: input.archived ?? false,
        metadata: input.metadata ?? null,
        createdAt: "2026-05-27T01:00:00Z",
        updatedAt: "2026-05-27T01:00:00Z",
      };
      workspaceStore.push(newW);
      return newW;
    },
    async getWorkspace(workspaceId) {
      return workspaceStore.find(w => w.id === workspaceId) ?? null;
    },
    async patchWorkspace(workspaceId, patch) {
      const w = workspaceStore.find(w => w.id === workspaceId);
      if (!w) return null;
      if (patch.name !== undefined) w.name = patch.name;
      if (patch.archived !== undefined) w.archived = patch.archived;
      if (patch.metadata !== undefined) w.metadata = patch.metadata;
      return w;
    },
    async getTeamWorkspaceConfig(teamId) {
      return configStore[teamId] ?? null;
    },
    async putTeamWorkspaceConfig(teamId, input) {
      configStore[teamId] = {
        teamId,
        defaultWorkspaceId: input.defaultWorkspaceId ?? null,
        pinnedWorkspaceIds: input.pinnedWorkspaceIds ?? [],
        updatedAt: "2026-05-27T01:00:00Z",
      };
      return configStore[teamId];
    },
    async getTeamDirectory(teamId) {
      assert.equal(teamId, "team-1");
      return {
        actors: [
          {
            id: "actor-1",
            teamId: "team-1",
            kind: "user",
            displayName: "Alice",
            avatarUrl: null,
            metadata: null,
          },
          {
            id: "actor-2",
            teamId: "team-1",
            kind: "agent",
            displayName: "Bot",
            avatarUrl: "https://example.com/avatar.png",
            metadata: { type: "assistant" },
          },
        ],
        members: [
          {
            actorId: "actor-1",
            teamId: "team-1",
            role: "member",
            joinedAt: "2026-05-27T01:00:00Z",
          },
          {
            actorId: "actor-2",
            teamId: "team-1",
            role: "admin",
            joinedAt: "2026-05-27T02:00:00Z",
          },
        ],
      };
    },
    async listTeamActors(teamId, { kind, limit }) {
      assert.equal(teamId, "team-1");
      return {
        items: [
          { id: "actor-1", teamId: "team-1", kind: "user", displayName: "Test Actor", avatarUrl: null, metadata: null },
          { id: "actor-2", teamId: "team-1", kind: "agent", displayName: "Test Agent", avatarUrl: null, metadata: null },
        ],
      };
    },
    async getActor(actorId) {
      if (actorId === "actor-missing") return null;
      return { id: actorId, teamId: "team-1", kind: "user", displayName: "Test Actor", avatarUrl: null, metadata: null, clientVersions: [] };
    },
    async reportClientVersion(_teamId, _body) {},
    async upsertExternalActor(input) {
      assert.equal(input.teamId, "team-1");
      return { actorId: "actor-new" };
    },
    async listConnectedAgents(teamId) {
      assert.equal(teamId, "team-1");
      return {
        items: [
          { id: "agent-1", teamId: "team-1", kind: "agent", displayName: "Test Agent", avatarUrl: null, metadata: null, lastSeenAt: "2026-05-27T01:00:00Z", agentType: "claude" },
        ],
      };
    },
    // Device-scoped agent identity. The fake keeps the (team, device) → agent map
    // the real implementations get from the unique index, so the contract's
    // idempotency assertions test the same thing everywhere.
    async findAgentForDevice(teamId, input) {
      assert.equal(teamId, "team-1");
      assert.ok(input.deviceId, "deviceId is required");
      const agentId = deviceAgentStore.get(`${teamId}:${input.deviceId}`) ?? null;
      return { agentId, displayName: agentId ? `name-of-${agentId}` : null };
    },
    async ensureAgentForDevice(teamId, input) {
      assert.equal(teamId, "team-1");
      assert.ok(input.deviceId, "deviceId is required");
      assert.ok(input.displayName, "displayName is required");
      const key = `${teamId}:${input.deviceId}`;
      const existing = deviceAgentStore.get(key);
      const agentId = existing ?? `agent-${deviceAgentStore.size + 100}`;
      if (!existing) deviceAgentStore.set(key, agentId);
      inviteSeq += 1;
      return {
        agentId,
        token: `device-invite-${inviteSeq}`,
        expiresAt: null,
        created: !existing,
      };
    },
    async updateOwnedAgentProfile(agentActorId, patch) {
      assert.equal(agentActorId, "agent-1");
    },
    async shareAgentToTeam(agentActorId) {
      assert.ok(typeof agentActorId === "string");
    },
    async makeAgentPersonal(agentActorId) {
      assert.ok(typeof agentActorId === "string");
    },
    async updateAgentDefaults(agentActorId, patch) {
      assert.equal(agentActorId, "agent-1");
    },
    async checkAgentPermission(agentActorId, actorId) {
      assert.equal(agentActorId, "agent-1");
      if (actorId === "actor-no-access") return { allowed: false, role: null };
      return { allowed: true, role: "admin" };
    },
    async listAgentAccess(agentActorId) {
      assert.equal(agentActorId, "agent-1");
      return {
        items: [
          { agentActorId: "agent-1", actorId: "actor-1", role: "admin" },
        ],
      };
    },
    async grantAgentAccess(agentActorId, { actorId, role }) {
      assert.equal(agentActorId, "agent-1");
      return { agentActorId, actorId, role };
    },
    async revokeAgentAccess(agentActorId, actorId) {
      assert.equal(agentActorId, "agent-1");
    },
    async listAgentAdminMembers(agentActorId) {
      assert.equal(agentActorId, "agent-1");
      return { items: ["actor-1"] };
    },
    async getNotificationPrefs() {
      return { user_id: null, enabled: true, dnd_start_min: null, dnd_end_min: null, dnd_tz: "Asia/Shanghai", updated_at: null };
    },
    async putNotificationPrefs(input) {
      return {
        user_id: input.user_id ?? "user-1",
        enabled: input.enabled ?? true,
        dnd_start_min: input.dnd_start_min ?? null,
        dnd_end_min: input.dnd_end_min ?? null,
        dnd_tz: input.dnd_tz ?? "Asia/Shanghai",
        updated_at: null,
      };
    },
    async registerDevicePushToken(input) {
      assert.ok(typeof input.deviceId === "string");
      assert.ok(typeof input.token === "string");
    },
    async muteSession(sessionId, input) {},
    async unmuteSession(sessionId) {},
    async listMutedSessions() {
      return { items: [] };
    },
    async renameTeam(teamId, input) {
      assert.equal(teamId, "team-1");
      return { id: teamId, name: input.name, slug: null, createdAt: null };
    },
    async createTeamInvite(teamId, input) {
      assert.equal(teamId, "team-1");
      return { token: "invite-token", inviteId: "invite-1", expiresAt: input.expiresAt ?? null };
    },
    async removeTeamActor(teamId, actorId) {
      assert.ok(typeof actorId === "string");
    },
    async updateCurrentActorProfile(actorId, { displayName, avatarUrl }) {
      return {
        id: actorId, teamId: "team-1", kind: "member",
        displayName, avatarUrl: avatarUrl ?? null, userId: "user-1",
        invitedByActorId: null, teamRole: "member", memberStatus: "active",
        agentStatus: null, agentTypes: null, agentKind: null,
        defaultAgentType: null, defaultWorkspaceId: null,
        lastActiveAt: null, createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T01:00:00Z",
      };
    },
    async listIdeas({ teamId, archived, limit, cursor }) {
      assert.equal(teamId, "team-1");
      return { items: ideaStore };
    },
    async getIdea(ideaId) {
      return ideaStore.find(i => i.id === ideaId) ?? null;
    },
    async createIdea(body) {
      const idea = {
        id: body.id ?? "idea-new",
        teamId: body.teamId,
        title: body.title,
        description: body.description ?? null,
        archived: false,
        authorActorId: body.authorActorId,
        actorIds: body.actorIds ?? [],
        createdAt: "2026-05-27T01:00:00Z",
        updatedAt: "2026-05-27T01:00:00Z",
      };
      ideaStore.push(idea);
      return idea;
    },
    async updateIdea(ideaId, patch) {
      const i = ideaStore.find(i => i.id === ideaId);
      if (!i) return null;
      if (patch.title !== undefined) i.title = patch.title;
      if (patch.description !== undefined) i.description = patch.description;
      return i;
    },
    async archiveIdea(ideaId) {
      const i = ideaStore.find(i => i.id === ideaId);
      if (i) i.archived = true;
    },
    async createIdeaActivity(ideaId, body) {
      return {
        id: "activity-1",
        ideaId,
        kind: body.kind,
        content: body.content ?? null,
        actorId: body.actorId,
        metadata: body.metadata ?? null,
        createdAt: "2026-05-27T01:00:00Z",
      };
    },
    async listIdeaActivities(ideaId) {
      return { items: [{
        id: "activity-1",
        ideaId,
        kind: "comment",
        activityType: "comment",
        content: "hi",
        actorId: "actor-1",
        metadata: null,
        teamId: "team-1",
        attachmentUrls: [],
        createdAt: "2026-05-27T01:00:00Z",
        updatedAt: "2026-05-27T01:00:00Z",
      }] };
    },
    async reorderIdeas({ teamId, ideaIds }) {
      assert.equal(teamId, "team-1");
      assert.ok(Array.isArray(ideaIds));
    },
    async listShortcuts(teamId: any, { parentId }: any = {}) {
      let items = shortcutStore.filter(s => s.team_id === teamId);
      if (parentId !== undefined) {
        items = items.filter(s => s.parent_id === parentId);
      }
      return items;
    },
    async createShortcut(body) {
      const s = {
        id: body.id ?? "shortcut-new",
        scope: body.scope ?? "team",
        label: body.label,
        owner_member_id: null,
        team_id: body.teamId,
        parent_id: body.parentId ?? null,
        icon: body.icon ?? null,
        order: body.position ?? 0,
        node_type: body.kind,
        target: body.payload ?? "",
        created_at: "2026-05-27T01:00:00Z",
        updated_at: "2026-05-27T01:00:00Z",
      };
      shortcutStore.push(s);
      return s;
    },
    async updateShortcut(shortcutId, patch) {
      const s = shortcutStore.find(s => s.id === shortcutId);
      if (!s) return null;
      if (patch.label !== undefined) s.label = patch.label;
      if (patch.payload !== undefined) s.target = patch.payload;
      if (patch.parentId !== undefined) s.parent_id = patch.parentId;
      if (patch.position !== undefined) s.order = patch.position;
      s.updated_at = "2026-05-27T02:00:00Z";
      return s;
    },
    async deleteShortcut(shortcutId) {
      const idx = shortcutStore.findIndex(s => s.id === shortcutId);
      if (idx >= 0) shortcutStore.splice(idx, 1);
    },
    async batchMoveShortcuts({ moves }) {},
    async setShortcutVisibleRoles(shortcutId, { roleIds }) {},
    async listTeamRoles(teamId) {
      return roleStore.filter(r => r.teamId === teamId);
    },
    async listTeamPermissions(teamId) {
      return permissionStore;
    },
    async uploadAttachment({ path, mime, bytes, bucket }) {
      const targetBucket = bucket || "attachments";
      attachmentStore[`${targetBucket}/${path}`] = { mime, bytes };
      return { path, url: `https://supabase.example.com/storage/v1/object/public/${targetBucket}/${path}` };
    },
    async downloadAttachment(path: any, { bucket }: any = {}) {
      const targetBucket = bucket || "attachments";
      const entry = attachmentStore[`${targetBucket}/${path}`];
      if (!entry) return null;
      return { mime: entry.mime, bytes: entry.bytes };
    },
    async ensureAgentTypes({ supportedTypes, defaultAgentType }) {},
    async submitFeedback(body) {
      const row = {
        messageId: body.messageId,
        actorId: body.actorId,
        teamId: body.teamId ?? null,
        sessionId: body.sessionId ?? null,
        kind: body.kind,
        starRating: body.starRating ?? null,
        skill: body.skill ?? null,
        createdAt: "2026-05-29T00:00:00Z",
      };
      feedbackStore.push(row);
      return row;
    },
    async listFeedback({ sessionId }) {
      return { items: feedbackStore.filter(f => f.sessionId === sessionId) };
    },
    async deleteFeedback(messageId, actorId) {
      const idx = feedbackStore.findIndex(f => f.messageId === messageId && f.actorId === actorId);
      if (idx >= 0) feedbackStore.splice(idx, 1);
    },
    async submitSessionReport(body) {
      reportStore.push({ ...body });
      for (const [skill, count] of Object.entries(body.skillUsage ?? {})) {
        skillStore.push({ actorId: body.actorId, teamId: body.teamId, sessionId: body.sessionId, skill, count });
      }
    },
    async submitSkillUsage(body) {
      skillStore.push({ ...body, count: body.count ?? 1 });
    },
    async listFeedbackSummary(teamId) {
      const items = feedbackStore
        .filter((f) => f.teamId === teamId)
        .reduce((acc, f) => {
          const e = acc.get(f.actorId) ?? { actorId: f.actorId, displayName: null, positive: 0, negative: 0, total: 0 };
          if (f.kind === "positive") e.positive += 1;
          if (f.kind === "negative") e.negative += 1;
          e.total += 1;
          acc.set(f.actorId, e);
          return acc;
        }, new Map());
      return { items: [...items.values()] };
    },
    async getTeamLeaderboard(teamId, { period = "week" } = {}) {
      const byActor = new Map();
      const ensure = (actorId) => {
        if (!byActor.has(actorId)) {
          byActor.set(actorId, {
            actorId, teamId, displayName: null, period,
            tokensUsed: 0, costUsd: 0, positiveFeedback: 0, negativeFeedback: 0,
            sessionCount: 0, skillUsage: {}, score: 0,
          });
        }
        return byActor.get(actorId);
      };
      for (const r of reportStore) {
        if (r.teamId !== teamId) continue;
        const e = ensure(r.actorId);
        e.tokensUsed += r.tokensUsed ?? 0;
        e.costUsd += r.costUsd ?? 0;
        e.sessionCount += 1;
        e.score = e.tokensUsed;
      }
      for (const f of feedbackStore) {
        if (f.teamId !== teamId) continue;
        const e = ensure(f.actorId);
        if (f.kind === "positive") e.positiveFeedback += 1;
        if (f.kind === "negative") e.negativeFeedback += 1;
      }
      for (const s of skillStore) {
        if (s.teamId !== teamId) continue;
        const e = ensure(s.actorId);
        e.skillUsage[s.skill] = (e.skillUsage[s.skill] ?? 0) + (s.count ?? 1);
      }
      return { items: [...byActor.values()] };
    },
  };
}

function fixture(name) {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "v1", name), "utf8"));
}
