//! Team share commands.
//!
//! What is left is the team encryption key and read-only status. Enabling and
//! disconnecting are gone: share mode is a server-side switch that is already on
//! for every team, and the cloud refuses to turn it back off
//! (`DELETE /v1/teams/:id/share-mode` answers 410).
//!
//! Team *creation* and *joining* used to live here too. Both were removed once
//! it was clear nothing reached them: the frontend creates teams through the
//! Cloud API provider (`lib/backend/types.ts` `createTeam`), and the join
//! command was written for a `JoinTeamFlow` component that was never built —
//! `App.tsx` still carries the `TODO(Task 12)` where it was meant to be mounted.

pub mod enable;

#[allow(unused_imports)]
pub use enable::{
    get_share_status_impl, set_team_secret_impl, team_share_get_status, team_share_set_team_secret,
};
