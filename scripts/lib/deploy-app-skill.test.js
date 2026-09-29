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
  assert.doesNotMatch(description ?? '', /status|runtime_info|commit|push|verify/i);
  const gates = ['manage_app status', 'manage_app runtime_info', 'manage_app deploy', 'migration', 'selected', 'linux/x86_64', 'clean', 'remote HEAD', 'native approval', 'live'];
  for (const gate of gates) assert.ok(skill.includes(gate), `missing ${gate} gate`);
  assert.match(skill, /dirty.{0,100}checkout/is);
  assert.match(skill, /unknown.{0,100}(stop|block|test)/is);
  assert.match(skill, /new app.{0,100}TeamClu-deployable/is);
  assert.match(skill, /pinned live configuration/is);
  assert.match(skill, /data\/auth behavior/is);
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
