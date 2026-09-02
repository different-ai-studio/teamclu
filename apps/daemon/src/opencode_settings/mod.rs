//! In-daemon OpenCode **settings** HTTP surface.
//!
//! Provider OAuth and auth-method discovery acquire the workspace domain's
//! current pooled `opencode serve` generation (`?directory=<workspace>`).
//! OpenCode data (OAuth, DB, cache) still lives under the user's default paths.

mod client;
mod pool;

pub use client::{LiveProviderCatalog};
pub use pool::{OpenCodeSettingsService, WorkspaceSettingsContextResolver};

use std::path::Path;

use crate::config::provider_auth::{merge_live_provider_auth_methods, ProviderAuthMethodsResponse};

#[derive(Debug)]
pub enum OpenCodeSettingsError {
    OpencodeBinaryMissing(String),
    SpawnFailed(String),
    StartTimeout,
    Http(String),
    Api { status: u16, detail: String },
}

impl std::fmt::Display for OpenCodeSettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpencodeBinaryMissing(msg) => write!(f, "opencode binary not found: {msg}"),
            Self::SpawnFailed(msg) => write!(f, "failed to start opencode serve: {msg}"),
            Self::StartTimeout => write!(f, "opencode serve did not become ready in time"),
            Self::Http(msg) => write!(f, "opencode settings http: {msg}"),
            Self::Api { status, detail } => write!(f, "opencode settings api {status}: {detail}"),
        }
    }
}

impl std::error::Error for OpenCodeSettingsError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_binary_missing() {
        let e = OpenCodeSettingsError::OpencodeBinaryMissing("opencode".into());
        let s = e.to_string();
        assert!(s.contains("opencode binary not found"));
        assert!(s.contains("opencode"));
    }

    #[test]
    fn display_spawn_failed() {
        let e = OpenCodeSettingsError::SpawnFailed("permission denied".into());
        let s = e.to_string();
        assert!(s.contains("failed to start opencode serve"));
        assert!(s.contains("permission denied"));
    }

    #[test]
    fn display_start_timeout() {
        let s = OpenCodeSettingsError::StartTimeout.to_string();
        assert!(s.contains("ready"));
    }

    #[test]
    fn display_http_error() {
        let e = OpenCodeSettingsError::Http("connection refused".into());
        assert!(e.to_string().contains("connection refused"));
    }

    #[test]
    fn display_api_error() {
        let e = OpenCodeSettingsError::Api {
            status: 422,
            detail: "invalid provider".into(),
        };
        let s = e.to_string();
        assert!(s.contains("422"));
        assert!(s.contains("invalid provider"));
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OAuthAuthorizeResult {
    pub url: String,
    pub method: String,
    pub instructions: String,
}

impl OpenCodeSettingsService {
    pub async fn provider_auth_methods(
        &self,
        workspace: &Path,
    ) -> Result<ProviderAuthMethodsResponse, OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        let live = client.fetch_provider_auth_methods().await?;
        Ok(merge_live_provider_auth_methods(live))
    }

    pub async fn oauth_authorize(
        &self,
        workspace: &Path,
        provider_id: &str,
        method_index: u32,
        inputs: &std::collections::HashMap<String, String>,
    ) -> Result<OAuthAuthorizeResult, OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client
            .oauth_authorize(provider_id, method_index, inputs)
            .await
    }

    pub async fn oauth_callback(
        &self,
        workspace: &Path,
        provider_id: &str,
        method_index: u32,
        code: Option<&str>,
    ) -> Result<(), OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client.oauth_callback(provider_id, method_index, code).await
    }

    pub async fn provider_catalog(
        &self,
        workspace: &Path,
    ) -> Result<LiveProviderCatalog, OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client.fetch_provider_catalog().await
    }

    pub async fn remove_provider_auth(
        &self,
        workspace: &Path,
        provider_id: &str,
    ) -> Result<(), OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client.remove_auth(provider_id).await
    }

    pub async fn connected_provider_ids(
        &self,
        workspace: &Path,
    ) -> Result<Vec<String>, OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client.fetch_connected_provider_ids().await
    }

    /// Device-level counterparts of the above (no workspace) — see
    /// [`pool::WorkspaceSettingsContextResolver::resolve_device_settings_context`].
    /// Provider OAuth state lives under the user's global OpenCode paths
    /// regardless of directory, so connecting a provider should not require
    /// a project workspace to already exist and resolve, any more than the
    /// device-level API-key path (#742) does.
    pub async fn device_provider_auth_methods(
        &self,
    ) -> Result<ProviderAuthMethodsResponse, OpenCodeSettingsError> {
        let client = self.client_for_device().await?;
        let live = client.fetch_provider_auth_methods().await?;
        Ok(merge_live_provider_auth_methods(live))
    }

    pub async fn device_oauth_authorize(
        &self,
        provider_id: &str,
        method_index: u32,
        inputs: &std::collections::HashMap<String, String>,
    ) -> Result<OAuthAuthorizeResult, OpenCodeSettingsError> {
        let client = self.client_for_device().await?;
        client
            .oauth_authorize(provider_id, method_index, inputs)
            .await
    }

    pub async fn device_oauth_callback(
        &self,
        provider_id: &str,
        method_index: u32,
        code: Option<&str>,
    ) -> Result<(), OpenCodeSettingsError> {
        let client = self.client_for_device().await?;
        client.oauth_callback(provider_id, method_index, code).await
    }
}
