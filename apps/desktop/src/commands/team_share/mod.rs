//! Team share commands.
//!
//! What is left is the team encryption key and read-only status. Enabling and
//! disconnecting are gone: there is no share-mode switch any more (team sync
//! only checks the auto-sync toggle), and the cloud refuses the old
//! `DELETE /v1/teams/:id/share-mode` with 410.
//!
//! Team *creation* and *joining* used to live here too. Both were removed once
//! it was clear nothing reached them: the frontend creates teams through the
//! Cloud API provider (`lib/backend/types.ts` `createTeam`), and the join
//! command was written for a `JoinTeamFlow` component that was never built —
//! `App.tsx` still carries the `TODO(Task 12)` where it was meant to be mounted.

pub mod enable;

#[allow(unused_imports)]
pub use enable::{set_team_secret_impl, team_share_set_team_secret};
