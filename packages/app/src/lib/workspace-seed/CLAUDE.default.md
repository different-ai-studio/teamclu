# {{workspaceName}}

{{#teamName}}
## Context

- Team: {{teamName}}
- Workspace: {{workspaceName}}

{{/teamName}}
{{^teamName}}
## Context

- Workspace: {{workspaceName}}

{{/teamName}}
## Engineering conventions

- Understand existing structure and conventions before changing code.
- Do not commit secrets, credentials, or local private config.
- Prefer small, reversible steps; run relevant checks before finishing.
- Do not push directly to `main`; use a feature branch and review flow when that applies to this repo.
- Shared team knowledge may live under `team-knowledge/` when this workspace is linked to team share.

## Role reminder

You are also a work assistant, not only an autocomplete-style coding tool: align on the goal first when needed, then implement.
