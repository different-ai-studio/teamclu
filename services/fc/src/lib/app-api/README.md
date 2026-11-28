# Apps Internal Kong PostgreSQL route publisher

This module is a server-side publisher for the Hangzhou `apps-internal-kong` PostgreSQL deployment. It does not consume user requests directly. `ApprovedKongSnapshot` must come from the TeamClu App API control plane after the provider App administrator approves the caller and operation. The current `main` checkout does not yet contain those approval tables or runtime jobs; the separate, unmerged `codex/app-api-phase-two` branch contains working Cloud API/control-plane code but its gateway writer still targets DB-less `/config`. Do not wire that writer to this PostgreSQL Kong.

## Production call contract

1. The control plane creates an immutable, environment-scoped generation from current approved grants. Its snapshot includes only trusted target App Host and private FC origin, exact method/path, active caller App IDs, deployed Basic credentials, and the target App's mounted signing-key version. It rejects cross-team grants and target FCs without the required origin guard/JWKS.
2. The runtime obtains a **cross-process exclusive lock** for this gateway environment and keeps it through the entire publish. `PublicationFence.assertCurrent()` checks that its lease and generation still match the control plane's latest desired generation before every mutation. A stale worker cannot publish after a revocation. No production caller may substitute a no-op fence.
3. A publisher process shares the Kong Pod's network namespace. `createLoopbackKongAdmin` connects only to `127.0.0.1:8001`; never expose Admin API through a Service, Ingress, ALB or caller-selectable URL. The runtime can then call `publishApprovedKongSnapshot(snapshot, admin, fence)`.
4. The publisher removes managed Routes first, cleans stale managed Services/Consumers, then writes Services, four security plugins, caller credentials and ACL groups. It creates exact Host/method/path Routes last. Kong 3.9.4 requires the actual Service ID in a Route write; the adapter resolves it. The Route is read back before success is returned. If a step fails, the generation must remain pending/failed and be retried from the **latest** desired snapshot. Do not report approval as applied merely because the database transaction committed.
5. Kong persists the entities in its dedicated PostgreSQL database. Persistence is not the authorization ledger: the TeamClu control plane retains grant decisions, generation, audit and retry state. On revocation it publishes a new snapshot excluding the grant and waits for readback, then tests that the old caller/path is denied. With multiple Kong replicas, verify every data plane has observed the new route set before reporting effective revocation.

The current module provides the compiler, ordered Admin API executor and loopback transport. It does **not** provide the control-plane approval source, durable generation/lease implementation, Kubernetes sidecar packaging, key readiness, multi-replica acknowledgement, or FC ingress verification. Those are release blockers for ongoing production use.

## Temporary FC A/B/C acceptance

`services/fc/scripts/app-api-kong-acceptance.ts` pins the temporary target A from the 2026-11-15 Hangzhou FC acceptance. It creates one `GET /internal/api/v1/orders` route for B and provisions an ungranted C Consumer for ACL rejection. `revoke` removes the route, Service and both test Consumers. Before any mutation, it refuses to run if Kong has unrelated `teamclu-app-api` entities. It is only for this isolated acceptance while no production publisher is running; its no-op fence is deliberately **not** a production implementation.

Run only with the target key already mounted and the temporary FC origin guard/JWKS verified. Keep B/C IDs and passwords in an approved secret channel, never in command arguments or Git. Make the Kong Pod's loopback Admin API temporarily reachable on local loopback through a controlled Kubernetes port-forward, then from `services/fc/` run:

```sh
node --import tsx scripts/app-api-kong-acceptance.ts publish
node --import tsx scripts/app-api-kong-acceptance.ts revoke
```

The process requires `APP_API_ACCEPTANCE_ONLY=yes-temporary-fc-a-b-c`, `APP_API_ACCEPTANCE_B_ID`, `APP_API_ACCEPTANCE_C_ID`, and for `publish`, `APP_API_ACCEPTANCE_B_PASSWORD` and `APP_API_ACCEPTANCE_C_PASSWORD`. It prints only the action, generation and route count. Stop the port-forward after the test. Validate B succeeds through the private Host, C gets ACL 403, missing credentials get 401, other methods/paths/Hosts get 404, direct FC requests without the origin JWT fail, and after `revoke` B gets 404. Read back Kong Routes/Consumers after revocation and clean up the temporary FC and key through the owning infrastructure workflow.
