const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/self-host-deploy.yml'), 'utf8');
const block = workflow.slice(workflow.indexOf('            redirects="'), workflow.indexOf('\n            echo "=== build fc'))
  .split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
function run(domain, previous = 'https://client.example/callback') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-redirects-'));
  try {
    fs.mkdirSync(path.join(dir, 'bootstrap'));
    fs.copyFileSync(path.join(root, 'deploy/self-host/bootstrap/oauth-redirects.sh'), path.join(dir, 'bootstrap/oauth-redirects.sh'));
    fs.writeFileSync(path.join(dir, '.env'), `LOGIN_DOMAIN=${domain}\n${previous === null ? '' : `ADDITIONAL_REDIRECT_URLS=${previous}\n`}`);
    const script = `set -eu\nupsert_env() { printf '%s' "$2"; }\n${block}`;
    return execFileSync('bash', ['-c', script], { cwd: dir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }).split(',');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('deploy preserves callbacks and allows only login_state on the configured callback path', () => {
  for (const domain of ['login.apps.dev.example', 'login.apps.prod.example']) {
    const values = run(domain);
    assert.ok(values.includes(`https://${domain}/oauth/callback[?]login_state=*`));
    assert.ok(values.includes(`https://${domain}/oauth/callback`));
    assert.ok(values.includes('https://client.example/callback'));
    assert.ok(values.includes('teamclu://auth-callback'));
    assert.ok(values.includes('http://127.0.0.1:*/callback'));
    assert.deepEqual(run(domain, values.join(',')), values);
    assert.ok(!values.includes(`https://${domain}/**`));
  }
});
test('unset login domain keeps existing client callbacks without adding app callbacks', () => {
  assert.deepEqual(run(''), ['https://client.example/callback', 'http://127.0.0.1:*/callback', 'teamclu://auth-callback']);
});
test('invalid login domain fails instead of granting a wildcard or foreign URL', () => {
  for (const domain of ['*.example.com', 'login.example/path', 'https://login.example', 'login.example,evil.example']) {
    assert.throws(() => run(domain));
  }
});

test('missing redirect configuration seeds desktop callbacks', () => {
  assert.deepEqual(run('', null), ['http://127.0.0.1:*/callback', 'teamclu://auth-callback']);
});
