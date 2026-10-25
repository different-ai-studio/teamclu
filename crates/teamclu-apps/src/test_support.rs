//! In-memory stand-ins for the three seams, for this crate's flow tests.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::{Cloud, CloudError, DaemonError, Host, LocalDaemon, Method, Surface};

/// Canned replies by exact `(method, path)`; anything else is a 404. Every
/// request is recorded with its body.
#[derive(Default)]
pub struct FakeCloud {
    replies: Mutex<HashMap<(Method, String), Result<Value, CloudError>>>,
    pub calls: Mutex<Vec<(Method, String, Option<Value>)>>,
}

impl FakeCloud {
    pub fn reply(&self, method: Method, path: &str, body: Value) {
        self.replies
            .lock()
            .unwrap()
            .insert((method, path.to_string()), Ok(body));
    }

    pub fn fail(&self, method: Method, path: &str, status: u16, body: &str) {
        self.replies.lock().unwrap().insert(
            (method, path.to_string()),
            Err(CloudError::from_response(status, body.as_bytes())),
        );
    }

    pub fn calls_to(&self, method: Method, path: &str) -> Vec<Option<Value>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p, _)| *m == method && p == path)
            .map(|(_, _, body)| body.clone())
            .collect()
    }
}

#[async_trait]
impl Cloud for FakeCloud {
    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        _timeout: Option<Duration>,
    ) -> Result<Value, CloudError> {
        self.calls
            .lock()
            .unwrap()
            .push((method, path.to_string(), body.cloned()));
        self.replies
            .lock()
            .unwrap()
            .get(&(method, path.to_string()))
            .cloned()
            .unwrap_or_else(|| {
                Err(CloudError::from_response(
                    404,
                    format!(r#"{{"error":{{"code":"not_found","message":"no fake for {path}"}}}}"#)
                        .as_bytes(),
                ))
            })
    }
}

/// A daemon whose every answer is set by the test; unset ones are "not running".
#[derive(Default)]
pub struct FakeDaemon {
    pub local: Mutex<Vec<(String, String)>>,
    pub manifest: Mutex<Option<Value>>,
    pub build: Mutex<Option<Result<Value, DaemonError>>>,
    pub seed: Mutex<Option<Result<Value, DaemonError>>>,
    pub builds: Mutex<Vec<Value>>,
    pub seeds: Mutex<Vec<Value>>,
}

fn down() -> DaemonError {
    DaemonError::unreachable("not running")
}

#[async_trait]
impl LocalDaemon for FakeDaemon {
    async fn local_apps(&self, _team_id: &str) -> Result<Vec<(String, String)>, DaemonError> {
        Ok(self.local.lock().unwrap().clone())
    }

    async fn workdir(&self, app_id: &str, _team_id: &str) -> Result<Value, DaemonError> {
        Ok(serde_json::json!({ "workdir": format!("/apps/{app_id}"), "deviceName": "test-mac" }))
    }

    async fn manifest(&self, _app_id: &str, _team_id: &str) -> Result<Value, DaemonError> {
        self.manifest.lock().unwrap().clone().ok_or_else(down)
    }

    async fn seed(&self, body: &Value, _timeout: Duration) -> Result<Value, DaemonError> {
        self.seeds.lock().unwrap().push(body.clone());
        self.seed
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Err(down()))
    }

    async fn build(&self, body: &Value, _timeout: Duration) -> Result<Value, DaemonError> {
        self.builds.lock().unwrap().push(body.clone());
        self.build
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Err(down()))
    }

    async fn inspect_dir(&self, _path: &str) -> Result<Value, DaemonError> {
        Err(down())
    }

    async fn bind_workdir(
        &self,
        _app_id: &str,
        _team_id: &str,
        dir: &str,
    ) -> Result<Value, DaemonError> {
        Ok(serde_json::json!({ "workdir": dir }))
    }

    async fn actor_id(&self) -> Option<String> {
        Some("agent-1".to_string())
    }
}

pub struct TestHost(pub Surface);

#[async_trait]
impl Host for TestHost {
    fn surface(&self) -> Surface {
        self.0
    }
}
