/**
 * Behavioural contract the business repository must satisfy.
 *
 * Implemented by lib/supabase-repo.ts; gated by
 * test/repository-contract.test.ts against a stub client.
 */
export function runBusinessRepositoryContract({ test, assert, createRepository }) {
  test("repository contract: sessions keep canonical fields and ordering", async () => {
    const repo = createRepository();
    // teamId is what the list resolves the caller's actor from — a user has one
    // actor row per team (20260804020000).
    const rows = await repo.listSessions({ limit: 50, cursor: null, teamId: "team-1" });

    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 2, "contract fixture must include at least two sessions");
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "createdAt",
      "hasUnread",
      "ideaId",
      "lastMessageAt",
      "lastMessagePreview",
      "mode",
      "teamId",
      "title",
      "updatedAt",
      "id",
      // Display-row fields. They used to come from GET /v1/teams/:teamId/sessions;
      // that endpoint is gone, so both backends must serve them from the list
      // path or iOS/Expo lose data with no compile-time signal.
      "summary",
      "primaryAgentId",
      "createdByActorId",
      "participantCount",
    ].sort());

    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        compareSessionRows(rows[i - 1], rows[i]) <= 0,
        "sessions must be ordered by lastMessageAt desc nulls last, then createdAt desc, then id desc",
      );
    }
  });

  test("repository contract: messages keep canonical fields and ascending order", async () => {
    const repo = createRepository();
    const rows = await repo.listMessages("session-1");

    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 2, "contract fixture must include at least two messages");
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "content",
      "createdAt",
      "id",
      "kind",
      "metadata",
      "model",
      "replyToMessageId",
      "senderActorId",
      "sessionId",
      "teamId",
      "turnId",
      "updatedAt",
    ].sort());

    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        compareMessageRows(rows[i - 1], rows[i]) <= 0,
        "messages must be ordered by createdAt asc, then id asc",
      );
    }
  });

  test("repository contract: duplicate message ids surface as conflicts", async () => {
    const repo = createRepository();
    await assert.rejects(
      () => repo.insertMessage("session-1", {
        id: "duplicate-message",
        teamId: "team-1",
        senderActorId: "actor-1",
        content: "duplicate",
      }),
      (error) => error?.code === "23505" || error?.code === "conflict",
    );
  });

  test("repository contract: patchMessage updates content", async () => {
    const repo = createRepository();
    const patched = await repo.patchMessage("message-1", { content: "updated content" });
    assert.ok(patched, "patched message should exist");
    assert.equal(patched.content, "updated content");
    assert.equal(patched.id, "message-1");
  });

  test("repository contract: deleteMessage removes row", async () => {
    const repo = createRepository();
    await repo.deleteMessage("message-1");
    const messages = await repo.listMessages("session-1");
    assert.ok(messages.every(m => m.id !== "message-1"), "message should be deleted");
  });

  test("repository contract: listWorkspaces returns paged team workspaces", async () => {
    const repo = createRepository();
    const page = await repo.listWorkspaces({ teamId: "team-1", limit: 50, cursor: null });

    assert.ok(Array.isArray(page.items));
    assert.ok(page.items.length >= 1, "contract fixture must include at least one workspace");
    assert.deepEqual(Object.keys(page.items[0]).sort(), [
      "archived",
      "createdAt",
      "id",
      "metadata",
      "name",
      "slug",
      "teamId",
      "updatedAt",
    ].sort());
  });

  test("repository contract: upsertWorkspace returns inserted row", async () => {
    const repo = createRepository();
    const w = await repo.upsertWorkspace({
      id: "workspace-new",
      teamId: "team-1",
      name: "New Workspace",
    });
    assert.equal(w.id, "workspace-new");
    assert.equal(w.archived, false);
  });

  test("repository contract: getWorkspace returns single workspace", async () => {
    const repo = createRepository();
    const w = await repo.getWorkspace("workspace-1");
    assert.ok(w, "workspace should exist");
    assert.equal(w.name, "Alpha");
  });

  test("repository contract: patchWorkspace mutates name / archived", async () => {
    const repo = createRepository();
    const w = await repo.patchWorkspace("workspace-1", { archived: true });
    assert.equal(w.archived, true);
  });

  test("repository contract: getTeamWorkspaceConfig returns null when absent", async () => {
    const repo = createRepository();
    const cfg = await repo.getTeamWorkspaceConfig("team-no-config");
    assert.equal(cfg, null);
  });

  test("repository contract: putTeamWorkspaceConfig upserts row", async () => {
    const repo = createRepository();
    const teamId = "team-1";
    const next = {
      teamId,
      defaultWorkspaceId: "workspace-1",
      pinnedWorkspaceIds: [],
    };
    const out = await repo.putTeamWorkspaceConfig(teamId, next);
    assert.deepEqual(out.defaultWorkspaceId, "workspace-1");
    assert.deepEqual(out.pinnedWorkspaceIds, []);

    const cfg = await repo.getTeamWorkspaceConfig(teamId);
    assert.ok(cfg, "config should exist after put");
    assert.deepEqual(cfg.defaultWorkspaceId, "workspace-1");
  });

  test("repository contract: getSession returns session with participants", async () => {
    const repo = createRepository();
    const s = await repo.getSession("session-1");
    assert.ok(s, "session should exist");
    assert.equal(s.id, "session-1");
    assert.ok(Array.isArray(s.participants), "participants should be an array");
  });

  test("repository contract: patchSession mutates title", async () => {
    const repo = createRepository();
    const s = await repo.patchSession("session-1", { title: "Updated title" });
    assert.ok(s, "session should exist");
    assert.equal(s.title, "Updated title");
  });

  test("repository contract: createSession returns session with participants", async () => {
    const repo = createRepository();
    const s = await repo.createSession({
      id: "session-new",
      teamId: "team-1",
      title: "New Session",
      mode: "solo",
      participantActorIds: ["actor-1"],
    });
    assert.equal(s.id, "session-new");
    assert.equal(s.title, "New Session");
    assert.ok(Array.isArray(s.participants), "participants should be an array");
  });

  test("repository contract: markSessionViewed succeeds", async () => {
    const repo = createRepository();
    await repo.markSessionViewed("session-1");
  });

  test("repository contract: listSessionParticipants returns items", async () => {
    const repo = createRepository();
    const out = await repo.listSessionParticipants("session-1");
    assert.ok(Array.isArray(out.items), "items should be an array");
  });

  test("repository contract: listSessionRoster returns roster items", async () => {
    const repo = createRepository();
    const out = await repo.listSessionRoster("session-1");
    assert.equal(out.sessionId, "session-1");
    assert.ok(Array.isArray(out.items), "items should be an array");
    assert.ok(out.items.length >= 1, "contract fixture includes participants");
    assert.ok("displayName" in out.items[0], "roster items expose displayName");
  });

  test("repository contract: upsertSessionParticipant returns participant", async () => {
    const repo = createRepository();
    const p = await repo.upsertSessionParticipant("session-1", { actorId: "actor-new", role: "member" });
    assert.equal(p.actorId, "actor-new");
    assert.equal(p.role, "member");
  });

  test("repository contract: joinSession adds the caller and is idempotent", async () => {
    const repo = createRepository();
    const first = await repo.joinSession("session-1");
    assert.ok(first, "joinSession should return a session");
    assert.equal(first.id, "session-1");
    assert.ok(Array.isArray(first.participants), "participants should be an array");
    const joined = first.participants.filter((p) => p.actorId === "actor-2");
    assert.equal(joined.length, 1, "caller should be added exactly once");

    // Idempotent: a second call must not add a duplicate participant.
    const second = await repo.joinSession("session-1");
    assert.equal(second.id, "session-1");
    assert.equal(
      second.participants.filter((p) => p.actorId === "actor-2").length,
      1,
      "no duplicate participant after a second join",
    );
  });

  test("repository contract: updateParticipantModel succeeds", async () => {
    const repo = createRepository();
    await repo.updateParticipantModel("session-1", "actor-1", {
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  test("repository contract: updateParticipantModel round-trips through the participant row", async () => {
    // The point of the whole endpoint: `session_participants.model` was
    // backfilled once by the ADR-0005 migration and then had no writer, so it
    // read as authoritative while drifting. Asserting the read-back here is
    // what keeps a future refactor from quietly disconnecting it again.
    const repo = createRepository();
    await repo.updateParticipantModel("session-1", "actor-1", { model: "openai/gpt-5" });
    const out = await repo.listSessionParticipants("session-1");
    const row = out.items.find((p) => p.actorId === "actor-1");
    assert.ok(row, "actor-1 should still be a participant");
    assert.equal(row.model, "openai/gpt-5");
  });

  test("repository contract: removeSessionParticipant succeeds", async () => {
    const repo = createRepository();
    await repo.removeSessionParticipant("session-1", "actor-1");
  });

  test("repository contract: getSessionByAcp returns null when absent", async () => {
    const repo = createRepository();
    const out = await repo.getSessionByAcp("acp-missing");
    assert.equal(out, null);
  });

  test("repository contract: ensureGatewaySession is idempotent", async () => {
    const repo = createRepository();
    const first = await repo.ensureGatewaySession({
      teamId: "team-1",
      binding: "wecom:room#1",
      title: "Stand-up",
      primaryAgentActorId: "actor-1",
      ownerMemberActorIds: [],
      participantActorIds: [],
    });
    assert.ok(first.sessionId, "sessionId should be present");
    assert.ok(first.gatewaySessionId, "gatewaySessionId should be present");
    assert.equal(first.created, true);

    const second = await repo.ensureGatewaySession({
      teamId: "team-1",
      binding: "wecom:room#1",
      title: "Stand-up",
      primaryAgentActorId: "actor-1",
      ownerMemberActorIds: [],
      participantActorIds: [],
    });
    assert.equal(first.sessionId, second.sessionId, "sessionId should be identical");
    assert.equal(second.created, false, "second call should not create new session");
  });

  test("repository contract: createCronSession returns sessionId", async () => {
    const repo = createRepository();
    const out = await repo.createCronSession({
      teamId: "team-1",
      primaryAgentActorId: "actor-1",
      title: "Daily summary",
    });
    assert.ok(out.sessionId, "sessionId should be present");
  });

  test("repository contract: listTeamActors returns paged team actors", async () => {
    const repo = createRepository();
    const page = await repo.listTeamActors("team-1", { kind: null, limit: 200 });

    assert.ok(Array.isArray(page.items));
    assert.ok(page.items.length >= 1, "contract fixture must include at least one actor");
    assert.deepEqual(Object.keys(page.items[0]).sort(), [
      "avatarUrl",
      "displayName",
      "id",
      "kind",
      "metadata",
      "teamId",
    ].sort());
  });

  test("repository contract: getActor returns single actor", async () => {
    const repo = createRepository();
    const actor = await repo.getActor("actor-1");
    assert.ok(actor, "actor should exist");
    assert.equal(actor.displayName, "Test Actor");
    assert.ok(Array.isArray(actor.clientVersions), "getActor must return clientVersions array");
  });

  test("repository contract: getActor returns null for missing actor", async () => {
    const repo = createRepository();
    const actor = await repo.getActor("actor-missing");
    assert.equal(actor, null);
  });

  test("repository contract: upsertExternalActor returns actorId", async () => {
    const repo = createRepository();
    const result = await repo.upsertExternalActor({
      teamId: "team-1",
      source: "wecom",
      sourceId: "external-1",
      displayName: "External User",
    });
    assert.ok(result.actorId, "actorId must be present");
  });

  test("repository contract: listConnectedAgents returns agent list", async () => {
    const repo = createRepository();
    const result = await repo.listConnectedAgents("team-1");
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length >= 1, "contract fixture must include at least one connected agent");
    assert.equal(result.items[0].kind, "agent");
  });

  test("repository contract: findAgentForDevice reports absence before creation", async () => {
    const repo = createRepository();
    // The desktop's first question. A null here is what earns the right to
    // interrupt the user for a name; anything else must bind silently.
    const before = await repo.findAgentForDevice("team-1", { deviceId: "device-contract-lookup" });
    assert.equal(before.agentId, null);

    const created = await repo.ensureAgentForDevice("team-1", {
      deviceId: "device-contract-lookup",
      displayName: "lookup-host",
    });
    const after = await repo.findAgentForDevice("team-1", { deviceId: "device-contract-lookup" });
    assert.equal(after.agentId, created.agentId);
  });

  test("repository contract: ensureAgentForDevice is idempotent per device", async () => {
    const repo = createRepository();
    const first = await repo.ensureAgentForDevice("team-1", {
      deviceId: "device-contract-1",
      displayName: "contract-host",
    });
    assert.ok(first.agentId, "agentId must be present");
    assert.ok(first.token, "an invite token must be minted so the daemon can claim");
    assert.equal(typeof first.created, "boolean");

    // The whole point: a second call for the same machine re-binds the same
    // actor rather than stacking up a duplicate agent. Silent binding has no
    // human in the loop to notice the duplicates.
    const second = await repo.ensureAgentForDevice("team-1", {
      deviceId: "device-contract-1",
      displayName: "contract-host",
    });
    assert.equal(second.agentId, first.agentId, "same device must map to the same agent");
    assert.equal(second.created, false, "the second call must re-bind, not create");
    assert.ok(second.token, "each call mints a fresh one-shot invite");
    assert.notEqual(second.token, first.token, "invites are one-shot, so tokens must differ");
  });

  test("repository contract: ensureAgentForDevice gives a different device its own agent", async () => {
    const repo = createRepository();
    const a = await repo.ensureAgentForDevice("team-1", {
      deviceId: "device-contract-a",
      displayName: "host-a",
    });
    const b = await repo.ensureAgentForDevice("team-1", {
      deviceId: "device-contract-b",
      displayName: "host-b",
    });
    assert.notEqual(b.agentId, a.agentId, "one agent per machine, not per team");
  });

  test("repository contract: updateOwnedAgentProfile succeeds", async () => {
    const repo = createRepository();
    await repo.updateOwnedAgentProfile("agent-1", {
      displayName: "Updated Agent",
      avatarUrl: null,
      description: null,
    });
  });

  test("repository contract: updateAgentDefaults succeeds", async () => {
    const repo = createRepository();
    await repo.updateAgentDefaults("agent-1", {
      defaultAgentType: "claude",
      supportedAgentTypes: ["claude", "gpt"],
    });
  });

  test("repository contract: checkAgentPermission returns allowed when access exists", async () => {
    const repo = createRepository();
    const result = await repo.checkAgentPermission("agent-1", "actor-1");
    assert.equal(result.allowed, true);
    assert.ok(result.role, "role must be present when allowed");
  });

  test("repository contract: checkAgentPermission returns not allowed when no access", async () => {
    const repo = createRepository();
    const result = await repo.checkAgentPermission("agent-1", "actor-no-access");
    assert.equal(result.allowed, false);
    assert.equal(result.role, null);
  });

  test("repository contract: listAgentAccess returns access list", async () => {
    const repo = createRepository();
    const result = await repo.listAgentAccess("agent-1");
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length >= 1, "contract fixture must include at least one access entry");
    assert.deepEqual(Object.keys(result.items[0]).sort(), [
      "actorId",
      "agentActorId",
      "role",
    ].sort());
  });

  test("repository contract: grantAgentAccess upserts access", async () => {
    const repo = createRepository();
    const result = await repo.grantAgentAccess("agent-1", {
      actorId: "actor-new",
      role: "view",
    });
    assert.equal(result.actorId, "actor-new");
    assert.equal(result.role, "view");
  });

  test("repository contract: revokeAgentAccess removes access", async () => {
    const repo = createRepository();
    await repo.revokeAgentAccess("agent-1", "actor-to-remove");
  });

  test("repository contract: listAgentAdminMembers returns admin actor IDs", async () => {
    const repo = createRepository();
    const result = await repo.listAgentAdminMembers("agent-1");
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length >= 1, "contract fixture must include at least one admin");
    for (const id of result.items) {
      assert.ok(typeof id === "string", "admin member IDs must be strings");
    }
  });

test("repository contract: getTeamDirectory returns actors and members", async () => {
    const repo = createRepository();
    const result = await repo.getTeamDirectory("team-1");

    assert.ok(Array.isArray(result.actors), "actors must be an array");
    assert.ok(Array.isArray(result.members), "members must be an array");
    assert.ok(result.actors.length >= 1, "contract fixture must include at least one actor");
    assert.ok(result.members.length >= 1, "contract fixture must include at least one member");

    const actor = result.actors[0];
    assert.deepEqual(Object.keys(actor).sort(), [
      "avatarUrl",
      "displayName",
      "id",
      "kind",
      "metadata",
      "teamId",
    ].sort());

    const member = result.members[0];
    assert.deepEqual(Object.keys(member).sort(), [
      "actorId",
      "joinedAt",
      "role",
      "teamId",
    ].sort());
  });

  test("repository contract: renameTeam updates team name", async () => {
    const repo = createRepository();
    const team = await repo.renameTeam("team-1", { name: "Updated Team Name" });
    assert.ok(team, "team should exist");
    assert.equal(team.id, "team-1");
    assert.equal(team.name, "Updated Team Name");
  });

  test("repository contract: createTeamInvite returns invite details", async () => {
    const repo = createRepository();
    const result = await repo.createTeamInvite("team-1", {
      kind: "member",
      displayName: "New User",
      teamRole: "member",
      expiresAt: null,
    });
    assert.ok(result.token, "token must be present");
    assert.equal(result.expiresAt, null);
  });

  test("repository contract: createTeamInvite accepts optional invitee contact", async () => {
    const repo = createRepository();
    // Contact is optional and member-only: supplying it lets the invitee find
    // the invite at login, but must not change the token/deeplink result shape.
    const result = await repo.createTeamInvite("team-1", {
      kind: "member",
      displayName: "New User",
      teamRole: "member",
      expiresAt: null,
      inviteEmail: "new@example.com",
      invitePhone: "13800138000",
    });
    assert.ok(result.token, "token must be present even when contact is supplied");
  });

  test("repository contract: removeTeamActor succeeds", async () => {
    const repo = createRepository();
    await repo.removeTeamActor("team-1", "actor-to-remove");
  });

  test("repository contract: getNotificationPrefs returns a snake_case prefs row or null", async () => {
    const repo = createRepository();
    const prefs = await repo.getNotificationPrefs();
    // Clients consume the raw snake_case row directly and fall back to their own
    // DEFAULT_PREFS when null. DND fields drive quiet-hours filtering.
    if (prefs !== null) {
      assert.ok(prefs.user_id === null || typeof prefs.user_id === "string");
      assert.equal(typeof prefs.enabled, "boolean");
      assert.ok("dnd_start_min" in prefs, "must expose dnd_start_min");
      assert.ok("dnd_end_min" in prefs, "must expose dnd_end_min");
      assert.ok("dnd_tz" in prefs, "must expose dnd_tz");
    }
  });

  test("repository contract: putNotificationPrefs upserts snake_case prefs incl. DND", async () => {
    const repo = createRepository();
    const input = {
      user_id: "user-1",
      enabled: false,
      dnd_start_min: 1320,
      dnd_end_min: 480,
      dnd_tz: "Asia/Shanghai",
    };
    const out = await repo.putNotificationPrefs(input);
    assert.equal(out.user_id, "user-1");
    assert.equal(out.enabled, false);
    assert.equal(out.dnd_start_min, 1320);
    assert.equal(out.dnd_end_min, 480);
    assert.equal(out.dnd_tz, "Asia/Shanghai");
  });

  test("repository contract: muteSession succeeds", async () => {
    const repo = createRepository();
    await repo.muteSession("session-1", { until: null });
  });

  test("repository contract: unmuteSession succeeds", async () => {
    const repo = createRepository();
    await repo.unmuteSession("session-1");
  });

  test("repository contract: listMutedSessions returns items", async () => {
    const repo = createRepository();
    const out = await repo.listMutedSessions();
    assert.ok(Array.isArray(out.items), "items must be an array");
    for (const id of out.items) {
      assert.ok(typeof id === "string", "muted session IDs must be strings");
    }
  });

  test("repository contract: listShortcuts returns items", async () => {
    const repo = createRepository();
    const result = await repo.listShortcuts("team-1", {});
    assert.ok(Array.isArray(result), "result must be an array");
    assert.ok(result.length >= 1, "contract fixture must include at least one shortcut");
    const shortcut = result[0];
    // snake_case row — consumed directly by the desktop client's ShortcutRow.
    // Role visibility is a separate endpoint (listShortcutRoleBindings).
    assert.deepEqual(Object.keys(shortcut).sort(), [
      "created_at",
      "icon",
      "id",
      "label",
      "node_type",
      "order",
      "owner_member_id",
      "parent_id",
      "scope",
      "target",
      "team_id",
      "updated_at",
    ].sort());
  });

  test("repository contract: createShortcut returns shortcut", async () => {
    const repo = createRepository();
    const shortcut = await repo.createShortcut({
      teamId: "team-1",
      kind: "link",
      label: "New Shortcut",
      position: 100,
    });
    assert.ok(shortcut.id, "shortcut must have id");
    assert.equal(shortcut.team_id, "team-1");
    assert.equal(shortcut.node_type, "link");
    assert.equal(shortcut.label, "New Shortcut");
  });

  test("repository contract: updateShortcut mutates label", async () => {
    const repo = createRepository();
    const shortcut = await repo.updateShortcut("shortcut-1", { label: "Updated Label" });
    assert.ok(shortcut, "shortcut should exist");
    assert.equal(shortcut.label, "Updated Label");
  });

  test("repository contract: deleteShortcut succeeds", async () => {
    const repo = createRepository();
    await repo.deleteShortcut("shortcut-1");
  });

  test("repository contract: batchMoveShortcuts succeeds", async () => {
    const repo = createRepository();
    await repo.batchMoveShortcuts({
      moves: [
        { shortcutId: "shortcut-1", parentId: null, position: 0 },
      ],
    });
  });

  test("repository contract: setShortcutVisibleRoles succeeds", async () => {
    const repo = createRepository();
    await repo.setShortcutVisibleRoles("shortcut-1", { roleIds: ["role-1"] });
  });

  test("repository contract: listTeamRoles returns items", async () => {
    const repo = createRepository();
    const result = await repo.listTeamRoles("team-1");
    assert.ok(Array.isArray(result), "result must be an array");
    assert.ok(result.length >= 1, "contract fixture must include at least one role");
    const role = result[0];
    assert.deepEqual(Object.keys(role).sort(), ["code", "id", "name", "teamId"].sort());
  });

  test("repository contract: listTeamPermissions returns items", async () => {
    const repo = createRepository();
    const result = await repo.listTeamPermissions("team-1");
    assert.ok(Array.isArray(result), "result must be an array");
    assert.ok(result.length >= 1, "contract fixture must include at least one permission");
    const perm = result[0];
    assert.ok(perm.resourceId, "permission must have resourceId");
    assert.ok(Array.isArray(perm.roleIds), "roleIds must be an array");
  });

  test("repository contract: listIdeas returns paged ideas with canonical fields", async () => {
    const repo = createRepository();
    const page = await repo.listIdeas({ teamId: "team-1", archived: false, limit: 50, cursor: null });

    assert.ok(Array.isArray(page.items));
    assert.ok(page.items.length >= 1, "contract fixture must include at least one idea");
    assert.deepEqual(Object.keys(page.items[0]).sort(), [
      "actorIds",
      "archived",
      "authorActorId",
      "createdAt",
      "description",
      "id",
      "teamId",
      "title",
      "updatedAt",
    ].sort());
  });

  test("repository contract: getIdea returns single idea", async () => {
    const repo = createRepository();
    const page = await repo.listIdeas({ teamId: "team-1", archived: false, limit: 50, cursor: null });
    const firstId = page.items[0].id;
    const idea = await repo.getIdea(firstId);
    assert.ok(idea, "idea should exist");
    assert.equal(idea.id, firstId);
  });

  test("repository contract: getIdea returns null for missing idea", async () => {
    const repo = createRepository();
    const idea = await repo.getIdea("00000000-0000-0000-0000-000000000000");
    assert.equal(idea, null);
  });

  test("repository contract: createIdea returns idea", async () => {
    const repo = createRepository();
    const idea = await repo.createIdea({
      teamId: "team-1",
      title: "Contract Idea",
      authorActorId: "actor-1",
    });
    assert.ok(idea, "idea must be returned");
    assert.equal(idea.title, "Contract Idea");
    assert.equal(idea.archived, false);
  });

  test("repository contract: updateIdea mutates title", async () => {
    const repo = createRepository();
    const page = await repo.listIdeas({ teamId: "team-1", archived: false, limit: 50, cursor: null });
    const firstId = page.items[0].id;
    const idea = await repo.updateIdea(firstId, { title: "Updated Title" });
    assert.ok(idea, "idea should exist");
    assert.equal(idea.title, "Updated Title");
  });

  test("repository contract: archiveIdea succeeds", async () => {
    const repo = createRepository();
    const page = await repo.listIdeas({ teamId: "team-1", archived: false, limit: 50, cursor: null });
    const firstId = page.items[0].id;
    await repo.archiveIdea(firstId);
  });

  test("repository contract: createIdeaActivity returns activity with canonical fields", async () => {
    const repo = createRepository();
    const activity = await repo.createIdeaActivity("idea-1", {
      kind: "comment",
      actorId: "actor-1",
      content: "test comment",
      metadata: null,
    });
    assert.ok(activity, "activity must be returned");
    assert.deepEqual(Object.keys(activity).sort(), [
      "actorId",
      "content",
      "createdAt",
      "id",
      "ideaId",
      "kind",
      "metadata",
    ].sort());
    assert.equal(activity.kind, "comment");
    assert.equal(activity.actorId, "actor-1");
  });

  test("repository contract: uploadAttachment returns path and url", async () => {
    const repo = createRepository();
    const bytes = Buffer.from("hello attachment");
    const out = await repo.uploadAttachment({ path: "contract/test.txt", mime: "text/plain", bytes });
    assert.ok(out, "result must be returned");
    assert.equal(out.path, "contract/test.txt");
    assert.ok(typeof out.url === "string" && out.url.length > 0, "url must be a non-empty string");
  });

  test("repository contract: downloadAttachment returns bytes for existing path", async () => {
    const repo = createRepository();
    const bytes = Buffer.from("roundtrip content");
    await repo.uploadAttachment({ path: "contract/roundtrip.txt", mime: "text/plain", bytes });
    const out = await repo.downloadAttachment("contract/roundtrip.txt");
    assert.ok(out, "download result must be returned");
    assert.ok(out.bytes instanceof Buffer, "bytes must be a Buffer");
    assert.ok(typeof out.mime === "string", "mime must be a string");
  });

  test("repository contract: downloadAttachment returns null for missing path", async () => {
    const repo = createRepository();
    const out = await repo.downloadAttachment("contract/does-not-exist-xyz.bin");
    assert.equal(out, null);
  });

  test("repository contract: attachments bucket is isolated from avatars bucket", async () => {
    const repo = createRepository();
    const attachmentBytes = Buffer.from("attachment payload");
    const avatarBytes = Buffer.from("avatar payload");
    await repo.uploadAttachment({ path: "iso/x.bin", mime: "application/octet-stream", bytes: attachmentBytes });
    await repo.uploadAttachment({ path: "iso/x.bin", mime: "image/png", bytes: avatarBytes, bucket: "avatars" });

    const attachmentOut = await repo.downloadAttachment("iso/x.bin");
    assert.ok(attachmentOut);
    assert.deepEqual(attachmentOut.bytes, attachmentBytes);

    const avatarOut = await repo.downloadAttachment("iso/x.bin", { bucket: "avatars" });
    assert.ok(avatarOut);
    assert.deepEqual(avatarOut.bytes, avatarBytes);

    const avatarUpload = await repo.uploadAttachment({ path: "iso/url.png", mime: "image/png", bytes: avatarBytes, bucket: "avatars" });
    assert.ok(avatarUpload.url.includes("/avatars/"), "avatars bucket url must reference avatars/");
  });

  test("repository contract: submitFeedback returns feedback object", async () => {
    const repo = createRepository();
    const out = await repo.submitFeedback({
      messageId: "00000000-0000-0000-0000-000000000001",
      actorId: "00000000-0000-0000-0000-000000000002",
      teamId: "00000000-0000-0000-0000-000000000004",
      sessionId: "00000000-0000-0000-0000-000000000003",
      kind: "positive",
      starRating: null,
      skill: null,
    });
    assert.ok(out, "result must be returned");
    assert.equal(out.messageId, "00000000-0000-0000-0000-000000000001");
    assert.equal(out.actorId, "00000000-0000-0000-0000-000000000002");
    assert.equal(out.kind, "positive");
  });

  test("repository contract: listFeedback returns items array", async () => {
    const repo = createRepository();
    const out = await repo.listFeedback({ sessionId: "00000000-0000-0000-0000-000000000003" });
    assert.ok(out, "result must be returned");
    assert.ok(Array.isArray(out.items), "items must be an array");
  });

  test("repository contract: deleteFeedback succeeds", async () => {
    const repo = createRepository();
    await repo.deleteFeedback("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002");
  });

  test("repository contract: getTeamLeaderboard returns enriched items", async () => {
    const repo = createRepository();
    const out = await repo.getTeamLeaderboard("00000000-0000-0000-0000-000000000004", { period: "week" });
    assert.ok(out, "result must be returned");
    assert.ok(Array.isArray(out.items), "items must be an array");
    if (out.items.length > 0) {
      const row = out.items[0];
      assert.deepEqual(Object.keys(row).sort(), [
        "actorId", "costUsd", "displayName", "negativeFeedback", "period",
        "positiveFeedback", "score", "sessionCount", "skillUsage", "teamId", "tokensUsed",
      ].sort());
      assert.equal(row.period, "week");
      assert.equal(typeof row.skillUsage, "object");
    }
  });

  test("repository contract: submitSessionReport stores report and skill usage", async () => {
    const repo = createRepository();
    await repo.submitSessionReport({
      actorId: "00000000-0000-0000-0000-000000000002",
      teamId: "00000000-0000-0000-0000-000000000004",
      sessionId: "00000000-0000-0000-0000-000000000003",
      tokensUsed: 1234,
      costUsd: 0.5,
      model: "claude-opus-4-8",
      agentKind: "code",
      endedAt: "2026-05-29T00:00:00Z",
      skillUsage: { "sentry-fix": 2 },
    });
  });

  test("repository contract: reportClientVersion succeeds", async () => {
    const repo = createRepository();
    await repo.reportClientVersion("team-1", {
      clientType: "tauri",
      version: "0.1.82",
      deviceId: "device-1",
      build: null,
    });
  });

  test("repository contract: submitSkillUsage succeeds", async () => {
    const repo = createRepository();
    await repo.submitSkillUsage({
      actorId: "00000000-0000-0000-0000-000000000002",
      teamId: "00000000-0000-0000-0000-000000000004",
      sessionId: null,
      skill: "superpowers:brainstorming",
      count: 1,
    });
  });

  test("repository contract: listFeedbackSummary returns items array", async () => {
    const repo = createRepository();
    const out = await repo.listFeedbackSummary("00000000-0000-0000-0000-000000000004");
    assert.ok(out, "result must be returned");
    assert.ok(Array.isArray(out.items), "items must be an array");
  });

  test("repository contract: telemetry round-trip aggregates into leaderboard + summary", async () => {
    const repo = createRepository();
    const TEAM = "00000000-0000-0000-0000-0000000000aa";
    const ACTOR = "00000000-0000-0000-0000-0000000000bb";

    await repo.submitSessionReport({
      actorId: ACTOR, teamId: TEAM, sessionId: "00000000-0000-0000-0000-0000000000c1",
      tokensUsed: 1000, costUsd: 0.5, model: "m", agentKind: "code",
      endedAt: "2026-05-29T00:00:00Z", skillUsage: { "sentry-fix": 2 },
    });
    await repo.submitSkillUsage({ actorId: ACTOR, teamId: TEAM, sessionId: null, skill: "brainstorm", count: 3 });
    await repo.submitFeedback({
      messageId: "00000000-0000-0000-0000-0000000000d1", actorId: ACTOR, teamId: TEAM,
      sessionId: "00000000-0000-0000-0000-0000000000c1", kind: "positive", starRating: null, skill: null,
    });
    await repo.submitFeedback({
      messageId: "00000000-0000-0000-0000-0000000000d2", actorId: ACTOR, teamId: TEAM,
      sessionId: "00000000-0000-0000-0000-0000000000c1", kind: "negative", starRating: null, skill: null,
    });

    const lb = await repo.getTeamLeaderboard(TEAM, { period: "week" });
    assert.ok(lb.items.length > 0, "leaderboard must include the actor after a report");
    const row = lb.items.find((r) => r.actorId === ACTOR);
    assert.ok(row, "submitted actor must appear in leaderboard");
    assert.deepEqual(Object.keys(row).sort(), [
      "actorId", "costUsd", "displayName", "negativeFeedback", "period",
      "positiveFeedback", "score", "sessionCount", "skillUsage", "teamId", "tokensUsed",
    ].sort());
    assert.equal(row.tokensUsed, 1000);
    assert.equal(row.sessionCount, 1);
    assert.equal(row.positiveFeedback, 1);
    assert.equal(row.negativeFeedback, 1);
    assert.equal(row.skillUsage["sentry-fix"], 2);
    assert.equal(row.skillUsage["brainstorm"], 3);

    const summary = await repo.listFeedbackSummary(TEAM);
    const sRow = summary.items.find((s) => s.actorId === ACTOR);
    assert.ok(sRow, "summary must include the actor");
    assert.deepEqual(Object.keys(sRow).sort(), ["actorId", "displayName", "negative", "positive", "total"].sort());
    assert.equal(sRow.positive, 1);
    assert.equal(sRow.negative, 1);
    assert.equal(sRow.total, 2);
  });

  test("repository contract: listApps returns canonical app fields", async () => {
    const repo = createRepository();
    const items = await repo.listApps({ teamId: "team-1", limit: 100 });
    assert.ok(Array.isArray(items));
    if (items.length > 0) {
      assert.deepEqual(Object.keys(items[0]).sort(), [
        "createdAt",
        "fcStatus",
        "id",
        "name",
        "provisionStatus",
        "slug",
        "teamId",
        "type",
        "updatedAt",
        "visibility",
        "workspaceId",
      ].sort());
    }
  });

  test("repository contract: getWorkspaceConfig returns an empty llm block for a fresh team", async () => {
    const repo = createRepository();
    const out = await repo.getWorkspaceConfig("team-share-fresh-2");
    assert.ok(out, "result must be returned");
    assert.ok(out.llm && typeof out.llm === "object", "llm block must be present");
    assert.equal(out.llm.enabled, false);
    assert.equal(out.llm.baseUrl, null);
    assert.deepEqual(out.llm.models, []);
  });

  test("repository contract: setLlmConfig persists and getWorkspaceConfig round-trips stored models", async () => {
    const repo = createRepository();
    const saved = await repo.setLlmConfig("team-llm-roundtrip", {
      enabled: true,
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude", name: "Claude" }],
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.baseUrl, "https://proxy.example.com/v1");
    assert.deepEqual(saved.models, [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude", name: "Claude" }]);

    const out = await repo.getWorkspaceConfig("team-llm-roundtrip");
    assert.equal(out.llm.enabled, true);
    assert.equal(out.llm.baseUrl, "https://proxy.example.com/v1");
    assert.deepEqual(out.llm.models, [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude", name: "Claude" }]);
  });
}

export function runAuthRepositoryContract({ test, assert, createAuthRepository, createRepository = createAuthRepository }) {
  test("repository contract: refreshAccessToken returns new token pair", async () => {
    const repo = createAuthRepository();
    const out = await repo.refreshAccessToken({ refreshToken: "test-refresh-token" });

    assert.ok(out.accessToken, "accessToken must be present");
    assert.ok(out.refreshToken, "refreshToken must be present");
    assert.ok(Number.isInteger(out.expiresAt), "expiresAt must be an integer");
  });

  test("repository contract: upsertAgentRuntime returns id", async () => {
    const repo = createRepository();
    const result = await repo.upsertAgentRuntime({
      agentActorId: "actor-1",
      sessionId: "session-1",
      runtimeId: "runtime-abc",
      backendSessionId: "backend-session-1",
    });
    assert.ok(result.id, "id must be present");
  });

  test("repository contract: getAgentRuntime returns null when absent", async () => {
    const repo = createRepository();
    const result = await repo.getAgentRuntime({
      sessionId: "session-missing",
      runtimeId: "runtime-missing",
      backendSessionId: "backend-missing",
    });
    assert.equal(result, null);
  });

  test("repository contract: getLatestAgentRuntime returns null when absent", async () => {
    const repo = createRepository();
    const result = await repo.getLatestAgentRuntime({
      agentId: "actor-missing",
      sessionId: "session-missing",
    });
    assert.equal(result, null);
  });

  test("repository contract: updateRuntimeCursor succeeds", async () => {
    const repo = createRepository();
    await repo.updateRuntimeCursor("runtime-row-1", { lastProcessedMessageId: "message-1" });
  });

  test("repository contract: ensureAgentTypes succeeds", async () => {
    const repo = createRepository();
    await repo.ensureAgentTypes({ supportedTypes: ["openai", "claude"], defaultAgentType: "claude" });
  });
}

function compareSessionRows(left, right) {
  const leftLast = left.lastMessageAt ?? "";
  const rightLast = right.lastMessageAt ?? "";
  if (leftLast !== rightLast) return rightLast.localeCompare(leftLast);

  const leftCreated = left.createdAt ?? "";
  const rightCreated = right.createdAt ?? "";
  if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated);

  return right.id.localeCompare(left.id);
}

function compareMessageRows(left, right) {
  if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
  return left.id.localeCompare(right.id);
}