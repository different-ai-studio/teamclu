# FC signed list timeout — temporary workaround

On 2026-10-05 at 15:45:33 Asia/Shanghai, dev ECS called FC 3.0 in
cn-shenzhen using Node v20.20.2 and @alicloud/fc20230330 4.7.6.
ListTriggers for james-http-origin-a-20261005-eac905d6 returned HTTP 200
with limit=1 in 154ms (RequestId 1-6ac3559d-17a1403c-35ddf6674927).
Limits 2, 10 and 100 timed out after approximately 5 seconds.
Fresh clients, keepAlive changes and longer timeouts did not resolve prior probes.
ListCustomDomains with limit=1 completed all 18 pages/18 entries.

The public Alibaba health dashboard showed no current incident. This does not
exclude a localized provider or SDK problem; provider root cause is unconfirmed.
The support ticket remains unsubmitted: RAM user dengwei requires
AliyunSupportFullAccess. The user is requesting support permissions.

Temporarily use limit=1 for both origin-security list calls. Continue through
every nextToken, reject repeated/malformed tokens and retain checks for extra
HTTP triggers and custom-domain aliases. This increases API call count but does
not accept an incomplete scan. Reconsider page size after Alibaba support
confirms a resolution and larger-page probes pass.

Separate outstanding acceptance blocker: FC rejected omitted/empty claimPassBy;
the diagnostic app currently uses a non-identity version mapping. That mapping
is not accepted by the platform's original no-claim-mapping security policy.
The pagination workaround does not resolve that separate issue. The subsequent
fixed-metadata mapping contract is documented in
[FC origin version claim](2026-10-05-fc-origin-version-claim.md).
