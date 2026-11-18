# OpenCode Multi-Serve Validation

> **已废弃（ADR-0014，2026-09）.** 本地 runtime 已迁移至 pi-only；opencode / cursor / claude 后端已删除。本文保留作历史参考，现行架构见 `docs/architecture/pi-agent-backend.md`。

- OpenCode version: 1.18.18
- OS/architecture: Darwin/arm64
- Authenticated model: openai/gpt-5.4-mini-fast (OpenAI OAuth)
- Shared user data/config roots: PASS
- Parallel model calls: PASS
- Parallel tool execution: PASS
- Provider authentication visible in both: PASS
- Restart and session resume: PASS
- Database lock/corruption: NONE OBSERVED
- Cross-session SSE delivery: NONE OBSERVED
- RSS, 1 / 2 / 4 / 6 hosts: 366.1 MiB / 734.5 MiB / 1460.9 MiB / 1928.8 MiB
- Decision: GO — shared roots
