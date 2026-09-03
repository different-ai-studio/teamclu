import type { ShortcutCreateArgs, ShortcutRow, ShortcutsBackend } from "@/lib/backend/types";
import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export function createShortcutsModule(client: CloudApiClient): ShortcutsBackend {
  return {
    async listShortcuts(scope, teamId) {
      const params = new URLSearchParams({ scope });
      if (teamId) params.set("teamId", teamId);
      const out = await client.get<{ items: ShortcutRow[] }>(`/v1/shortcuts?${params}`);
      return out.items;
    },
    async createShortcut(input: ShortcutCreateArgs) {
      const out = await client.post<{ id: string }>("/v1/shortcuts", {
        scope: input.p_scope,
        label: input.p_label,
        nodeType: input.p_node_type,
        teamId: input.p_team_id ?? null,
        parentId: input.p_parent_id ?? null,
        icon: input.p_icon ?? null,
        order: input.p_order ?? 0,
        target: input.p_target ?? "",
      });
      return out;
    },
    async updateShortcut(id, patch) {
      await client.patch<void>(`/v1/shortcuts/${encodeURIComponent(id)}`, patch);
    },
    async deleteShortcut(id) {
      await client.delete<void>(`/v1/shortcuts/${encodeURIComponent(id)}`);
    },
    async batchMove(input) {
      return client.post<unknown>("/v1/shortcuts/batch-move", input);
    },
    async setVisibleRoles(input) {
      await client.post<void>("/v1/shortcuts/set-visible-roles", input);
    },
    async listTeamRoles(teamId) {
      const out = await client.get<{ items: Array<{ id: string; teamId: string; code: string; name: string }> }>(`/v1/teams/${encodeURIComponent(teamId)}/roles`);
      return out.items.map((r) => ({ id: r.id, team_id: r.teamId, code: r.code, name: r.name }));
    },
    async listShortcutRoleBindings(teamId) {
      const out = await client.get<{
        items: Array<{ resource_id: string; permission_roles: Array<{ role_id: string }> }>;
      }>(`/v1/teams/${encodeURIComponent(teamId)}/shortcut-role-bindings`);
      return out.items ?? [];
    },
  };
}
