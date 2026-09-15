# Task 7 Report

## Fix: empty `roles[]` rollout fallback

**Issue:** `useTeamPermissions` treated `roles: []` as present and skipped legacy `role` string fallback, collapsing permissions incorrectly during rollout.

**Fix:** Treat empty `roles` array like absent — fall back to `currentMember.role`.

**Test:** `roles: []` + `role: 'owner'` → `isOwner` true.
