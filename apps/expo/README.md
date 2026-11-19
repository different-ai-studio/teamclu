# TeamClu Expo

Expo workspace for the current mobile onboarding + sessions slice of TeamClu.

## Current scope

This package is no longer a bare scaffold. It is an `expo-router` app with the
current onboarding and sessions flow under `apps/expo/app/`:

- `/`
- `/welcome`
- `/auth`
- `/create-team`
- `/(app)/home`
- `/(app)/sessions`
- `/(app)/sessions/[sessionId]`

The runtime state lives in `src/features/onboarding/` and
`src/features/sessions/`, while the Supabase bootstrap lives in
`src/lib/supabase/`.

Public routes handle bootstrap, auth, and team creation. Once onboarding state
reaches `ready`, the root layout sends the user into `/(app)/sessions`.

## Authenticated routes

This package now covers the following authenticated route surface:

- `/(app)/home` is a compatibility redirect to `/(app)/sessions`.
- `/(app)/sessions` is the authenticated landing route. It loads real sessions
  for the current team, groups them by recency, renders loading, empty, error,
  refresh, and selected-row states, and keeps the current new-session action as
  a placeholder.
- `/(app)/sessions/[sessionId]` renders session detail metadata plus a
  realtime-capable message history. The screen shows the session title, recent
  preview/summary, participant count, created/updated timestamps, session ID,
  the persisted message timeline for that session, a live composer, optimistic
  local send, and MQTT-delivered `message.created` updates for subsequent
  replies.

## Not Yet Migrated

The Expo sessions work now reaches list + detail metadata + message timeline +
text send + realtime reply updates.
These pieces are still intentionally out of scope:

- session creation flow; the current new-session action is still a placeholder
- realtime updates for the session list surface itself
- tool-call-specific and other non-displayable message rendering still falls
  back to generic placeholder text on mobile
- broader post-onboarding workspace surfaces beyond the sessions list/detail shell

The app entrypoint is `expo-router/entry` from `apps/expo/package.json`, so
route/layout changes should be made in the `app/` directory.

## Requirements

- Node `>=20`
- `pnpm@10.33.0`
- Xcode + iOS Simulator for `expo run:ios`
- Android Studio + emulator/device for `expo run:android`

## Environment

```sh
cp apps/expo/.env.example apps/expo/.env
```

- `EXPO_PUBLIC_CLOUD_API_URL` — **required**; the template already carries the
  right value
- `EXPO_PUBLIC_MQTT_URL` — optional, only when pinning a broker for local
  development
- `EXPO_TOKEN` — only for `eas build` / publishing; leave blank otherwise

EAS builds ignore `.env` entirely — their values come from the `env` block of
each profile in `eas.json`. Keep the two in step: a `.env` that has drifted
breaks only LOCAL builds, so cloud builds keep passing and nobody notices. That
is exactly how a `.env` left over from before the teamclaw → teamclu rename
survived — it still named `api.teamclaw-dev.ucar.cc`, a host whose DNS record
was deliberately deleted, so the local Android build compiled, installed, and
failed only when someone tapped sign-in.

`EXPO_PUBLIC_CLOUD_API_URL` is the one that must be set. Without it the app
throws on its first render (`EXPO_PUBLIC_CLOUD_API_URL is required (cloud_api is
the only backend)`) rather than falling back to a limited onboarding shell.

`EXPO_PUBLIC_*` values are inlined at bundle time, so **restart Metro after
editing `.env`** — an already-running dev server keeps serving the old values.

The MQTT broker address is **not** bundled: `resolveMqttUrl` fetches it from
`GET /v1/config/bootstrap` (server-side `MQTT_PUBLIC_TCP_BROKER_URL` /
`MQTT_BROKER_URL`) and caches it in AsyncStorage, so a broker that moves
does not need an app release. `EXPO_PUBLIC_MQTT_URL` overrides the fetch; with
neither an override nor a cached address the app simply does not connect. The
native Android bridge is used when available.

## Install

From the repo root:

```sh
pnpm install
```

## Commands

From the repo root:

```sh
pnpm expo:dev
pnpm expo:test
pnpm expo:ios
pnpm expo:android
pnpm test:all
```

From `apps/expo/` directly:

```sh
pnpm dev
pnpm test
pnpm ios
pnpm android
```

## What Each Command Does

- `pnpm expo:dev` starts Expo Router + Metro for the mobile workspace.
- `pnpm expo:test` runs the full Expo Vitest suite in `apps/expo/src/test/`.
- `pnpm expo:ios` builds/runs the native iOS target with `expo run:ios`.
- `pnpm expo:android` builds/runs the native Android target with `expo run:android`.
- `pnpm test:all` runs the existing desktop unit suite first, then the Expo suite.

For mobile-only validation in this monorepo, prefer `pnpm expo:test`. The
repo-root `pnpm test` command still targets the existing desktop unit surface,
and `pnpm test:all` can stop before the Expo leg if unrelated desktop tests are
already failing.

When `pnpm expo:dev` is running, Expo CLI exposes the normal shortcuts:

- `i` to open the iOS simulator
- `a` to open Android
- `w` to open the web preview

## Verification Status

Verified locally in this workspace on 2026-05-18:

- `pnpm install`
- `pnpm expo:test`
- `pnpm expo:dev` starts Metro successfully for the router-based app

Current known warning from `pnpm expo:dev`:

- Expo reports version compatibility warnings for `@types/react`,
  `babel-preset-expo`, and `typescript` in the current workspace install. This
  task does not change those dependency versions; it only documents the current
  run workflow as observed.

Not fully verified in this session:

- `pnpm expo:ios`
- `pnpm expo:android`

Those native run commands require a usable simulator/emulator or attached
device plus the matching local platform toolchain. If you are validating the
full manual flow, use this checklist:

1. Run `pnpm expo:dev`.
2. Open iOS with `i` or Android with `a`.
3. Confirm the app boots into the onboarding router flow.
4. Walk through welcome, auth, create-team, and sessions screens with valid
   Supabase env vars.
5. Confirm the app lands on `/(app)/sessions` after auth/bootstrap.
6. Open one session detail route and confirm it shows preview, participant
   count, timestamps, session id, message history, and an active composer when
   MQTT env is configured.
7. Send one text message and confirm it appears immediately in the timeline.
8. Confirm a later `message.created` reply from another actor appears in the
   same detail route without a manual refresh.
9. Tap the new-session placeholder and confirm the feedback appears.
