# Fixed FC origin version claim mapping

FC in cn-shenzhen rejected both omitted and empty claimPassBy values, despite
the Serverless Devs documentation describing the field as optional. A controlled
diagnostic with `header:version:X-Teamclu-Origin-Version` was accepted. On
2026-10-05 the diagnostic origin returned 200 for a valid signed token, 401 for
an expired token or another application's key, and 400 when no token was supplied.
These probes establish the tested JWT boundary, not Alibaba's internal root cause.

The platform now writes exactly that one mapping and requires it in security
readback, including aliases on later pages. Only header-name casing is normalized;
missing/empty/non-string mappings, a different claim/destination/header, extra
or duplicate mappings are drift. JWKS, token lookup, route, protocol and trigger
checks remain in force.

The version claim is already present in the gateway-signed origin JWT. It is
non-identity metadata and grants no employee or organization permission. The
gateway strips incoming X-Teamclu-Origin-Version for both managed and legacy
origins and strips the response header. FC may populate it only after validating
the origin JWT. Business Authorization and Cookie remain unchanged. Trusted
platform identity continues to come from the gateway's existing login checks.

This replaces the original zero-claim-forwarding expectation with a single
fixed metadata mapping. Existing applications are not bulk migrated; ordinary
deployment of a managed app uses the new declaration and readback contract.

Regression coverage: create/update payload parity, case-insensitive header,
missing/empty/identity/extra/duplicate/malformed mapping rejection, second-page
alias rejection, forged metadata stripping for public/signed-in/legacy requests,
JWT version payload, and response/redirect metadata stripping.
