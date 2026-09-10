import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountIdFromFcEndpoint,
  defaultSlsProject,
  resolveAppsSls,
  resolveSlsAccountId,
} from "../src/lib/provisioning/sls-client.js";

const ACCT_API = "1317424610922997"; // where the Cloud API's own role lives
const ACCT_FNS = "1457752404144823"; // where the app functions actually run

// --- where the account id comes from ----------------------------------------

test("an explicit account id wins over everything", () => {
  const r = resolveSlsAccountId({
    ALIYUN_ACCOUNT_ID: ACCT_FNS,
    APPS_FC_ENDPOINT: `${ACCT_API}.cn-shenzhen.fc.aliyuncs.com`,
    ROLE_ARN: `acs:ram::${ACCT_API}:role/x`,
  } as any);
  assert.deepEqual(r, { accountId: ACCT_FNS, source: "ALIYUN_ACCOUNT_ID" });
});

test("the FC endpoint is trusted over ROLE_ARN", () => {
  // The endpoint is account-scoped and names where the functions are addressed;
  // the role is the Cloud API's own and need not be the same account at all.
  const r = resolveSlsAccountId({
    APPS_FC_ENDPOINT: `${ACCT_FNS}.cn-shenzhen.fc.aliyuncs.com`,
    ROLE_ARN: `acs:ram::${ACCT_API}:role/x`,
  } as any);
  assert.deepEqual(r, { accountId: ACCT_FNS, source: "APPS_FC_ENDPOINT" });
});

test("ROLE_ARN is still a fallback, and says that it was used", () => {
  // Dropping it would take logs away from a single-account deployment that sets
  // nothing else, where it happens to be correct. Naming the source is what
  // makes the cross-account case diagnosable instead of silent.
  const r = resolveSlsAccountId({ ROLE_ARN: `acs:ram::${ACCT_API}:role/x` } as any);
  assert.deepEqual(r, { accountId: ACCT_API, source: "ROLE_ARN" });
});

test("nothing to derive from is null, not a guess", () => {
  assert.equal(resolveSlsAccountId({} as any), null);
  assert.equal(defaultSlsProject({} as any), null);
});

test("an FC endpoint that carries no account id yields none", () => {
  assert.equal(accountIdFromFcEndpoint("cn-shenzhen.fc.aliyuncs.com"), null);
  assert.equal(accountIdFromFcEndpoint("https://custom.example.com"), null);
  assert.equal(accountIdFromFcEndpoint(undefined), null);
  assert.equal(accountIdFromFcEndpoint(`${ACCT_FNS}.cn-shenzhen.fc.aliyuncs.com`), ACCT_FNS);
});

// --- what the resolution carries --------------------------------------------

test("an explicit project reports no derivation source", () => {
  // belayo's shape after 2026-09-10: the project is named outright, so nothing
  // was derived and the ROLE_ARN warning must not fire.
  const r = resolveAppsSls({
    APPS_SLS_PROJECT: "serverless-cn-shenzhen-5003014c",
    APPS_SLS_LOGSTORE: "default-logs",
    ROLE_ARN: `acs:ram::${ACCT_API}:role/x`,
    APPS_REGION: "cn-shenzhen",
  } as any);
  assert.equal(r.config?.project, "serverless-cn-shenzhen-5003014c");
  assert.equal(r.config?.logstore, "default-logs");
  assert.equal(r.config?.derivedFrom, null);
});

test("a project derived from ROLE_ARN is marked as such", () => {
  // This is the combination that produced no logs on belayo for weeks: the name
  // carries the API's account while the functions run in another, and SLS
  // project names are globally unique so creating it cannot succeed.
  const r = resolveAppsSls({ ROLE_ARN: `acs:ram::${ACCT_API}:role/x` } as any);
  assert.equal(r.config?.project, `teamclu-apps-${ACCT_API}`);
  assert.equal(r.config?.derivedFrom, "ROLE_ARN");
});

test("the logstore defaults, and the error names every source", () => {
  assert.equal(resolveAppsSls({ ALIYUN_ACCOUNT_ID: ACCT_FNS } as any).config?.logstore, "app-logs");
  const err = resolveAppsSls({} as any).error!;
  for (const v of ["APPS_SLS_PROJECT", "ALIYUN_ACCOUNT_ID", "APPS_FC_ENDPOINT", "ROLE_ARN"]) {
    assert.ok(err.includes(v), `error should name ${v}: ${err}`);
  }
});
