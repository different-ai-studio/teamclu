//! Bridge instance identity and composite route keys for claude-bridge routing.
//!
//! Each spawned Node bridge process gets a unique [`BridgeInstanceId`]. Bridge-local
//! session handles (`sess-1`, `pending-2`, …) are only unique within that process,
//! so daemon-side maps must key on `(bridge_id, session_key)`.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct BridgeInstanceId(String);

impl BridgeInstanceId {
    pub fn new_unique() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(format!(
            "bridge-{}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct BridgeRouteKey {
    pub bridge_id: BridgeInstanceId,
    pub session_key: String,
}

impl BridgeRouteKey {
    pub fn new(bridge_id: BridgeInstanceId, session_key: impl Into<String>) -> Self {
        Self {
            bridge_id,
            session_key: session_key.into(),
        }
    }

    pub fn encode(&self) -> String {
        format!("{}\x1f{}", self.bridge_id.0, self.session_key)
    }

    /// Public permission id exposed to clients: `{bridge_id}:{bridge_request_id}`.
    pub fn public_permission_id(&self, bridge_request_id: &str) -> String {
        format!("{}:{bridge_request_id}", self.bridge_id.0)
    }
}

pub(crate) fn parse_public_permission_id(id: &str) -> Option<(BridgeInstanceId, String)> {
    let (bridge, rest) = id.split_once(':')?;
    if bridge.is_empty() || rest.is_empty() {
        return None;
    }
    Some((BridgeInstanceId(bridge.to_string()), rest.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_key_encode_is_stable() {
        let id = BridgeInstanceId("bridge-1".into());
        let key = BridgeRouteKey::new(id, "sess-1");
        assert_eq!(key.encode(), "bridge-1\x1fsess-1");
    }

    #[test]
    fn public_permission_id_round_trips() {
        let key = BridgeRouteKey::new(BridgeInstanceId("bridge-9".into()), "sess-2");
        let public = key.public_permission_id("perm-3");
        assert_eq!(public, "bridge-9:perm-3");
        let (bridge, req) = parse_public_permission_id(&public).unwrap();
        assert_eq!(bridge.as_str(), "bridge-9");
        assert_eq!(req, "perm-3");
    }
}
