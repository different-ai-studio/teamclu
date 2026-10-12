---
name: app-auth
description: Use when implementing TeamClu platform sign-in, organization-role access, employee pages or protected data endpoints in an app, or changing its login permissions.
---

# TeamClu app identity and access

Platform login and application-owned login are separate. Keep an applicant's mock SMS session if requested; do not replace it with platform login. Platform login runs at the gateway, not in a new employee password system.

Before changing login permissions, call `manage_app auth_info` for the selected app. Use its organization, organization-scoped active role **codes**, raw rules, and effective policies. If discovery fails or the organization is unconfigured, report that and stop role configuration; an unavailable catalog is not an empty catalog.

Choose the intended required audience explicitly: `roles: []` admits any signed-in user; `audience: "org"` with no `roles` admits any current or future active organization role; a nonempty `roles` array admits one of those selected codes. Explicit `roles` wins over rule audience, then the app default. Preserve untouched raw rules, including inherited defaults, when replacing the full list. Do not add a fixed User ID allowlist for organization-role permissions. The gateway checks current active organization roles on each matching request; do not rebuild that decision with an app-side member list. App code consumes the trusted platform identity on gateway-protected requests. App creators and collaborators do not automatically pass the site's role check; `manage_app_access` manages collaborators, not visitors.

Check page URLs and the **actual data endpoints** separately. Longest matching path prefix wins; a protected page does not protect an unmatched data request. Public and employee flows may share Server Functions: inspect their actual routes and checks, and preserve public access rather than locking the shared prefix wholesale. No particular employee endpoint path is required.

Use the existing permission update tool and native approval, then call `auth_info` again to compare persisted raw rules and effective audiences with the intent. Verify public and restricted requests, including a visitor without a matching role. A rejected update leaves the previous policy in place; do not report success from a proposed patch or bypass approval. These access checks do not authorize publishing or changing role assignments.

## Identity is not authorization

`X-Teamclu-User-Id` is the authenticated platform user ID, not an actor ID. `created_by_actor_id` names the app creator's actor; never compare it with that header or embed it as an employee ID. Email, browser IDs and client-provided role claims do not authorize staff. A gateway identity proves who made this request; it only proves employee admission when this exact endpoint has the required employee policy.

“Creator has employee access” is a business requirement, not an automatic organization-role grant. `owner` is an organization role, not necessarily the app creator. Use supported control-plane policies and verified facts to express the intended audience. If creator-only access cannot be represented or its role eligibility cannot be established with available tools, explain the limitation and clarify the policy; do not substitute all signed-in users, guess an identity mapping, or add a static creator/member allowlist. Never change organization role assignments implicitly.

## Employee endpoint example

Protect `/staff` and `/api/staff` with the same intended role codes, discovered through `auth_info`, before publishing. `/api/staff` is a path prefix; protect all employee reads and mutations below it. Public applicant endpoints stay separate. Do not lock the shared `/_serverFn` prefix when it also serves applicants, and do not leave employee Server Functions exposed there. Inspect the actual request URLs.

For the TanStack Start data template, an employee read route can use this shape in `src/routes/api.staff.applications.ts`:

```ts
import { createFileRoute } from '@tanstack/react-router'
import { visitorFrom } from '../lib/platform-auth'
import { sql } from '../db'

export const Route = createFileRoute('/api/staff/applications')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // PRECONDITION: this exact endpoint has the employee role policy.
        // Platform ingress strips spoofed identity headers; direct origins
        // must reject requests that bypass it. This check alone is not RBAC.
        const visitor = visitorFrom(request.headers)
        if (!visitor) return Response.json({ error: 'platform_login_required' }, { status: 401 })
        const records = await sql`select id, phone, status from applications order by created_at desc`
        return Response.json({ records })
      },
    },
  },
})
```

Adapt the table and returned columns to the app schema. The front end fetches this endpoint instead of a shared Server Function. Review and coupon mutations use the same protected prefix, validate input and same-origin/CSRF requirements, and record `visitor.id` for audit; it is not an authorization allowlist. Applicant reads and images still enforce application-owned record ownership.

## Verification and limits

Use local tests for missing identity, input/ownership checks, and applicant isolation; test mocks do not prove production role admission. Read `auth_info` after policy changes to verify saved rules and effective policy for page and employee endpoint paths. An anonymous live request to employee data must not return data; test spoofed identity headers through the gateway without real credentials. Check available origin-security status, and report unknown bypass protection rather than assuming it.

Real-account sign-in requires an available account and authorized interactive access. If the agent cannot sign in, mark real sign-in, role admission and rejection, logout, and request checks after role changes as "pending acceptance" and provide manual test steps. Do not report mock tests or policy readback as successful real-account sign-in acceptance.
