import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanupAppDeployment} from '../../src/lib/provisioning/app-undeploy.js';
const snapshot={appId:'00000000-0000-0000-0000-000000000001',slug:'demo',functionName:'tc-demo',oauthClientId:'old-client',originDomain:'demo.fc-origin.example'};
test('cleanup continues after failure and deletes only deployment resources',async()=>{
 const calls:string[]=[];
 const out=await cleanupAppDeployment({
  deleteHttpTrigger:async n=>{calls.push('trigger:'+n);throw Object.assign(new Error('denied'),{code:'AccessDenied'});},
  deleteCustomDomain:async n=>{calls.push('domain:'+n);},deleteFunction:async n=>{calls.push('function:'+n);},
  deleteArtifact:async n=>{calls.push('artifact:'+n);},disableOAuthClient:async n=>{calls.push('oauth:'+n);},
 },snapshot,{},async()=>{});
 assert.equal(out.httpTrigger.status,'failed');assert.equal(out.function.status,'succeeded');
 assert.ok(calls.includes('artifact:apps/'+snapshot.appId+'/code.zip'));
 assert.ok(calls.every(c=>!c.includes('app-files')));assert.equal(calls.length,5);
});
test('retry skips successes; provider absence is success but permissions and unavailable adapters fail',async()=>{
 let invoked=0;
 const out=await cleanupAppDeployment({deleteFunction:async()=>{invoked++;throw Object.assign(new Error('gone'),{code:'FunctionNotFound'});}}, {...snapshot,oauthClientId:null}, {artifact:{status:'succeeded'}},async()=>{});
 assert.equal(invoked,1);assert.equal(out.function.status,'succeeded');assert.equal(out.artifact.status,'succeeded');assert.equal(out.httpTrigger.status,'failed');assert.equal(out.oauthClient.status,'skipped');
});

test('bounded ambiguous provider outcome keeps in-flight fence instead of allowing new deployments',async()=>{
 const phases:any[]=[];
 await assert.rejects(cleanupAppDeployment({callTimeoutMs:5,deleteHttpTrigger:async()=>new Promise(()=>{})},snapshot,{},async(_s,p)=>{if(p)phases.push(p)}), /provider outcome unknown/);
 assert.equal(phases.at(-1).inFlight,true);
});
