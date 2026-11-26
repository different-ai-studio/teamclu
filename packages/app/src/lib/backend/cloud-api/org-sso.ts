/**
 * Enterprise IM sign-in binding of the current team's org (WeCom first) —
 * Cloud API client.
 *
 * OpenAPI: getTeamOrgSsoBinding / startTeamOrgSsoInstall / deleteTeamOrgSsoBinding
 * Design: docs/specs/2026-11-26-enterprise-im-sso.md
 */

import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export type OrgSsoProvider = "wecom";

export interface OrgSsoBinding {
  tenantId: string;
  tenantName: string | null;
  createdAt: string;
}

export interface OrgSsoStatus {
  /** Whether this deployment has the provider configured server-side. */
  configured: boolean;
  binding: OrgSsoBinding | null;
}

export interface OrgSsoBackend {
  status(teamId: string, provider: OrgSsoProvider): Promise<OrgSsoStatus>;
  /** URL a company admin opens to install the TeamClu app, which binds the company. */
  installUrl(teamId: string, provider: OrgSsoProvider): Promise<string>;
  disconnect(teamId: string, provider: OrgSsoProvider): Promise<boolean>;
}

function ssoPath(teamId: string, provider: OrgSsoProvider): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/sso/${encodeURIComponent(provider)}`;
}

export function createOrgSsoModule(client: CloudApiClient): OrgSsoBackend {
  return {
    async status(teamId, provider) {
      return client.get<OrgSsoStatus>(ssoPath(teamId, provider));
    },
    async installUrl(teamId, provider) {
      const out = await client.post<{ url: string }>(`${ssoPath(teamId, provider)}/install`, {});
      return out.url;
    },
    async disconnect(teamId, provider) {
      const out = await client.delete<{ removed: boolean }>(ssoPath(teamId, provider));
      return !!out?.removed;
    },
  };
}
