# Permanent app codes and opt-in domain migration

Date: 2026-10-19

Status: approved by the user on 2026-10-19. Existing implementation changes
remain a draft and must be reconciled with this specification after the user
reviews the implementation plan and selects its execution method.

## Purpose and scope

TeamClu needs a stable public app identity independent of an editable app name.
Name-derived domains can involve Chinese-to-Punycode conversion, couple links to
names, and complicate globally unique routing. Sequential public codes also make
app discovery by enumeration easy.

Give every app a permanent, random 12-character code. New apps use code-based
default domains. Assign codes to existing apps without changing their current
deployments or domains. Offer migration through an unchecked checkbox inside the
existing deployment confirmation, only when an existing app is currently live
on its old default domain.

This changes the database model, public API representation, gateway routing,
login origins, domain-dependent integrations, and deployment confirmation. It is
an architectural change under the Superpowers workflow.

## Confirmed requirements

1. The random portion is exactly 12 lowercase DNS-safe characters. The `a-`
   prefix belongs to the hostname, not to the stored code.
2. Every app, including an existing app, receives a code.
3. Codes are globally unique and permanent. Renaming an app preserves its code.
4. Existing deployments, endpoints, and domains remain unchanged by backfill.
5. The migration choice appears inside the existing deployment confirmation as
   an unchecked checkbox, rather than as a second popup.
6. Show the checkbox only for a legacy app with a current live deployment on its
   old domain. Hide it for undeployed apps and apps already using code domains.
7. Checking the box takes effect only after that deployment succeeds. Leaving
   it unchecked, cancelling, or failing deployment preserves the domain mode.
8. Existing URLs remain usable aliases after an approved switch.
9. App codes identify apps; authentication and permissions remain the access
   boundary.

## Approaches considered

| Approach | Benefit | Cost or limitation | Decision |
| --- | --- | --- | --- |
| Stored random code, separate from the UUID and name | Permanent identity, exact lookup, independent domain migration | Adds a database field, uniqueness constraint, and backfill | Selected |
| Short code derived from the existing UUID | Avoids independently generating another identifier | Couples the public representation to internal IDs; shortening still needs collision handling | Rejected |
| Sequential code with an encoded or scrambled representation | Compact internal numbering | Reversible encodings permit enumeration; a custom secret-dependent scheme adds unnecessary complexity | Rejected |

For existing domains, explicit deployment opt-in is selected over automatic
migration or redirects. It preserves existing links and lets the user decide
when the canonical default address changes.

## Public identity and storage

Keep existing UUIDs as internal primary keys and relationships. Do not rename
repositories, database schemas, storage paths, or existing FC resources as part
of this feature.

Add these fields to the app row:

| Field | Meaning |
| --- | --- |
| `app_code` | Immutable, globally unique random 12-character code |
| `uses_app_code_domain` | Whether the active default public URL uses the code |
| `deploy_use_app_code_domain` | Domain mode requested by the deployment attempt associated with its token |

Use lowercase Crockford Base32, `0123456789abcdefghjkmnpqrstvwxyz`, for 60 bits of
randomness. Generate those bits using a cryptographically secure source. Do not
derive the code from a counter, app name, timestamp, or ordinary pseudo-random
generator.

Enforce length/alphabet, non-nullness, global uniqueness, and immutability in the
database. Retry random-code collisions during backfill. On creation, retry only
the code uniqueness conflict, up to five attempts, reusing the already-created
workspace. Other errors, including a duplicate team-local slug, remain errors.

## API and address selection

Expose these read-only app properties through the existing Cloud API:

| Property | Meaning |
| --- | --- |
| `appCode` | Permanent public identifier |
| `usesAppCodeDomain` | Active default-domain mode |
| `appCodeUrl` | Candidate code URL, which may not yet be enabled |
| `publicUrl` | Current default URL selected by the active mode |

The code URL is `https://a-<appCode>.<APPS_PUBLIC_DOMAIN>`. It contains one label
under the configured domain so existing wildcard routing remains applicable.
Renaming an app does not change this URL.

If the installation has no public apps domain configured, no code URL is
advertised. Existing trigger-URL fallback behavior remains in place.

The deployment-start request accepts optional boolean `useAppCodeDomain`.
Omission or false preserves the current mode. True opts into code mode. Once
code mode is active, an ordinary deployment never switches back to legacy mode.
The request does not accept a replacement app code.

Update the OpenAPI contract before changing providers. Business operations
continue through the Cloud API; clients do not call Supabase directly.

## Backfill and deployment transitions

Backfill existing rows with a random code and legacy mode. Do not call FC,
publish a build, replace an endpoint, or modify a domain binding during this
migration. New rows default to code mode.

| Current state | User choice | During build | Successful finalization | Failure or cancellation |
| --- | --- | --- | --- | --- |
| Existing app in legacy mode | Keep current domain | Legacy remains active | Legacy remains active | Legacy remains active |
| Existing live app in legacy mode | Check migration box | Legacy remains active | Activate code domain; keep old alias | Legacy mode remains active |
| App already in code mode | No migration checkbox | Code mode stays selected | Code mode stays selected | No domain-mode change |
| Existing app never deployed | No migration checkbox | Legacy mode stays selected | Legacy mode stays selected | No domain-mode change |
| Newly created app | No migration checkbox | Code mode stays selected | Code URL serves the deployed app | No domain-mode change |

Persist the requested mode with the deployment token, so the build and
finalization refer to the same attempt. Only the successful finalization update
may activate a requested switch. A later retry records its own choice; a failed
attempt's choice must not silently enable a later deployment.

This feature preserves the existing deployment lifecycle. It does not promise
to repair unrelated behavior governing application availability after a failed
build or deployment.

## Confirmation checkbox

Eligibility requires all of the following:

- `usesAppCodeDomain` is explicitly false, identifying an existing legacy app.
- The current deployment is live.
- The deployment has an endpoint and a current public URL.
- The candidate code URL exists and differs from the current public URL.

Add an unchecked checkbox labeled “Use the app-code domain after deployment
succeeds” to the existing confirmation. Show the candidate address and explain
that the current address is retained by default and remains available after a
switch. Use existing design tokens and translated labels.

Checkbox state belongs to the current confirmation and resets to unchecked on
every attempt. Declining or dismissing the confirmation does not submit a
deployment request. The checkbox does not create another permission popup.

Apply this interaction to the frontend confirmation and the native confirmation
used by agent-driven deployments. Keep native approval as the trust boundary
for agent publishing, including its timeout and serialization. An agent cannot
supply or preselect the checkbox choice.

Require the checkbox on supported desktop platforms. The current draft's
Windows/Linux keep/switch/decline buttons are a known mismatch, not an approved
substitute. The implementation plan must include platform adapters and their
validation. If a platform cannot meet the requirement, report that limitation
for a scope decision instead of silently shipping a different interaction.

## Routing and integration compatibility

Resolve code hostnames by exact, indexed app-code equality. Serve a code hostname
only when code-domain mode is active; knowing a candidate URL before activation
must not enable it. Reject ambiguous matches rather than choosing an app.

Retain the existing legacy-host parser, including Punycode handling, for old
links. Legacy aliases and code domains use the same gateway and auth policies.
Private apps remain private regardless of which alias is used.

Centralize address selection so app responses, login-return validation,
platform-auth environment values, custom-domain DNS targets, Traefik custom
domain forwarding, and scheduled requests agree on the current mode. Verified
custom-domain bindings remain valid and unchanged.

Login return origins include the active default URL and allowed aliases. Do not
accept a candidate code origin before activation. Invalidate cached routing
answers and misses for both code and legacy hosts after relevant changes.

## Verification and acceptance

Acceptance requires:

1. Executable migration tests prove backfill leaves existing deployment fields
   and legacy mode unchanged, and new rows receive valid codes by default.
2. Database tests cover required format, uniqueness, immutability, and rename
   stability. Creation tests cover collision retry and error propagation.
3. Routing tests cover exact app selection, unknown and disabled code hosts,
   legacy ASCII/Punycode aliases, and cache invalidation.
4. Deployment tests cover unchecked, checked, cancelled, failed, and successful
   attempts, including no automatic switch for an existing undeployed app.
5. Confirmation tests cover every eligibility condition, unchecked initial
   state, no second popup, and reset on the next attempt.
6. Integration tests cover login origins, unchanged auth permissions, custom
   domains, and scheduled requests under both domain modes.
7. Frontend and backend type checks and applicable test suites pass. Report
   unavailable dependencies and unrelated environmental failures explicitly.
8. Native platform adapters compile and receive presentation/interaction
   acceptance testing on their supported platforms. Verify timeout, dismissal,
   user choice, and preservation of native approval.

Use test-first implementation for missing behavior and independent code review
after reconciling the existing draft with the approved plan. Prior draft test
results are useful evidence, but do not replace validation of the final result.

## Rollout and workflow gates

Apply the migration through the configured Supabase MCP before publishing the
updated Cloud API. Verify changed fields, constraints, triggers, and existing
rows' preserved mode through read-only MCP queries. The MCP is unavailable in
this session, so live migration and verification are blocked until it is set up.
Do not substitute another live-database access method.

Work stays on `codex/app-public-code`. Preserve unrelated checkout edits. Only
the specification is committed at this review stage. Product code remains draft
until the user approves this specification, then reviews the implementation
plan and selects its execution method.

No branch push, PR creation, service publishing, or live deployment occurs
without the user's corresponding authorization.
