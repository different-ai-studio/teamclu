# Session 附件上云（pi-extension 原生工具）

- **Status**: DRAFT
- **Scope**: 仅 pi + `teamclu.ts`；不新增 introspect / MCP 工具名
- **Non-scope**: team-documents 同步、自动扫描 workspace 改动

---

## Pi 工具契约（模型可见）

注册：`pi.registerTool` in `apps/daemon/assets/pi-extension/teamclu.ts`。

| 字段 | 值 |
|------|-----|
| `name` | `session_attach_file` |
| `label` | `Session attach file` |

### Description（写入 `description`，英文，给模型）

```text
Upload a local file to the current TeamClu chat session so other participants can download it. Use only for deliverables the team should see (reports, exports, diagrams). Do not upload secrets, credentials, .env, or scratch files. Writing a file to disk does not share it — call this tool when sharing is intended. The file must already exist at file_path under your workspace. Teammates cannot read paths on your machine from your reply text alone.
```

### Tool request（`execute` 的 `params`）

JSON Schema（`parameters`）：

```json
{
  "type": "object",
  "required": ["file_path"],
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Absolute path to an existing file under this agent's workspace (runtime worktree). Symlinks outside the worktree are rejected."
    },
    "message": {
      "type": "string",
      "description": "Optional short caption shown with the attachment in the session transcript. Omit if the main reply already explains the file."
    }
  },
  "additionalProperties": false
}
```

示例：

```json
{ "file_path": "/Users/me/project/out/report.pdf", "message": "Q3 汇总 PDF" }
```

**禁止出现在 params 里**：`session_id`、`team_id`、`url`、`reply_token`（由 extension + daemon 绑定当前会话）。

### Tool response（`AgentToolResult.content[0].text`）

固定为 **单行 JSON 字符串**（pretty 可选）。`isError: true` 当且仅当 `ok === false`。

**成功** `ok: true`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `true` | |
| `fileName` | string | 原始文件名 |
| `mimeType` | string | 推断 MIME |
| `size` | number | 字节数 |
| `storagePath` | string | 对象存储 path：`{teamId}/{teamcluSessionId}/{uuid}/{safeFileName}` |
| `url` | string | 公网 attachment URL（与用户上传一致；turn 结束时写入 `[Attachment: …] (url: …)`） |

```json
{
  "ok": true,
  "fileName": "report.pdf",
  "mimeType": "application/pdf",
  "size": 1048576,
  "storagePath": "team-uuid/session-uuid/attachment-uuid/report.pdf",
  "url": "https://…/attachments/team-uuid/session-uuid/…/report.pdf"
}
```

**失败** `ok: false`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `false` | |
| `error` | string | 机器可读 code（见下表） |
| `message` | string | 给模型看的短说明 |

| `error` | 含义 |
|---------|------|
| `session_context_unavailable` | 当前 pi session 未绑定 TeamClu 云 session（resolve 失败） |
| `path_not_allowed` | 路径不在 worktree 内或不可读 |
| `read_failed` | 读盘失败 |
| `upload_failed` | `POST /v1/attachments` 失败 |
| `turn_window_closed` | 当前无进行中的 agent turn（仅能在同步 toolcall、turn open 时调用） |

```json
{
  "ok": false,
  "error": "path_not_allowed",
  "message": "file_path must be under the current workspace"
}
```

Extension 在 `session_context_unavailable` 时也可直接返回现有 `sessionContextUnavailableResult()` 文案；规范上仍建议统一为上述 JSON。

---

## Internal API（extension → daemon，模型不可见）

`POST /internal/runtime-context/session-attach`

- **Auth**：loopback + `Authorization: Bearer $TEAMCLU_RUNTIME_CONTEXT_TOKEN`（与 resolve / session-prompt 相同）
- **Body**：

```json
{
  "backendSessionId": "<pi ctx.ui.sessionId>",
  "hostGenerationId": "<TEAMCLU_HOST_GENERATION_ID>",
  "backendKind": "pi",
  "filePath": "<params.file_path>",
  "message": "<params.message | omitted>"
}
```

- **Response 200**（daemon 成功；extension 将其映射为 tool response 字段）：

```json
{
  "ok": true,
  "teamcluSessionId": "…",
  "fileName": "…",
  "mimeType": "…",
  "size": 0,
  "storagePath": "…",
  "url": "…"
}
```

- **Response 4xx/5xx**：JSON `{ "error": "<code>", "message": "…" }` → extension 转为 `{ ok: false, error, message }`。

---

## 上云参数从哪来

| 参数 | 来源 |
|------|------|
| `backendSessionId` | pi `ctx.ui.sessionId` |
| `hostGenerationId` | env `TEAMCLU_HOST_GENERATION_ID` |
| `backendKind` | env `TEAMCLU_AGENT_BACKEND`（pi） |
| `teamcluSessionId` | `POST /internal/runtime-context/resolve`（Bearer `TEAMCLU_RUNTIME_CONTEXT_TOKEN`） |
| `runtimeId` | 同上 resolve 响应 |
| `teamId` | daemon 当前 onboard 团队（handler 内读，不信任客户端） |
| `storagePath` | `{teamId}/{teamcluSessionId}/{uuid}/{safeFileName}` |
| `mime` / `size` | 读文件后推断 |

Extension **不**拼 Cloud API URL；只调 daemon internal 接口。

---

## 上云流程

```text
session_attach_file (extension)   // 同步；仅 agent 本轮回答过程中的 toolcall
  → POST /internal/runtime-context/session-attach  (loopback + Bearer)
  → daemon: resolve 校验 → canonical 路径 ∈ runtime.worktree
  → turn_attachments::is_open(teamcluSessionId) 必须为 true，否则 turn_window_closed
  → read bytes → Backend.upload_attachment_bytes(path, …)
  → turn_attachments.attach（暂不发消息）
  → turn Idle 时 collect，合并进**一条** turn-final agent_reply（正文 + attachments JSONB）
```

**Turn 窗口**：pi `Active→Idle` 与 gateway 对齐：`open` on turn start，`close` + 合并 on turn end（待接 pi，见实现清单）。**无**单独 immediate 消息分支。

**存储**: bucket `attachments`；与用户 `uploadAttachment` 同栈，path 规则一致。

---

## 鉴权与安全

| 风险 | 措施 |
|------|------|
| 伪造 session | 必须 resolve：`backendSessionId + hostGenerationId + token` → `teamcluSessionId`；body 不得单独信 session |
| 非 agent 调用 internal API | 路由 **loopback only**；Bearer 为 amuxd 写入 pi 子进程的 **generation token**（与 resolve/session-prompt 相同） |
| 读任意本机文件 | `file_path` canonical 后必须是 `runtime.worktree` 前缀；否则 `path_not_allowed` |
| 越权对象存储 | upload 用 daemon **团队 access token**（FC/RLS）；path 含 `teamId/sessionId` |
| 本地其他用户调 sock | **不走** `amuxd.sock`（无 generation token）；仅 pi 进程内 extension → HTTP |
| 模型填错 session | schema 无 session 字段；服务端唯一绑定 |

**Cron**: 同为 pi turn；若 cron runtime 已 `register_attached_session`，resolve 可用，工具行为一致。无绑定 → `session_context_unavailable`。

---

## 实现清单

1. `teamclu.ts`: `registerTool("session_attach_file", …)` + fetch internal attach
2. `apps/daemon`: `POST /internal/runtime-context/session-attach` + upload/record
3. `messaging.rs`（pi）: `turn_attachments` open/close + final reply 合并 attachments
4. `session_prompt` append 一句工具使用说明
5. 单测：path 校验、resolve 失败、turn closed 拒绝、turn end 合并一条 reply
