import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";

// Route-layer tests for /v1/account/upgrade using a fake business repo.
function deps(repo: any) {
  return {
    createRepository: () => repo,
    createAuthRepository: () => { throw new Error("auth repo not expected"); },
  };
}

const AUTH = { authorization: "Bearer t" };

test("POST /v1/account/upgrade calls upgradeAccount", async () => {
  const calls: any[] = [];
  const repo = { upgradeAccount: async (a: any) => { calls.push(a); return { orgId: "o1", teamId: "tm1", teamName: "Acme" }; } };
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/account/upgrade", headers: AUTH,
    body: JSON.stringify({ teamId: "tm1", orgName: "Acme", contact: "13700000000" }),
  }, deps(repo));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], { teamId: "tm1", orgName: "Acme", contact: "13700000000" });
  assert.equal(JSON.parse(res.body).orgId, "o1");
});

test("POST /v1/account/upgrade requires teamId + orgName", async () => {
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/account/upgrade", headers: AUTH,
    body: JSON.stringify({ teamId: "tm1" }),
  }, deps({ upgradeAccount: async () => ({}) }));
  assert.equal(res.statusCode, 400);
});

test("POST /v1/account/bind-phone is gone (410) and never reaches the repository", async () => {
  const calls: any[] = [];
  const repo = { bindPhone: async (a: any) => { calls.push(a); return { userId: "u1", bound: true }; } };
  const res = await handleBusinessApiRequest({
    httpMethod: "POST", path: "/v1/account/bind-phone", headers: AUTH,
    body: JSON.stringify({ phone: "13700000000", code: "123456" }),
  }, deps(repo));
  assert.equal(res.statusCode, 410);
  assert.equal(calls.length, 0);
});
