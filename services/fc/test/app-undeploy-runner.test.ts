import {test} from 'node:test';import assert from 'node:assert/strict';
import {runAppUndeployTick} from '../src/lib/app-undeploy-runner.js';
test('runner records per-step cleanup, retries and resumes only eligible operations',async()=>{
 let saved:any={};let finished:any;let calls=0;
 const store={list:async()=>[{id:'op',status:'pending'}],claim:async()=>({id:'op',lease_owner:'lease',snapshot:{appId:'a',functionName:'fc-a',originDomain:null,oauthClientId:null},steps:{artifact:{status:'succeeded'}}}),
 save:async(_id:string,_owner:string,steps:any)=>{saved={...steps};},finish:async(_id:string,_owner:string,steps:any)=>{finished=steps;}};
 const result=await runAppUndeployTick({store,deps:{deleteHttpTrigger:async()=>{},deleteFunction:async()=>{calls++;throw {code:'AccessDenied'};}}});
 assert.equal(calls,1);assert.equal(saved.function.status,'failed');assert.equal(finished.httpTrigger.status,'succeeded');assert.equal(result.processed,1);
});
test('expired in-flight operations are not reclaimed and no provider call starts',async()=>{
 let providerCalled=false;
 const result=await runAppUndeployTick({store:{list:async()=>[{id:'op'}],claim:async()=>null,save:async()=>{},finish:async()=>{}},deps:{deleteFunction:async()=>{providerCalled=true;}}});
 assert.equal(result.processed,0);assert.equal(providerCalled,false);
});

test('worker yields before a provider call when its tick budget is exhausted',async()=>{
 let deleted=false;
 const store={list:async()=>[{id:'op'}],claim:async()=>({id:'op',lease_owner:'l',snapshot:{appId:'a',functionName:'f',originDomain:null,oauthClientId:null},steps:{}}),save:async()=>{},finish:async()=>{throw new Error('incomplete cannot finish');}};
 const result=await runAppUndeployTick({store,deps:{deleteHttpTrigger:async()=>{deleted=true;}},maxTickMs:0});
 assert.equal(deleted,false);assert.equal(result.processed,0);
});
