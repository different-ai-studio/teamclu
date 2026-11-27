/**
 * Enterprise IM sign-in binding of the current team's org (WeCom first) —
 * Cloud API client.
 *
 * OpenAPI: getTeamOrgSsoBinding / startTeamOrgSsoInstall / deleteTeamOrgSsoBinding,
 * startTeamOrgSsoDirectoryAuth / syncTeamOrgSsoDirectory
 * Design: docs/specs/2026-11-26-enterprise-im-sso.md,
 * docs/specs/2026-11-26-wecom-customized-app-names.md
 */

import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export type OrgSsoProvider = "wecom";

export interface OrgSsoBinding {
  tenantId: string;
  tenantName: string | null;
  createdAt: string;
}

/** The bound company's authorization of the WeCom 代开发 app that reads member names. */
export interface OrgSsoDirectory {
  /** WeCom currently lets TeamClu read names (「姓名」 granted, app live). */
  namesGranted: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface OrgSsoStatus {
  /** Whether this deployment has the provider configured server-side. */
  configured: boolean;
  binding: OrgSsoBinding | null;
  /** Whether member names are configured server-side (older servers omit it). */
  directoryConfigured?: boolean;
  directory?: OrgSsoDirectory | null;
}

export interface OrgSsoBackend {
  status(teamId: string, provider: OrgSsoProvider): Promise<OrgSsoStatus>;
  /** URL a company admin opens to install the TeamClu app, which binds the company. */
  installUrl(teamId: string, provider: OrgSsoProvider): Promise<string>;
  disconnect(teamId: string, provider: OrgSsoProvider): Promise<boolean>;
  /** Link to render as a QR code; a WeCom admin scans it to authorize member names. */
  directoryAuthLink(teamId: string): Promise<{ qrcodeUrl: string; expiresAt: string }>;
  /** Re-check the names grant and fill placeholder names now. */
  syncDirectory(teamId: string): Promise<{ directory: OrgSsoDirectory | null; updated: number }>;
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
    async directoryAuthLink(teamId) {
      return client.post<{ qrcodeUrl: string; expiresAt: string }>(`${ssoPath(teamId, "wecom")}/directory`, {});
    },
    async syncDirectory(teamId) {
      return client.post<{ directory: OrgSsoDirectory | null; updated: number }>(`${ssoPath(teamId, "wecom")}/directory/sync`, {});
    },
  };
}
