# App organization role auth — dev rollout acceptance

Date: 2026-10-04. Authorized after PR #1630 merge.

## Target and release

- Dev ECS: i-wz90nb0me448q3k22fxt / 47.112.210.217.
- API: https://api.teamclu-dev.ucar.cc.
- Previous server checkout: 97743d7c; deployed exact merged main: 171b95ce8c8def80bbeba620fe872232ec8ef9b6.
- Updated only the FC image/service using docker compose build fc and up -d --no-deps --pull never fc. Existing checkout advanced by fast-forward. Tracked server files were clean; unrelated untracked server files retained.
- Current image: sha256:011552839f6b5d48b773c0eff5b74b77b48363eb4f65f32a24209857f7f592b0.
- Prior image ID retained on server for rollback. No migration, application deployment, app permission/env write, or org role/member assignment was performed.

## Observed acceptance

1. FC container running/healthy; public /healthz returned {ok:true}.
2. Actual signed-in dev Cloud API getAppAuthInfo(app7) and app6 succeeded. Both returned the application's organization, active organization role directory, raw /staff required audience:org rule, and effective any_org_role policy; public baseline remained public.
3. Recompiled dev desktop's authenticated local manage_app auth_info(app7) succeeded with the explicit snake_case contract and same original/effective rules. No user list is returned.
4. Actual AppAuthTabContent in temporary dev webview subtree used real API data: organization name displayed, /staff displayed Any active organization role, Save disabled on initial load, no directory error. No save action was invoked. Duplicate bridge evaluations were cleaned by subtree removal and dev webview reload; final test roots=0 and fixture handle absent.
5. Anonymous auth-info GET returned HTTP401 missing_auth, without catalog disclosure.
6. Standard deployed self-host smoke/run-e2e.sh passed 11/11, 0 failures and 0 skips. It used its established temporary selfhost.test user/data setup and user teardown; no app6/app7 modification. Server selected bundled Supabase and used existing test dependencies.
7. Final server version and healthy status checked after E2E. Local dev webview origin remained http://127.0.0.1:1420; connection restored after automatic rebuild from merged code.

Local raw logs: /private/tmp/teamclu-role-auth-dev-rollout.log and /private/tmp/teamclu-role-auth-dev-e2e.log. Prior local role-change/persisted-rule regression evidence remains in 2026-10-04-app-role-auth-consistency.md. This rollout did not revoke live user roles or change live app rules to repeat those tests.

## CI follow-up

Main run37179555135 completed with Rust Format & Clippy failure at cargo fmt --check: a multiline assert in apps/desktop/src/commands/introspect_api/apps.rs:1689 was not formatted. Clippy did not run past this step. Lint/Typecheck/Test, daemon Linux/Windows, desktop Windows, and pgTAP tasks passed; iOS was skipped by change detection. Belayo Cloud API run37179555138 passed.

Local formatting-only commit f7ceec26 applies cargo fmt to that assertion (4 insertions/1 deletion), with cargo fmt --check and git diff --check passing. It changes no runtime logic and has not been pushed; no follow-up PR was opened without user request. Main CI is not claimed green. Dev FC runs the merged171b95ce code, not an unpublished server patch.

## Remaining limits

No new screenshot visual QA or actual native approval decline interaction was performed. No live isolated app/organization was created for mutation tests; role-change scenarios remain covered by the committed local persistent fixtures, while real rollout acceptance verifies current API/tool/UI readings and the standard self-host suite. App7's independent application-level creator check was not repaired and can still deny employee actions.
