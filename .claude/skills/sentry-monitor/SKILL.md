---
name: sentry-monitor
description: Use when the user wants to check Sentry issues, run a Sentry daily report, or monitor error trends. Triggers on "sentry 监控", "sentry 日报", "查看 sentry", "sentry report", "sentry monitor".
---

# Sentry Monitor — Daily Issue Report

Scan the TeamClu Sentry projects for unresolved fatal/high issues, analyze root
causes, and report.

## Projects

| Project | Sentry Slug | Platform |
|---------|-------------|----------|
| Web / desktop frontend | `ucar-inc/teamclu-react` | JavaScript React |
| Desktop Rust process | `ucar-inc/teamclu-rust` | Rust |
| iOS | `ucar-inc/teamclu-ios` | apple-ios |
| Expo | `ucar-inc/teamclu-expo` | react-native |

`ucar-inc/teamclu` (the old Rust slug) **does not exist** — it was deleted, and
`sentry issue list` 404s on it. `teamclu-rust` replaced it on 2026-09-04, so
that project has no history before then; an empty result there is expected for a
while rather than a signal. Re-verify with `sentry project list ucar-inc/ --json`
if a scan errors on an unknown project.

## Execution Steps

### 0. Quota gate — do this FIRST

The org is on Sentry's free tier: **5,000 errors/month, `onDemandMaxSpend = 0`**,
billing period resetting on the **19th**. When the quota runs out Sentry drops
every incoming event **silently** — from the issue list that looks identical to
"no new errors." This has already happened twice (2026-08-17 and 2026-09-02),
and the second time the projects sat blind for over two weeks.

Never report "全部正常" without clearing this check.

```bash
sentry api "/organizations/ucar-inc/stats_v2/?field=sum(quantity)&groupBy=outcome&category=error&statsPeriod=7d&interval=1d"
```

Read the `accepted` and `rate_limited` series:

- `accepted` non-zero for the most recent day → ingestion is healthy, continue.
- `accepted` at 0 with `rate_limited` climbing → **quota exhausted**. Stop the
  normal report. Lead with this instead, get the exact numbers from
  `sentry api "/customers/ucar-inc/"` (`categories.errors`: `usage` /
  `reserved` / `usageExceeded`, plus `billingPeriodEnd`), and say plainly that
  the issue list below is stale as of the last accepted event.

### 1. Scan Issues

Run these in parallel, one per project:

```bash
sentry issue list ucar-inc/teamclu-react --query "is:unresolved" --period 48h --json --fields shortId,title,priority,level,status --limit 30
sentry issue list ucar-inc/teamclu-rust  --query "is:unresolved" --period 48h --json --fields shortId,title,priority,level,status --limit 30
sentry issue list ucar-inc/teamclu-ios   --query "is:unresolved" --period 48h --json --fields shortId,title,priority,level,status --limit 30
sentry issue list ucar-inc/teamclu-expo  --query "is:unresolved" --period 48h --json --fields shortId,title,priority,level,status --limit 30
```

Use `--period` for the time window (`24h` / `48h` / `14d`), not a `lastSeen:`
clause. Default is 90 days, which is far wider than a daily report wants.

Filter results: keep only issues where `level` is `fatal` OR `priority` is
`high`.

**`--fields` gotcha (CLI 0.26.1):** `count`, `userCount`, `firstSeen` and
`lastSeen` are listed in `--help` but are silently dropped from `issue list`
output — you get the key omitted, not an error. Volume and recency have to come
from `sentry issue view <shortId> --json`, which does return them. Do not report
event counts sourced from `issue list`.

If no issues match **and step 0 was clean**, skip to step 4 with the "全部正常"
message. If step 0 was not clean, say so instead — an empty list under an
exhausted quota means nothing.

### 2. Analyze Root Causes (Local)

For each filtered issue (max 10 total), perform local root cause analysis:

1. Fetch issue details with stack trace, which also carries the volume numbers:

```bash
sentry issue view <shortId> --json
```

2. From the stack trace / error message, identify the relevant source files and
   functions in the codebase.

3. Read those source files to understand the code context around the error site.

4. Produce a one-sentence root cause summary based on the stack trace + source.

Two things worth checking before writing the summary:

- **Group splits.** The same defect often appears as several issues — a
  sourcemapped build and a minified one group separately. Compare `metadata.value`
  across the filtered set and treat identical values as one root cause rather
  than reporting the same bug three times.
- **Prefer a sourcemapped frame.** When several groups share a value, analyze
  the one whose `culprit` is a repo path (`/src/...`) rather than a bundle
  (`assets/index-*.js`) — it names the file directly.

When there are more than ~4 issues to analyze, run them as parallel subagents
via the Agent tool; each runs `sentry issue view`, reads the relevant sources,
and returns one sentence. For fewer than that, just do it inline — spawning
agents costs more than it saves.

If analysis cannot determine a root cause, use the error title as-is and say the
root cause is undetermined. Do not guess.

### 3. Format Report

```
Sentry 日报 <YYYY-MM-DD>

【Web / 桌面】N 个高优 issue
• <shortId> [<level>] <title> — 根因：<root cause summary>
• ...

【桌面 Rust】N 个高优 issue
• ...

【iOS】N 个高优 issue
• ...

【Expo】N 个高优 issue
• ...

修复命令：/sentry-fix <top-issue-id>
```

Omit any project section with zero matching issues. When step 0 found the quota
exhausted, put that first, above every section:

```
⚠️ Sentry 配额已耗尽（<usage>/<reserved>），<date> 起事件全部被丢弃，<billingPeriodEnd> 重置。
以下列表停留在最后一条被接收的事件，不代表当前状态。
```

### 4. Report Out

Present the report in the conversation.

**Pushing to WeCom is a separate step that needs the user's go-ahead**, unless
this run is the scheduled daily report (`/loop 24h /sentry-monitor`), where
pushing is the whole point. When the user asked for an analysis rather than a
daily report, show the report and offer to push — do not push unasked, since it
posts to a group chat.

```bash
wecom-cli msg send_message '{"chat_type": 2, "chatid": "wrOOClYgAA5gMJijxEUfWC6M0RAjwlWQ", "msgtype": "text", "text": {"content": "<report text>"}}'
```

If no fatal/high issues exist anywhere **and the quota gate was clean**:

```
Sentry 日报 <YYYY-MM-DD> — 全部正常，无高优 issue
```

## Usage

- One-time: `/sentry-monitor`
- Recurring: `/loop 24h /sentry-monitor`

## Constraints

- This skill is READ-ONLY. Never modify any code files.
- Do not attempt to fix issues. Only report them.
- If `sentry` CLI is not authenticated, prompt the user to run `sentry auth login`.
- Never pipe a `sentry` command through `tail`/`head` when you care about
  success — the pipeline's exit code is the pager's, so a failed call reads as
  exit 0. Redirect to a file and check `$?`.
