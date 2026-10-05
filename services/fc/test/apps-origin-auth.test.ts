import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jwtVerify, decodeProtectedHeader } from 'jose';
import { readAppsOriginAuthConfig, originJwks, signOriginToken } from '../src/lib/apps-origin-auth.js';
const now = new Date('2027-01-01T00:00:00Z');
const appA = { appId: '76af539e-5341-4e96-bda7-6c8dacf2b092', slug: 'app-a' };
const appB = { appId: '11111111-2222-4333-8444-555555555555', slug: 'app-b' };
const hostA = 'app-a.origins.test';
const master = Buffer.alloc(32, 42).toString('base64url');
function env(): NodeJS.ProcessEnv { return { APPS_FC_ORIGIN_KEYRING: JSON.stringify({ active: { version: 'v2', key: master }, previous: { version: 'v1', key: Buffer.alloc(32, 43).toString('base64url') } }), APPS_FC_ROUTE_DOMAIN: 'origins.test' }; }
function config() { return readAppsOriginAuthConfig(env()); }
test('HTTP origin accepts keyring and route domain without TLS material', () => {
  const values = env();
  delete values.APPS_FC_ORIGIN_TLS_CERT_NAME;
  delete values.APPS_FC_ORIGIN_TLS_CERT_PEM;
  delete values.APPS_FC_ORIGIN_TLS_KEY_PEM;
  assert.equal(readAppsOriginAuthConfig(values).routeDomain, 'origins.test');
});
function key(appId: string) { return Buffer.from(originJwks(config(), appId).keys[0].k, 'base64url'); }
test('stable independent app and version keys normalize UUID case', () => {
  const cfg = config(), keys = originJwks(cfg, appA.appId).keys;
  assert.equal(keys.length, 2);
  assert.deepEqual(originJwks(cfg, appA.appId.toUpperCase()).keys, keys);
  assert.deepEqual(originJwks(cfg, appA.appId).keys, keys);
  assert.equal(Buffer.from(keys[0].k, 'base64url').length, 32);
  // Independent HMAC-SHA256 vector for the documented derivation context.
  assert.equal(keys[0].k, 'UlrcvmAuIJ7E0Y0-p-vta--CSuhBr6-aC_kDG6IHRIY');
  assert.notEqual(keys[0].k, originJwks(cfg, appB.appId).keys[0].k);
  assert.notEqual(keys[0].k, originJwks({ ...cfg, activeKey: { ...cfg.activeKey, version: 'v3' }, previousKey: undefined }, appA.appId).keys[0].k);
  assert.deepEqual(keys.map(({ k, ...metadata }) => metadata), [{ kty: 'oct', alg: 'HS256', use: 'sig', kid: 'v2' }, { kty: 'oct', alg: 'HS256', use: 'sig', kid: 'v1' }]);
});
test('60-second HS256 credentials carry app, host, version and active kid', async () => {
  const token = await signOriginToken(config(), appA, hostA, now);
  const { payload, protectedHeader } = await jwtVerify(token, key(appA.appId), { currentDate: now, algorithms: ['HS256'] });
  assert.equal(protectedHeader.alg, 'HS256');
  assert.equal(protectedHeader.kid, 'v2');
  assert.equal(payload.exp! - payload.iat!, 60);
  assert.equal(payload.iat, Math.floor(now.getTime() / 1000));
  assert.equal(payload.appId, appA.appId);
  assert.equal(payload.originHost, hostA);
  assert.equal(payload.version, 'v2');
  await assert.rejects(jwtVerify(token, key(appB.appId), { currentDate: now }));
  await assert.rejects(jwtVerify(token, key(appA.appId), { currentDate: new Date(now.getTime() + 60000) }));
});
test('rotation verifies previous and active tokens and signs active only', async () => {
  const cfg = config();
  const old = await signOriginToken({ ...cfg, activeKey: cfg.previousKey!, previousKey: undefined }, appA, hostA, now);
  const active = await signOriginToken(cfg, appA, hostA, now);
  for (const token of [old, active]) {
    const jwk = originJwks(cfg, appA.appId).keys.find(k => k.kid === decodeProtectedHeader(token).kid)!;
    await jwtVerify(token, Buffer.from(jwk.k, 'base64url'), { currentDate: now });
  }
  assert.equal(decodeProtectedHeader(active).kid, 'v2');
  assert.equal(originJwks({ ...cfg, previousKey: undefined }, appA.appId).keys.length, 1);
});
for (const name of Object.keys(env()))
  test(`rejects missing ${name}`, () => { const values = env(); delete values[name]; assert.throws(() => readAppsOriginAuthConfig(values)); });
for (const value of ['secret-invalid-json', '{}', 'null', '[]',
  JSON.stringify({ active: { version: 'v1', key: 'secret!invalid' } }),
  JSON.stringify({ active: { version: 'v1', key: Buffer.alloc(31).toString('base64url') } }),
  JSON.stringify({ active: { version: 'v1', key: master + '=' } }),
  JSON.stringify({ active: { version: '', key: master } }),
  JSON.stringify({ active: { version: 'v1', key: master }, previous: { version: 'v1', key: master } }),
  JSON.stringify({ active: { version: 'v1', key: master }, previous: [{ version: 'v0', key: master }] }),
  JSON.stringify({ active: { version: 'v1', key: master }, previous: { version: 'v0', key: master, previous: {} } }),
  JSON.stringify({ active: { version: 'v1', key: master }, history: [] })])
  test('malformed keyring rejects without secret disclosure', () => {
    assert.throws(() => readAppsOriginAuthConfig({ ...env(), APPS_FC_ORIGIN_KEYRING: value }), error => { const text = String(error); return !text.includes(master) && !text.includes('secret-invalid-json') && !text.includes('secret!invalid'); });
  });
test('malformed route domains reject', () => { for (const value of ['https://origins.test', 'origins.test:443', 'origins.test/path', '*.origins.test', 'bad..test'])
  assert.throws(() => readAppsOriginAuthConfig({ ...env(), APPS_FC_ROUTE_DOMAIN: value })); });
test('invalid UUID rejects before deriving or signing', async () => { for (const appId of ['', 'not-an-app', appA.appId + ':suffix']) {
  assert.throws(() => originJwks(config(), appId));
  await assert.rejects(signOriginToken(config(), { ...appA, appId }, hostA, now));
} });
