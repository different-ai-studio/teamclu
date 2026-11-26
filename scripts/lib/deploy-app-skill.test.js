const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const skillPath = resolve(root, 'packages/app/src/lib/skills/deploy-app/SKILL.md');

test('deploy-app skill keeps discovery metadata to a trigger and covers the deployment gates', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const description = skill.match(/^description: (.+)$/m)?.[1];
  assert.match(description ?? '', /^Use when /);
  assert.doesNotMatch(description ?? '', /status|runtime|commit|push|verify/i);
  const gates = ['amuxd app status', 'amuxd app runtime --language', 'amuxd app deploy', '--migration', 'op wait', 'Exit 8', 'exit 4', 'migration', 'selected', 'linux/x86_64', 'clean', 'remote HEAD', 'live'];
  for (const gate of gates) assert.ok(skill.includes(gate), `missing ${gate} gate`);
  assert.match(skill, /dirty.{0,100}checkout/is);
  assert.match(skill, /unknown.{0,100}(stop|block|test)/is);
  assert.match(skill, /new app.{0,100}TeamClu-deployable/is);
  assert.match(skill, /pinned live configuration/is);
  assert.match(skill, /data\/auth behavior/is);
  // P2.5: the MCP tools and their native approval are gone.
  assert.doesNotMatch(skill, /manage_app|native approval|native confirmation/);
});

test('starter templates point to the inherent skill and retain their own artifact contract', () => {
  for (const name of ['static-web', 'slides', 'tanstack-postgres']) {
    const markdown = readFileSync(resolve(root, `templates/${name}/AGENTS.md`), 'utf8');
    const deploySection = markdown.split('## 部署声明')[1]?.split('## 登录')[0] ?? '';
    assert.match(deploySection, /deploy-app/);
    assert.match(deploySection, /\.output\/server\/index\.mjs/);
    assert.doesNotMatch(deploySection, /Nodejs20:3|pip install --platform|runtime_info|## 怎么上线/);
  }
});

test('uninstall guidance requires explicit intent, an explicit app and verified completion in English', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const section = skill.split('## Uninstalling a deployment')[1] ?? '';
  assert.doesNotMatch(skill, /[\u4e00-\u9fff]/);
  for (const contract of ['user explicitly requests', 'explicit app ID or name', '--app', 'uploaded files', 'amuxd app status', 'operator reconciliation', 'real-account verification as pending']) {
    assert.ok(section.includes(contract), `missing uninstall contract: ${contract}`);
  }
  assert.match(section, /accepted operation is not a completed uninstall/);
});
