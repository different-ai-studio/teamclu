import {test} from "node:test";
import assert from "node:assert/strict";
import * as module from "../src/lib/apps-auth-info.js";
import {resolvePathPolicy} from "../src/lib/apps-auth-paths.js";
const input = {appId: "app", teamId: "team", organization: {id: "org", name: "Org"}, roles: [{id:"r", code:"reviewer", name:"Reviewer", status:"active"}], authMode: "platform" as const, authScope: "all" as const, authAudience: "org" as const, authRules: []};
test("auth_info_preserves_raw_rules_and_precedence", () => {
 const rules = [{path:"/staff", auth:"required" as const, roles:[], audience:"org" as const}, {path:"/org", auth:"required" as const, audience:"org" as const}, {path:"/review", auth:"required" as const, roles:["reviewer"]}];
 const info = module.buildAppAuthInfo({...input, authRules:rules});
 assert.deepEqual(info.authRules, rules);
 assert.deepEqual(info.effectivePolicies, [
 {path:"/",kind:"any_org_role",roleCodes:null,inherited:true,source:"app_audience"},
 {path:"/staff",kind:"any_authenticated",roleCodes:[],inherited:false,source:"roles"},
 {path:"/org",kind:"any_org_role",roleCodes:null,inherited:false,source:"rule_audience"},
 {path:"/review",kind:"org_roles",roleCodes:["reviewer"],inherited:false,source:"roles"}]);
 for (const policy of info.effectivePolicies) {
  const resolved = resolvePathPolicy(policy.path, info.authScope, info.authRules);
  if (policy.source === "roles") assert.deepEqual(policy.roleCodes,resolved.roles);
 }
});
test("auth info covers scope baseline, inherited audience and root overrides", () => {
 for (const audience of ["any", "org"] as const) {
  const info = module.buildAppAuthInfo({...input, authScope:"paths", authAudience:audience, organization:null, roles:[],authRules:[{path:"/staff",auth:"required"}]});
  assert.equal(info.organizationStatus,"unconfigured");
  assert.deepEqual(info.effectivePolicies[0],{path:"/",kind:"public",roleCodes:[],inherited:true,source:"scope_baseline"});
  assert.equal(info.effectivePolicies[1].kind,audience === "any" ? "any_authenticated":"any_org_role");
  assert.equal(info.effectivePolicies[1].source,"app_audience");
 }
 const root = module.buildAppAuthInfo({...input,authRules:[{path:"/",auth:"public"}]});
 assert.equal(root.effectivePolicies.length,1);
 assert.deepEqual(root.effectivePolicies[0],{path:"/",kind:"public",roleCodes:[],inherited:false,source:"scope_baseline"});
 for (const authMode of ["none","third"] as const) assert.deepEqual(module.buildAppAuthInfo({...input,authMode,authRules:[{path:"/x",auth:"required",roles:["reviewer"]}]}).effectivePolicies.map(p=>[p.kind,p.source]),[["public","auth_mode"],["public","auth_mode"]]);
});

test("auth info refuses unreadable rules rather than explaining a wider audience", () => {
 for (const authRules of [{bad:"rules"},[{path:"/staff",auth:"required",roles:"reviewer"}]]) {
  assert.throws(()=>module.buildAppAuthInfo({...input, authRules:authRules as any}), (error: any)=>error.statusCode===503);
 }
});
