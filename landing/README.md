# teamclu.ai — landing site

The Product Hunt launch link. Product Hunt has no landing page requirement, but
a team-shaped product that points its `Link` field at a source tree loses the
visitor in the first ten seconds: PH traffic cannot tell what "shared skills"
means from a directory listing.

Static HTML and CSS. No JavaScript, no build step, no dependencies — it is
served straight off Cloudflare Pages, and anything interactive here would be
something a visitor can block and lose.

## Layout

    index.html        English (the PH landing page)
    zh/index.html     Chinese
    styles.css        shared, both languages
    assets/           mirror of producthunt-kit/screenshots/ — see below
    _headers          Cloudflare Pages headers
    robots.txt
    sitemap.xml

## assets/ is generated, not edited

`assets/` holds a copy of the Product Hunt gallery. The site is served with
`landing/` as the document root, so it cannot reach up into
`producthunt-kit/`. That copy is written by:

```bash
node scripts/build-producthunt-gallery.mjs
```

Re-capture a screenshot, re-run the script, and both the PH gallery and this
site get the new image. Never hand-edit `assets/` — the next run overwrites it.

## Deploy

`landing/` is the whole site. With wrangler:

```bash
wrangler login                                     # interactive; can't run from an agent session
wrangler pages project create teamclu-site         # first run only
wrangler pages deploy landing --project-name teamclu-site --branch main
```

Flags verified against `wrangler pages deploy --help` on wrangler 4.125. After
the first deploy, only the last line is needed.

Attach the domain once, in the Cloudflare dashboard:
Pages → teamclu-site → Custom domains → `teamclu.ai` (and `www.teamclu.ai`).

Then check it:

```bash
curl -sI https://teamclu.ai/    | head -1   # want 200
curl -sI https://teamclu.ai/zh/ | head -1
curl -s  https://teamclu.ai/robots.txt
```

`_headers` is honoured by Pages only. If this ever moves to a Worker's static
assets, the cache and security headers have to be reconfigured by hand — one of
the reasons it is on Pages.

## Changing the copy

The English and Chinese pages are separate files on purpose. Shared CSS, shared
assets, shared structure — but a bilingual site that toggles in one document
needs JavaScript, and a machine-translated toggle reads worse than two honest
pages. If you change a claim on one side, change it on the other; the FAQ
answers deliberately include what *isn't* built yet, and that should not drift
between languages.

Design tokens and the coral-accent budget are in `AGENTS.md` §1. Coral is the
primary button and the section markers — two spots per frame, no more.
