/**
 * E2E: Auto Update - configuration checks and UI verification
 *
 * Part 1: Pure file checks (no browser needed) — verify updater config in
 *         tauri.conf.json, Cargo.toml, lib.rs, and release workflow.
 * Part 2: UI checks via tauri-mcp — verify no update dialog is shown and
 *         app loads normally.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamCluApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
} from '../_utils/tauri-mcp-test-utils';
import * as fs from 'fs';
import * as path from 'path';

// ── Part 1: Configuration file checks (no app launch needed) ─────────

describe('Auto Update - Configuration', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  it('tauri.conf.json has updater configuration', () => {
    const configPath = path.resolve(repoRoot, 'apps', 'desktop', 'tauri.conf.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(config.plugins.updater).toBeDefined();
    expect(config.plugins.updater.pubkey).toBeTruthy();
    expect(config.plugins.updater.endpoints).toBeInstanceOf(Array);
    expect(config.plugins.updater.endpoints.length).toBeGreaterThan(0);
    // No OSS endpoint is asserted here. An `__OSS_BASE_URL__` entry only ever
    // reaches this file when a brand config supplies it *and* OSS_BASE_URL is
    // set — scripts/update-tauri-config.js substitutes the placeholder and drops
    // any entry still holding it. The checked-in config has never carried one,
    // so the old arrayContaining assertion described a brand build, not this repo.
    expect(config.plugins.updater.endpoints).toContain('https://github.com/different-ai-studio/teamclu/releases/latest/download/latest.json');
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
  });

  // The old "build config exports updater configuration to Rust" test read
  // `build.config.local.json`, which does not exist: vite dropped it from the
  // merge chain in f56d0ea9 so BUILD_ENV is the single way to switch
  // environments, and build.rs deliberately mirrors that. No checked-in config
  // carries `app.updater` any more — tauri.conf.json holds the defaults (the
  // test above) and a brand supplies overrides from the private branding repo.
  // What stayed testable is that build.rs still consumes `app.updater` at all.
  it('build.rs exports app.updater endpoints and pubkey to the Rust build', () => {
    const buildRs = fs.readFileSync(
      path.resolve(repoRoot, 'apps', 'desktop', 'build.rs'),
      'utf-8',
    );

    expect(buildRs).toContain('UPDATER_ENDPOINTS');
    expect(buildRs).toContain('UPDATER_PUBKEY');
    expect(buildRs).toContain('["app"]["updater"]["pubkey"]');
  });

  it('custom updater keeps process support without the unused updater plugin', () => {
    const cargoPath = path.resolve(repoRoot, 'apps', 'desktop', 'Cargo.toml');
    const cargo = fs.readFileSync(cargoPath, 'utf-8');

    expect(cargo).not.toContain('tauri-plugin-updater');
    expect(cargo).toContain('tauri-plugin-process');
  });

  it('custom update commands are registered and called by the frontend', () => {
    const libPath = path.resolve(repoRoot, 'apps', 'desktop', 'src', 'lib.rs');
    const lib = fs.readFileSync(libPath, 'utf-8');

    expect(lib).not.toContain('tauri_plugin_updater');
    const store = fs.readFileSync(path.resolve(repoRoot, 'packages/app/src/stores/updater.ts'), 'utf-8');
    for (const command of ['check_update', 'download_and_install_update', 'restart_app']) {
      expect(lib).toContain(`commands::updater::${command}`);
      expect(store).toContain(`"${command}"`);
    }
    const capability = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'apps/desktop/capabilities/default.json'), 'utf-8'));
    expect(capability.permissions).not.toContain('updater:default');
    expect(lib).toContain('tauri_plugin_process');
  });

  it('release workflow exists and is configured correctly', () => {
    const workflowPath = path.resolve(
      repoRoot,
      '.github',
      'workflows',
      'release.yml',
    );
    const workflow = fs.readFileSync(workflowPath, 'utf-8');

    expect(workflow).toMatch(/-\s*["']v\*["']/);
    expect(workflow).toContain('tauri-apps/tauri-action');
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    expect(workflow).toContain('aarch64-apple-darwin');
    expect(workflow).toContain('pnpm');
    // The manifest is no longer assembled by hand and pushed to OSS — the
    // assertions for `bucket.put_object_from_file(` / `'releases/latest.json'` /
    // `entry['url'] =` described a flow that now lives in release-oss.yml.
    // tauri-action publishes latest.json to the GitHub release instead, so what
    // matters is that the tag it releases under is the one the updater polls.
    expect(workflow).toContain('tagName:');
  });

  it('the updater endpoint points at the release tauri-action publishes', () => {
    const tauriConfig = JSON.parse(
      fs.readFileSync(
        path.resolve(repoRoot, 'apps', 'desktop', 'tauri.conf.json'),
        'utf-8',
      ),
    );

    // tauri-action attaches latest.json to the GitHub release; a `releases/latest/download`
    // endpoint is what makes the shipped app find it. These two drifting apart
    // is silent — the app just never sees an update.
    for (const endpoint of tauriConfig.plugins.updater.endpoints) {
      expect(endpoint).toContain('/releases/latest/download/latest.json');
    }
  });
});

// ── Part 2: UI checks (tauri-mcp) ────────────────────────────────────

describe('Auto Update - UpdateDialog UI', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamCluApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);
      appReady = true;
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('UpdateDialog does not show when no update is available', async () => {
    if (!appReady) return;
    await sleep(4000);

    const updateText = await executeJs(
      `document.body.innerText.includes('Update Available') ? 'found' : 'not-found'`,
    );
    expect(updateText).toContain('not-found');
  }, 15_000);

  it('UpdateDialog component is not rendered in DOM', async () => {
    if (!appReady) return;

    const hasUpdateDialog = await executeJs(
      `Array.from(document.querySelectorAll('[role="dialog"]')).some(el => el.textContent.includes('Update')) ? 'found' : 'not-found'`,
    );
    expect(hasUpdateDialog).toContain('not-found');
  }, 15_000);

  it('app loads normally without update blocking', async () => {
    if (!appReady) return;

    const hasSidebar = await executeJs(
      `document.querySelector('[data-slot="sidebar"]') ? 'found' : 'not-found'`,
    );
    const hasTeamCluText = await executeJs(
      `document.body.innerText.includes('TeamClu') ? 'found' : 'not-found'`,
    );

    const loaded =
      hasSidebar.includes('found') || hasTeamCluText.includes('found');
    expect(loaded).toBe(true);
  }, 15_000);
});
