#!/usr/bin/env node

/**
 * Assemble the Chrome Web Store "listing kit" for the current brand.
 *
 * The Web Store API (v2) can only upload a package and publish it —
 * media.upload, publishers.items.{publish,fetchStatus,cancelSubmission,
 * setPublishedDeployPercentage}. There is no endpoint for listing metadata, so
 * screenshots, promo tiles, the store description and the privacy-practices
 * answers can only be entered by hand in the developer dashboard.
 *
 * Keeping them in the branding repo anyway buys version control and review;
 * this script turns that source of truth into a single reviewed artifact —
 * validated images plus a paste-ready checklist — so the manual step is
 * transcription rather than authorship.
 *
 * Input  : branding/extension/{listing.json,privacy.json,listing/**}
 *          (placed by .github/actions/brand-setup from brands/<brand>/extension/)
 * Output : listing-kit/ + listing-kit.zip-able directory
 * No-op  : when branding/extension is absent (unbranded builds).
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'branding/extension');
const outDir = path.join(repoRoot, 'listing-kit');

/** Chrome Web Store's published asset rules. */
const IMAGE_SPECS = {
  screenshots: { sizes: [[1280, 800], [640, 400]], max: 5, required: true },
  'promo-small': { sizes: [[440, 280]], max: 1, required: false },
  'promo-marquee': { sizes: [[1400, 560]], max: 1, required: false },
};

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a PNG's dimensions and colour type straight from the IHDR chunk, which
 * always occupies a fixed offset right after the 8-byte signature. Avoids
 * pulling an image library into CI for what is a 25-byte read.
 * Returns null for anything that is not a PNG (JPEG is legal for the store, so
 * callers treat null as "cannot verify" rather than "invalid").
 */
function readPngHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(26);
    if (fs.readSync(fd, buf, 0, 26, 0) < 26) return null;
    const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) return null;
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      // 6 = truecolour with alpha, 4 = greyscale with alpha. The store rejects
      // both for screenshots and tiles ("24-bit PNG (no alpha)").
      hasAlpha: buf.readUInt8(25) === 6 || buf.readUInt8(25) === 4,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function collectImages(kind) {
  const dir = path.join(srcDir, 'listing', kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

const problems = [];

function validateImages(kind, files) {
  const spec = IMAGE_SPECS[kind];
  if (files.length === 0) {
    if (spec.required) {
      problems.push(
        `${kind}: none found in branding/extension/listing/${kind}/ — the Web Store requires at least one screenshot`
      );
    }
    return;
  }
  if (files.length > spec.max) {
    problems.push(`${kind}: ${files.length} files but the store accepts at most ${spec.max}`);
  }
  for (const file of files) {
    const header = readPngHeader(file);
    if (!header) continue; // JPEG — legal, dimensions unverified here.
    const matches = spec.sizes.some(([w, h]) => header.width === w && header.height === h);
    if (!matches) {
      const allowed = spec.sizes.map(([w, h]) => `${w}x${h}`).join(' or ');
      problems.push(
        `${path.basename(file)}: ${header.width}x${header.height} — ${kind} must be ${allowed}`
      );
    }
    if (header.hasAlpha) {
      problems.push(`${path.basename(file)}: has an alpha channel — the store requires 24-bit PNG without alpha`);
    }
  }
}

function section(title, body) {
  return `## ${title}\n\n${body}\n`;
}

function fencedBlock(text) {
  return '```\n' + String(text).trim() + '\n```';
}

function main() {
  if (!fs.existsSync(srcDir)) {
    console.log('ℹ️ No branding/extension found — skipping listing kit (unbranded build)');
    return 0;
  }

  const listing = readJSON(path.join(srcDir, 'listing.json')) || {};
  const privacy = readJSON(path.join(srcDir, 'privacy.json')) || {};
  const manifest = readJSON(path.join(repoRoot, 'apps/extension/manifest.json')) || {};

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const copied = {};
  for (const kind of Object.keys(IMAGE_SPECS)) {
    const files = collectImages(kind);
    validateImages(kind, files);
    copied[kind] = [];
    if (files.length === 0) continue;
    const destDir = path.join(outDir, kind);
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of files) {
      const dest = path.join(destDir, path.basename(file));
      fs.copyFileSync(file, dest);
      copied[kind].push(path.basename(file));
    }
  }

  // The dashboard's store description is a separate, much longer field than the
  // manifest description Chrome shows in the toolbar; only the latter is capped
  // at 132 chars. Reusing the short one is what left the listing at 31 chars.
  const storeDescription = listing.description || '';
  if (!storeDescription) {
    problems.push('listing.json: `description` is empty — the store listing needs real copy, not the manifest one-liner');
  }

  const permissionJustifications = privacy.permissionJustifications || {};
  const declaredPermissions = [
    ...(manifest.permissions || []),
    ...(manifest.host_permissions?.length || manifest.optional_host_permissions?.length
      ? ['host_permissions']
      : []),
  ];
  for (const permission of declaredPermissions) {
    if (!permissionJustifications[permission]) {
      problems.push(
        `privacy.json: no justification for "${permission}" which the packaged manifest requests`
      );
    }
  }

  const lines = [
    `# Chrome Web Store listing kit — ${manifest.name || 'unknown'} ${manifest.version || ''}`.trim(),
    '',
    'The Web Store API cannot write any of this. Paste it into the developer',
    'dashboard by hand: https://chrome.google.com/webstore/devconsole',
    '',
    section(
      'Store listing → Product details',
      [
        `- **Title** (from package): \`${manifest.name || ''}\``,
        `- **Summary** (from package): \`${manifest.description || ''}\``,
        `- **Category**: ${listing.category || '(unset in listing.json)'}`,
        `- **Language**: ${listing.language || '(unset in listing.json)'}`,
        '',
        '**Description**',
        '',
        storeDescription ? fencedBlock(storeDescription) : '_(missing — set `description` in listing.json)_',
      ].join('\n')
    ),
    section(
      'Store listing → Graphic assets',
      Object.entries(copied)
        .map(([kind, files]) =>
          files.length ? `- **${kind}**: ${files.join(', ')} (in \`${kind}/\`)` : `- **${kind}**: none`
        )
        .join('\n')
    ),
    section(
      'Privacy → Single purpose',
      privacy.singlePurpose
        ? fencedBlock(privacy.singlePurpose)
        : '_(missing — set `singlePurpose` in privacy.json)_'
    ),
    section(
      'Privacy → Permission justifications',
      Object.keys(permissionJustifications).length
        ? Object.entries(permissionJustifications)
            .map(([permission, text]) => `**${permission}**\n\n${fencedBlock(text)}`)
            .join('\n\n')
        : '_(missing — set `permissionJustifications` in privacy.json)_'
    ),
    section(
      'Privacy → Remote code & data usage',
      [
        `- **Remote code**: ${privacy.usesRemoteCode ? 'Yes' : 'No, I am not using remote code'}`,
        `- **Data collected**: ${(privacy.dataCollected || []).join(', ') || '(none declared)'}`,
        `- **Privacy policy URL**: ${privacy.privacyPolicyUrl || '(unset in privacy.json)'}`,
      ].join('\n')
    ),
    section(
      'Distribution',
      [
        `- **Visibility**: ${listing.visibility || '(unset in listing.json)'}`,
        `- **Regions**: ${listing.regions || 'all'}`,
        '',
        'Note: Private/unlisted items are still fully reviewed. For internal-only',
        'rollout, prefer Workspace admin force-install by extension ID.',
      ].join('\n')
    ),
  ];

  fs.writeFileSync(path.join(outDir, 'README.md'), lines.join('\n'));

  const total = Object.values(copied).reduce((n, files) => n + files.length, 0);
  console.log(`✓ Listing kit: ${total} image(s) + README.md → listing-kit/`);

  if (problems.length) {
    console.log('');
    for (const problem of problems) console.log(`::warning::listing kit — ${problem}`);
    console.log(`\n⚠️ ${problems.length} listing problem(s) above will cause or contribute to a review rejection.`);
  }
  return 0;
}

process.exit(main());
