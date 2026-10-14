import type { CloudApiClient } from "@/lib/backend/cloud-api/http";

export interface DocumentLibraryRole {
  id: string;
  code: string;
  name: string;
  status: "active" | "inactive";
}

export interface DocumentLibrary {
  id: string;
  pathPrefix: string;
  audience: "roles" | "actors";
  roles: DocumentLibraryRole[];
  actorIds: string[];
  affectedFiles?: number;
  affectedMembers?: number;
}

export interface DocumentLibraryImpact {
  pathPrefix: string;
  affectedFiles: number;
  affectedMembers: number;
}

export interface DocumentLibrariesBackend {
  listDocumentLibraries(teamId: string): Promise<DocumentLibrary[]>;
  previewDocumentLibrary(
    teamId: string,
    input: { pathPrefix: string; roleIds: string[] },
  ): Promise<DocumentLibraryImpact>;
  createDocumentLibrary(
    teamId: string,
    input: { pathPrefix: string; roleIds: string[]; confirmRevokeExisting?: boolean },
  ): Promise<DocumentLibrary>;
  putDocumentLibrary(
    teamId: string,
    aclId: string,
    input: { roleIds: string[]; confirmRevokeExisting?: boolean },
  ): Promise<DocumentLibrary>;
  deleteDocumentLibrary(teamId: string, aclId: string): Promise<void>;
}

export function createDocumentLibrariesModule(client: CloudApiClient): DocumentLibrariesBackend {
  const basePath = (teamId: string) =>
    `/v1/teams/${encodeURIComponent(teamId)}/document-libraries`;
  const rulePath = (teamId: string, aclId: string) =>
    `${basePath(teamId)}/${encodeURIComponent(aclId)}`;

  return {
    async listDocumentLibraries(teamId) {
      const out = await client.get<{ items: DocumentLibrary[] }>(basePath(teamId));
      return out.items ?? [];
    },

    async previewDocumentLibrary(teamId, input) {
      return client.post<DocumentLibraryImpact>(`${basePath(teamId)}/preview`, input);
    },

    async createDocumentLibrary(teamId, input) {
      return client.post<DocumentLibrary>(basePath(teamId), input);
    },

    async putDocumentLibrary(teamId, aclId, input) {
      return client.put<DocumentLibrary>(rulePath(teamId, aclId), input);
    },

    async deleteDocumentLibrary(teamId, aclId) {
      await client.delete<void>(rulePath(teamId, aclId));
    },
  };
}
