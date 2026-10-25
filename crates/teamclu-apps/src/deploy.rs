//! `deploy` — the same legs the desktop UI runs: preflight, mint the upload
//! handle, have the local daemon build and upload the artifact, publish it.

use std::time::Duration;

use serde_json::{json, Value};

use crate::daemon::daemon_error_text;
use crate::redact::redact_deploy_secrets;
use crate::row::{app_brief, app_path, is_gitea_managed, row_id, row_str};
use crate::{AppOps, Method};

/// What the caller asked of one deploy.
#[derive(Debug, Clone, Copy, Default)]
pub struct DeployArgs {
    /// The revision carries a database migration the caller meant to ship.
    pub migration_intent: bool,
    /// Switch an app still on its old domain to its app-code domain once the
    /// deploy succeeds. A host's approval can also say yes.
    pub use_app_code_domain: bool,
}

/// A short-lived Gitea deploy key for the app's repo, as the daemon needs it.
pub struct GitCredential {
    pub remote_url: String,
    pub private_key_pem: String,
    pub deploy_key_id: Option<i64>,
}

/// Mint a deploy key for the app's Gitea repo — for a deploy's fetch, a seed's
/// push, or a download's clone.
pub async fn mint_git_credential(ops: &AppOps<'_>, app_id: &str) -> Result<GitCredential, String> {
    let cred = ops
        .get(
            &app_path(app_id, "/git-credential"),
            "Minting a deploy key for the app's repository",
        )
        .await?;
    let remote_url = row_str(&cred, "remoteUrl").unwrap_or_default().to_string();
    let private_key_pem = cred
        .get("privateKeyPem")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if remote_url.is_empty() || private_key_pem.trim().is_empty() {
        return Err("Could not mint a Gitea deploy credential for this app.".to_string());
    }
    Ok(GitCredential {
        remote_url,
        private_key_pem,
        deploy_key_id: cred.get("deployKeyId").and_then(Value::as_i64),
    })
}

/// Give a minted key back once the daemon is done with it.
///
/// The server revokes expired keys only when something asks the same repo for
/// another one, so a repo that is seeded or deployed and then left alone keeps
/// every key it was ever issued. Never fails the work it follows.
pub async fn return_git_credential(ops: &AppOps<'_>, app_id: &str, deploy_key_id: Option<i64>) {
    if let Some(key_id) = deploy_key_id {
        let _ = ops
            .cloud
            .send(
                Method::Delete,
                &app_path(app_id, &format!("/git-credential/{key_id}")),
                None,
                None,
            )
            .await;
    }
}

pub fn require_artifact_verification(build: &Value, revision: &str) -> Result<(), String> {
    let verification = build.get("artifactVerification");
    if verification.and_then(|value| row_str(value, "status")) == Some("checked")
        && verification.and_then(|value| row_str(value, "revision")) == Some(revision)
        && verification
            .and_then(|value| value.get("unknownFiles"))
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    {
        return Ok(());
    }
    let unknown = verification
        .and_then(|value| value.get("unknownFiles"))
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|files| !files.is_empty());
    Err(format!(
        "artifact_verification_unknown: selected daemon could not verify the Linux/x86_64 artifact{}; run an explicit target-runtime test before publishing",
        unknown.map(|files| format!(" ({files})")).unwrap_or_default()
    ))
}

/// How a failed deploy is reported back.
///
/// Failed builds use the normal status transition. A deploy that never got
/// past approval only withdraws its preflight: a reused preflight may already
/// belong to another window's build.
pub fn deploy_failure_request(
    token: &str,
    build_started: bool,
    reason: &str,
) -> (Method, &'static str, Value) {
    if build_started {
        (
            Method::Patch,
            "",
            json!({ "fcStatus": "deploy_error", "deployToken": token, "deployError": redact_deploy_secrets(reason) }),
        )
    } else {
        (
            Method::Delete,
            "/deploy/preflight",
            json!({ "deployToken": token }),
        )
    }
}

/// Where this deploy's build output goes, as the control plane minted it.
enum DeployHandle {
    /// Presigned OSS PUT for a code archive.
    Upload(String),
    /// Registry handle for an image, passed to the daemon verbatim.
    Push(Value),
}

impl AppOps<'_> {
    /// The checkout's required build-and-start declaration.
    async fn app_manifest(&self, app_id: &str, team_id: &str) -> Result<Value, String> {
        let out = self
            .daemon
            .manifest(app_id, team_id)
            .await
            .map_err(|e| {
                if e.unreachable {
                    "The local amuxd is not reachable, so the app's build + start declaration cannot be read.".to_string()
                } else {
                    format!(
                        "Could not read the app's build + start declaration: {}",
                        daemon_error_text(&e)
                    )
                }
            })?;
        if out.get("declaration").is_none() {
            return Err("The daemon returned no build + start declaration.".to_string());
        }
        Ok(out)
    }

    /// Everything after `/deploy` has minted the upload handle: credential the
    /// build, run it, hand the credential back, publish.
    #[allow(clippy::too_many_arguments)]
    async fn finish_deploy(
        &self,
        app_id: &str,
        team_id: &str,
        via_gitea: bool,
        git_commit_sha: Option<String>,
        revision: &str,
        deploy_token: &str,
        handle: &DeployHandle,
    ) -> Result<Value, String> {
        let credential = if via_gitea {
            Some(mint_git_credential(self, app_id).await?)
        } else {
            None
        };

        let mut build_body = json!({
            "appId": app_id,
            "teamId": team_id,
            "revision": revision,
        });
        match handle {
            DeployHandle::Upload(url) => build_body["presignedPut"] = json!(url),
            DeployHandle::Push(image) => build_body["image"] = image.clone(),
        }
        if let Some(cred) = &credential {
            build_body["gitRemoteUrl"] = json!(cred.remote_url);
            build_body["deployKeyPem"] = json!(cred.private_key_pem);
            if let Some(sha) = &git_commit_sha {
                build_body["gitCommitSha"] = json!(sha);
            }
        }

        // 20 minutes for an archive: the daemon allows a `pnpm install` plus a
        // 10-minute `pnpm build`, and a client timeout shorter than the work it
        // waits on turns a slow build into a phantom failure — one that has
        // already uploaded the artifact. A container build cross-compiles for
        // linux/amd64 through emulation and then pushes an image; the daemon's
        // own bounds (30 + 15) are what should decide.
        let build_timeout = match handle {
            DeployHandle::Upload(_) => Duration::from_secs(20 * 60),
            DeployHandle::Push(_) => Duration::from_secs(50 * 60),
        };
        let build = self.daemon.build(&build_body, build_timeout).await;

        // The daemon only needs the key for the fetch inside the build; hand it
        // back whether that succeeded or not, exactly as the desktop's
        // `finally` does.
        if let Some(cred) = &credential {
            return_git_credential(self, app_id, cred.deploy_key_id).await;
        }
        let build = build.map_err(|e| {
            if e.unreachable {
                "The local amuxd is not connected, so nothing can build this app.".to_string()
            } else {
                format!("Daemon build failed: {}", daemon_error_text(&e))
            }
        })?;
        let declaration = build
            .get("declaration")
            .ok_or("The daemon build response did not include the build + start declaration.")?;
        if row_str(&build, "revision") != Some(revision)
            || (via_gitea && row_str(&build, "gitCommitSha") != Some(revision))
        {
            return Err(
                "daemon built a different revision than preflight; publish stopped".to_string(),
            );
        }
        require_artifact_verification(&build, revision)?;

        // What the daemon built, not what we asked for: a deploy publishes work
        // the agent left uncommitted, so HEAD can sit past the sha read off
        // Gitea before any of this started.
        let built_sha = row_str(&build, "gitCommitSha")
            .map(str::to_string)
            .or(git_commit_sha);

        let mut finalize_body = json!({ "deployToken": deploy_token, "revision": revision });
        if let Some(sha) = built_sha {
            finalize_body["gitCommitSha"] = json!(sha);
        }
        // What the app declared, and — for a container app — the image that
        // build actually pushed, so the deploy finalizes on the app's own
        // declaration rather than the built-in contract.
        finalize_body["declaration"] = declaration.clone();
        if let Some(image) = row_str(&build, "image") {
            finalize_body["image"] = json!(image);
        }
        // Finalize provisions the schema and points the function at the
        // artifact. The UI waits for it with no timeout at all; giving up at a
        // 30 s client default reported a deploy the server went on to finish as
        // a failure, and wrote `deploy_error` over it.
        self.call(
            Method::Post,
            &app_path(app_id, "/deploy/finalize"),
            Some(&finalize_body),
            Some(Duration::from_secs(5 * 60)),
            "Publishing the build (deploy finalize)",
        )
        .await
    }

    /// Publish the app's checkout. Replies `{ ok, action: "deploy", app }`.
    ///
    /// A failure after `/deploy` must report `deploy_error` back: nothing
    /// server-side can observe that the local build never finished, and a row
    /// left at `awaiting_build` blocks every later deploy for 30 minutes.
    pub async fn deploy(&self, row: &Value, args: DeployArgs) -> Result<Value, String> {
        let deployed = self.run_deploy(row, args).await;
        // Refresh after success or a rejected attempt alike.
        self.host.app_changed(row);
        Ok(json!({ "ok": true, "action": "deploy", "app": app_brief(&deployed?) }))
    }

    async fn run_deploy(&self, row: &Value, args: DeployArgs) -> Result<Value, String> {
        let app_id = row_id(row)?;
        let team_id = row_str(row, "teamId").unwrap_or_default().to_string();
        let provision = row_str(row, "provisionStatus").unwrap_or_default();
        if provision != "ready" {
            return Err(format!(
                "This app is not ready to deploy (provisionStatus={provision}). Its checkout has to be seeded first ({}).",
                self.surface().step("manage_app", "reseed")
            ));
        }
        let via_gitea = is_gitea_managed(row);

        // Only a Gitea-managed app deploys a commit off the forge. An app
        // imported from someone else's repo has no repo of ours and no
        // credential for the one it came from, so it deploys its checkout as
        // it sits.
        let mut git_commit_sha: Option<String> = None;
        if via_gitea {
            let head = self
                .get(
                    &app_path(&app_id, "/git-head"),
                    "Reading the repository HEAD",
                )
                .await?;
            let sha = row_str(&head, "sha")
                .ok_or("The app's Gitea repo has no HEAD — commit and push before deploying.")?;
            git_commit_sha = Some(sha.to_string());
        }

        // Read before the deploy is minted, not after: a container app is
        // handed a registry to push to and every other app a presigned URL to
        // upload to, and only the machine holding the checkout can say which.
        let manifest = self.app_manifest(&app_id, &team_id).await?;
        let declaration = &manifest["declaration"];
        row_str(&declaration["build"], "kind")
            .ok_or("The daemon's app declaration has no build.kind.")?;
        if via_gitea
            && (manifest["clean"] != true
                || row_str(&manifest, "gitCommitSha") != git_commit_sha.as_deref())
        {
            return Err(
                "commit and push all changes; checkout HEAD must equal Gitea HEAD before deploy"
                    .to_string(),
            );
        }
        let revision = if via_gitea {
            git_commit_sha.as_deref()
        } else {
            row_str(&manifest, "contentDigest")
        }
        .ok_or("The daemon manifest did not include a source revision.")?
        .to_string();
        let mut start_body = json!({ "revision": revision, "declaration": declaration, "migrationIntent": args.migration_intent });
        if let Some(sha) = &git_commit_sha {
            start_body["gitCommitSha"] = json!(sha);
        }
        let preflight = self
            .call(
                Method::Post,
                &app_path(&app_id, "/deploy/preflight"),
                Some(&start_body),
                Some(Duration::from_secs(60)),
                "Checking deployment configuration",
            )
            .await?;
        let preflight_token = row_str(&preflight, "token").ok_or("preflight returned no token")?;
        let mut build_started = false;
        let result = async {
            let switch_domain = self.host.approve_deploy(row, &preflight["preview"]).await?;
            // Absent keeps whatever domain the app is on; only a yes is sent.
            if switch_domain || args.use_app_code_domain {
                start_body["useAppCodeDomain"] = json!(true);
            }
            start_body["preflightToken"] = json!(preflight_token);
            let started = self
                .call(
                    Method::Post,
                    &app_path(&app_id, "/deploy"),
                    Some(&start_body),
                    Some(Duration::from_secs(60)),
                    "Starting the deploy (needs admin on the app)",
                )
                .await?;
            build_started = true;
            let deploy_token = row_str(&started, "deployToken")
                .unwrap_or_default()
                .to_string();
            let handle = match started.get("image").filter(|v| v.is_object()) {
                Some(image) => DeployHandle::Push(image.clone()),
                None => {
                    let url = row_str(&started, "presignedPut").unwrap_or_default();
                    if url.is_empty() {
                        return Err("deploy start returned no upload handle".to_string());
                    }
                    DeployHandle::Upload(url.to_string())
                }
            };
            if deploy_token.is_empty() {
                return Err("deploy start returned no deploy token".to_string());
            }

            self.finish_deploy(
                &app_id,
                &team_id,
                via_gitea,
                git_commit_sha,
                &revision,
                &deploy_token,
                &handle,
            )
            .await
        }
        .await;
        if let Err(reason) = &result {
            let reason = redact_deploy_secrets(reason);
            let (method, path, body) =
                deploy_failure_request(preflight_token, build_started, &reason);
            let _ = self
                .cloud
                .send(
                    method,
                    &app_path(&app_id, path),
                    Some(&body),
                    Some(Duration::from_secs(10)),
                )
                .await;
        }
        result.map_err(|reason| redact_deploy_secrets(&reason))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{FakeCloud, FakeDaemon, TestHost};
    use crate::{DaemonError, Surface};

    #[test]
    fn approval_cancellation_only_withdraws_preflight() {
        let (method, path, body) =
            deploy_failure_request("shared-token", false, "approval timed out");
        assert_eq!(method, Method::Delete);
        assert_eq!(path, "/deploy/preflight");
        assert_eq!(body, json!({"deployToken": "shared-token"}));
        let (method, path, body) = deploy_failure_request("shared-token", true, "build failed");
        assert_eq!(method, Method::Patch);
        assert_eq!(path, "");
        assert_eq!(
            body,
            json!({"deployToken": "shared-token", "fcStatus": "deploy_error", "deployError": "build failed"})
        );
    }

    #[test]
    fn unknown_or_missing_artifact_verification_cannot_finalize() {
        for build in [
            json!({"artifactVerification":{"status":"unknown","unknownFiles":["native.so"]}}),
            json!({}),
        ] {
            let error = require_artifact_verification(&build, "abc").unwrap_err();
            assert!(
                error.contains("artifact_verification_unknown") && error.contains("Linux/x86_64"),
                "{error}"
            );
        }
        assert!(require_artifact_verification(&json!({"artifactVerification":{"status":"checked", "revision":"abc", "unknownFiles":[]}}), "abc").is_ok());
        assert!(require_artifact_verification(&json!({"artifactVerification":{"status":"checked", "revision":"other", "unknownFiles":[]}}), "abc").is_err());
    }

    /// An imported app: no Gitea leg, the revision is the content digest.
    fn imported_row() -> Value {
        json!({ "id": "a1", "teamId": "t1", "provisionStatus": "ready", "gitAuthKind": Value::Null })
    }

    fn deploy_world() -> (FakeCloud, FakeDaemon) {
        let cloud = FakeCloud::default();
        cloud.reply(
            Method::Post,
            "/v1/apps/a1/deploy/preflight",
            json!({ "token": "pf-1", "preview": {} }),
        );
        cloud.reply(
            Method::Post,
            "/v1/apps/a1/deploy",
            json!({ "deployToken": "pf-1", "presignedPut": "https://oss/put?Signature=s" }),
        );
        cloud.reply(
            Method::Post,
            "/v1/apps/a1/deploy/finalize",
            json!({ "id": "a1", "fcStatus": "live", "publicUrl": "https://a1.apps" }),
        );
        let daemon = FakeDaemon::default();
        *daemon.manifest.lock().unwrap() = Some(json!({
            "declaration": { "build": { "kind": "node" }, "start": {} },
            "clean": true, "contentDigest": "sha256:d",
        }));
        (cloud, daemon)
    }

    #[tokio::test]
    async fn an_imported_app_deploys_its_checkout_end_to_end() {
        let (cloud, daemon) = deploy_world();
        *daemon.build.lock().unwrap() = Some(Ok(json!({
            "declaration": { "build": { "kind": "node" } },
            "revision": "sha256:d",
            "artifactVerification": { "status": "checked", "revision": "sha256:d", "unknownFiles": [] },
        })));
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);

        let out = ops.deploy(&imported_row(), DeployArgs::default()).await.unwrap();
        assert_eq!(out["app"]["url"], "https://a1.apps");
        let build = daemon.builds.lock().unwrap()[0].clone();
        assert_eq!(build["presignedPut"], "https://oss/put?Signature=s");
        assert!(build.get("deployKeyPem").is_none());
        let finalize = cloud.calls_to(Method::Post, "/v1/apps/a1/deploy/finalize");
        assert_eq!(
            finalize[0].as_ref().unwrap()["declaration"]["build"]["kind"],
            "node"
        );
    }

    #[tokio::test]
    async fn a_failed_build_is_written_back_without_the_upload_url() {
        let (cloud, daemon) = deploy_world();
        cloud.reply(Method::Patch, "/v1/apps/a1", json!({}));
        *daemon.build.lock().unwrap() = Some(Err(DaemonError::failed(
            "PUT https://oss/put?Signature=s returned 403",
        )));
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);

        let err = ops.deploy(&imported_row(), DeployArgs::default()).await.unwrap_err();
        assert!(!err.contains("Signature="), "{err}");
        let patch = cloud.calls_to(Method::Patch, "/v1/apps/a1");
        let body = patch[0].as_ref().unwrap();
        assert_eq!(body["fcStatus"], "deploy_error");
        assert!(!body["deployError"].as_str().unwrap().contains("Signature="));
    }

    #[tokio::test]
    async fn a_refused_approval_only_withdraws_the_preflight() {
        struct Refuses;
        #[async_trait::async_trait]
        impl crate::Host for Refuses {
            fn surface(&self) -> Surface {
                Surface::Mcp
            }
            async fn approve_deploy(&self, _: &Value, _: &Value) -> Result<bool, String> {
                Err("The user declined.".to_string())
            }
        }
        let (cloud, daemon) = deploy_world();
        cloud.reply(Method::Delete, "/v1/apps/a1/deploy/preflight", json!({}));
        let ops = AppOps::new(&cloud, &daemon, &Refuses);

        let err = ops.deploy(&imported_row(), DeployArgs::default()).await.unwrap_err();
        assert_eq!(err, "The user declined.");
        assert!(cloud
            .calls_to(Method::Post, "/v1/apps/a1/deploy")
            .is_empty());
        assert_eq!(
            cloud
                .calls_to(Method::Delete, "/v1/apps/a1/deploy/preflight")
                .len(),
            1
        );
        assert!(daemon.builds.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unseeded_app_is_refused_with_this_surface_s_next_step() {
        let cloud = FakeCloud::default();
        let daemon = FakeDaemon::default();
        let host = TestHost(Surface::Cli);
        let ops = AppOps::new(&cloud, &daemon, &host);
        let row = json!({ "id": "a1", "provisionStatus": "pending" });
        let err = ops.deploy(&row, DeployArgs::default()).await.unwrap_err();
        assert!(err.contains("`amuxd app reseed`"), "{err}");
    }
}
