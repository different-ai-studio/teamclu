use std::collections::HashMap;
use std::path::PathBuf;

use super::SpawnRuntimeEnv;

/// Why no execution context can be assembled when the caller names no
/// workspace and the agent has no default one. Shared so the HTTP layer can
/// tell this caller-fixable case (422) from a daemon fault (500).
pub const NO_WORKING_DIRECTORY: &str =
    "no working directory: configure a default workspace in Daemon > Workspace settings";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum IsolationDomainKey {
    Workspace(String),
    UnscopedAgent { team_id: String, actor_id: String },
}

#[derive(Clone, Debug)]
pub struct WorkspaceIdentity {
    pub workspace_id: String,
    pub workspace_root: PathBuf,
    pub team_id: Option<String>,
}

pub struct ExecutionContext {
    pub isolation_domain: IsolationDomainKey,
    pub workspace: Option<WorkspaceIdentity>,
    pub working_directory: PathBuf,
    pub spawn_env: SpawnRuntimeEnv,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProcessEnvRevision(String);

impl ProcessEnvRevision {
    pub fn from_bindings(bindings: &HashMap<String, String>) -> Self {
        Self(teamclu_runtime_env::resolved_env::fingerprint_bindings(
            bindings,
        ))
    }

    pub fn diagnostic_prefix(&self) -> &str {
        &self.0[..12]
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{IsolationDomainKey, ProcessEnvRevision};

    #[test]
    fn workspace_isolation_domain_keys_are_stable_values() {
        assert_eq!(
            IsolationDomainKey::Workspace("ws-a".into()),
            IsolationDomainKey::Workspace("ws-a".into())
        );
    }

    #[test]
    fn process_env_revision_is_independent_of_binding_insertion_order() {
        assert_eq!(
            ProcessEnvRevision::from_bindings(&HashMap::from([
                ("B".into(), "2".into()),
                ("A".into(), "1".into()),
            ])),
            ProcessEnvRevision::from_bindings(&HashMap::from([
                ("A".into(), "1".into()),
                ("B".into(), "2".into()),
            ])),
        );
    }

    #[test]
    fn process_env_revision_diagnostic_prefix_does_not_expose_values() {
        let secret = "top-secret-value";
        let revision =
            ProcessEnvRevision::from_bindings(&HashMap::from([("TOKEN".into(), secret.into())]));

        assert!(!revision.diagnostic_prefix().contains(secret));
        assert_eq!(revision.diagnostic_prefix().len(), 12);
    }
}
