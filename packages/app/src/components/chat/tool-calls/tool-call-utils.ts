import {
  Clock,
  Search,
  Circle,
  FileText,
  FilePen,
  Terminal,
  Globe,
  Zap,
  HelpCircle,
  Loader2,
  Check,
  X,
  Sparkles,
  Brain,
  Trash2,
  MoveRight,
} from "lucide-react";
import type { ToolCall } from "@/stores/session";

export type ToolCallLike = Pick<ToolCall, "name" | "toolKind" | "arguments">;

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Flatten tool arguments into string params for wire-name inference. */
export function paramsFromToolArguments(
  args: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!args) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    const s = stringParam(value);
    if (s) out[key] = s;
  }
  return out;
}

/**
 * Resolve canonical tool route id from ACP kind + daemon wire name + params.
 * Skill/role_load use ToolKind::Other on the wire (`tool_name: "other"`); the
 * human ACP title is copied into params.description (e.g. "skill").
 */
/** UI 路由 id：基于 kind + ACP title（存于 name）+ params 形状；不 mutate 存储的 name。 */
export function routeToolPresentation(toolCall: ToolCallLike): string {
  const title = (toolCall.name || "").trim();
  const titleLower = title.toLowerCase();
  const kind = toolCall.toolKind;
  const args = toolCall.arguments as Record<string, unknown> | undefined;
  const descHint = stringParam(args?.description)?.toLowerCase() ?? "";

  if (
    kind === "execute" ||
    titleLower === "bash" ||
    titleLower.includes("shell") ||
    titleLower.includes("terminal")
  ) {
    return "bash";
  }

  if (titleLower === "glob" || titleLower.startsWith("glob ")) return "glob";
  if (titleLower === "grep" || titleLower.startsWith("grep ")) return "grep";
  if (titleLower === "find" || titleLower.startsWith("find ")) return "find";

  if (
    kind === "fetch" ||
    titleLower === "webfetch" ||
    titleLower === "websearch" ||
    titleLower === "web_search"
  ) {
    return "web_search";
  }

  if (titleLower === "write" || titleLower === "write_file" || isContentOnlyWrite(args)) {
    return "write";
  }
  if (
    titleLower === "apply_patch" ||
    titleLower === "applypatch" ||
    extractPatchTextFromToolArgs(args ?? {})
  ) {
    return "apply_patch";
  }
  if (kind === "edit" || titleLower === "edit" || titleLower === "edit_file") {
    return "edit";
  }

  if (
    hasArgument(args, "subagent_type") ||
    hasArgument(args, "task_id") ||
    titleLower === "task"
  ) {
    return "task";
  }
  if (hasArgument(args, "todos") || titleLower.includes("todo")) return "todo_write";
  if (hasArgument(args, "questions") || titleLower === "question") return "question";

  if (descHint === "skill" || titleLower === "skill") return "skill";
  if (titleLower === "manage_skills") return "manage_skills";
  if (descHint === "role_skill" || titleLower === "role_skill") return "role_skill";
  if (descHint.includes("role_load") || titleLower.includes("role_load")) return "role_load";

  if (
    args?.name &&
    !args?.command &&
    !args?.path &&
    !args?.pattern &&
    !args?.query &&
    !args?.url
  ) {
    return "skill";
  }

  if (kind === "read" || titleLower === "read" || titleLower === "read_file") return "read";
  if (kind === "delete") return "delete";
  if (kind === "move") return "move";
  if (kind === "think") return "think";

  return titleLower || "unknown";
}

function isContentOnlyWrite(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  if (extractPatchTextFromToolArgs(args)) return false;
  if (
    "oldString" in args ||
    "old_string" in args ||
    "newString" in args ||
    "new_string" in args
  ) {
    return false;
  }
  const content = args.content ?? args.contents;
  return typeof content === "string" && content.trim().length > 0;
}

/**
 * @deprecated Prefer storing ACP title in `ToolCall.name` and routing via `routeToolPresentation`.
 * Kept for legacy metadata where tool_name was canonicalized (grep/bash) on the wire.
 */
export function resolveWireToolName(
  toolKind: string | undefined,
  wireName: string,
  params: Record<string, string> = {},
): string {
  const fromKind = toolNameFromKind(toolKind);
  if (fromKind) return fromKind;

  const normalized = wireName.trim().toLowerCase();
  if (normalized && normalized !== "other" && normalized !== "unknown") {
    return normalized;
  }

  const hint = (params.description ?? params._description ?? "").trim().toLowerCase();
  if (
    hint === "skill" ||
    hint === "role_skill" ||
    hint === "role_load" ||
    hint === "task" ||
    hint === "question"
  ) {
    return hint;
  }
  if (hint.includes("role_load")) return "role_load";
  if (hint.includes("role_skill")) return "role_skill";

  if (params.subagent_type || params.task_id) return "task";
  if (params.todos) return "todo_write";
  if (params.questions) return "question";
  if (params.role !== undefined && params.name) return "role_load";

  if (
    params.name &&
    !params.command &&
    !params.path &&
    !params.pattern &&
    !params.query &&
    !params.url
  ) {
    return "skill";
  }

  return normalized || "unknown";
}

export function resolvedToolName(toolCall: ToolCallLike): string {
  return routeToolPresentation(toolCall);
}

export function matchesWriteTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "write";
}

export function matchesEditTool(toolCall: ToolCallLike): boolean {
  const route = routeToolPresentation(toolCall);
  if (route === "write") return false;
  if (route === "edit" || route === "apply_patch") return true;
  if (toolCall.toolKind === "edit") return true;
  return isEditTool(toolCall.name);
}

export function skillNameFromToolCall(toolCall: ToolCallLike): string | undefined {
  const args = toolCall.arguments as { name?: unknown } | undefined;
  return stringParam(args?.name);
}

/** ACP `tool_kind` → icon/category hint (legacy routing only). */
export function toolNameFromKind(toolKind?: string): string {
  switch (toolKind) {
    case "execute":
      return "bash";
    case "search":
      return "grep";
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "fetch":
      return "web_search";
    case "delete":
      return "delete";
    case "move":
      return "move";
    case "think":
      return "think";
    default:
      return "";
  }
}

function hasArgument(
  args: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return Boolean(args && key in args);
}

export function matchesReadTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "read";
}

export function matchesShowPageNavLinksTool(toolCall: ToolCallLike): boolean {
  const name = (toolCall.name || "").trim().toLowerCase()
  const normalized = name.replace(/\s+/g, "_")
  return (
    normalized === "show_page_nav_links" ||
    name.endsWith("show_page_nav_links") ||
    name.includes("show page nav links")
  )
}

export function matchesCommandTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "bash";
}

export function matchesTodoTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "todo_write";
}

export function matchesTaskTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "task";
}

export function matchesSkillTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "skill";
}

export function matchesManageSkillsTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "manage_skills";
}

export function matchesRoleSkillTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "role_skill";
}

export function matchesRoleLoadTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "role_load";
}

export function matchesQuestionTool(toolCall: ToolCallLike): boolean {
  return routeToolPresentation(toolCall) === "question";
}

export function displayToolName(toolCall: ToolCallLike): string {
  return routeToolPresentation(toolCall);
}

type TranslateFn = (
  key: string,
  fallback?: string,
  options?: Record<string, unknown>,
) => string;

export function getStatusConfig(t: TranslateFn) {
  return {
    calling: {
      icon: Loader2,
      bgColor: "bg-muted/30",
      textColor: "text-muted-foreground",
      borderColor: "border-border",
      label: t("chat.toolCall.status.running", "Running"),
      animate: true,
    },
    completed: {
      icon: Check,
      bgColor: "bg-muted/20",
      textColor: "text-foreground/60",
      borderColor: "border-border",
      label: t("chat.toolCall.status.done", "Done"),
      animate: false,
    },
    failed: {
      icon: X,
      bgColor: "bg-muted/30",
      textColor: "text-red-600 dark:text-red-500",
      borderColor: "border-border",
      label: t("chat.toolCall.status.failed", "Failed"),
      animate: false,
    },
    waiting: {
      icon: Clock,
      bgColor: "bg-muted/30",
      textColor: "text-muted-foreground",
      borderColor: "border-border",
      label: t("chat.toolCall.status.waiting", "Waiting"),
      animate: true,
    },
  } as const;
}

// Get appropriate icon based on tool name
export function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase();
  if (name === "role_load") {
    return Sparkles;
  }
  if (name === "question") {
    return HelpCircle;
  }
  if (
    name.includes("search") ||
    name.includes("web") ||
    name.includes("fetch")
  ) {
    return Globe;
  }
  if (name.includes("glob")) {
    return Circle;
  }
  if (
    name.includes("file") ||
    name.includes("read") ||
    name.includes("write")
  ) {
    return FileText;
  }
  if (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("terminal")
  ) {
    return Terminal;
  }
  if (name.includes("find") || name.includes("grep")) {
    return Search;
  }
  return Zap;
}

// Get icon from ACP ToolKind (snake_case string from daemon).
// Falls back to Zap when kind is absent or unrecognized.
export function getToolIconByKind(kind: string | undefined) {
  switch (kind) {
    case "read":   return FileText;
    case "edit":   return FilePen;
    case "delete": return Trash2;
    case "move":   return MoveRight;
    case "search": return Search;
    case "execute": return Terminal;
    case "think":  return Brain;
    case "fetch":  return Globe;
    default:       return Zap;
  }
}

// Check if this is a question tool
export function isQuestionTool(toolName: string): boolean {
  return toolName.toLowerCase() === "question";
}

// Check if this is a Write tool
export function isWriteTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" || name === "write_file" || name === "writefile";
}

// Check if this is an Edit tool
export function isEditTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === "edit" ||
    name === "edit_file" ||
    name === "editfile" ||
    name === "str_replace" ||
    name === "strreplace" ||
    name === "apply_patch" ||
    name === "applypatch"
  );
}

// Check if this is a Read tool
export function isReadTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "read" || name === "read_file" || name === "readfile";
}

// Check if this is a command tool (bash, shell, terminal, run_command)
export function isCommandTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("terminal") ||
    name.includes("run_command")
  );
}

export function isTodoTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "todowrite" || name === "todoread" || name === "todo_write" || name === "todo_read";
}

export function isCommandToolLikelyWaitingForInput(
  _toolCall: Pick<ToolCall, "name" | "status" | "arguments" | "result">,
): boolean {
  return false;
}

// Check if this is a Task tool (subagent)
export function isTaskTool(toolName: string): boolean {
  return toolName.toLowerCase() === "task";
}

// Check if this is a Skill tool
export function isSkillTool(toolName: string): boolean {
  return toolName.toLowerCase() === "skill";
}

export function isRoleSkillTool(toolName: string): boolean {
  return toolName.toLowerCase() === "role_skill";
}

export function isRoleLoadTool(toolName: string): boolean {
  return toolName.toLowerCase() === "role_load";
}

// Get file extension from path
export function getFileExtension(path: string): string {
  const parts = path.split(".");
  return parts.length > 1 ? parts.pop()?.toLowerCase() || "" : "";
}

// Get language name for display
export function getLanguageName(ext: string): string {
  const langMap: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    rb: "Ruby",
    go: "Go",
    rs: "Rust",
    java: "Java",
    cpp: "C++",
    c: "C",
    h: "C Header",
    css: "CSS",
    scss: "SCSS",
    html: "HTML",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    md: "Markdown",
    sql: "SQL",
    sh: "Shell",
    bash: "Bash",
    zsh: "Zsh",
    toml: "TOML",
    xml: "XML",
    swift: "Swift",
    kt: "Kotlin",
  };
  return langMap[ext] || ext.toUpperCase();
}

// Format tool name for display
export function formatToolName(t: TranslateFn, name: string): string {
  if (name.toLowerCase() === "role_skill") {
    return t("chat.toolCall.roleSkill.title", "Role skill");
  }
  if (name.toLowerCase() === "manage_skills") {
    return t("chat.toolCall.manageSkills.title", "Manage skill");
  }
  if (name.toLowerCase() === "role_load") {
    return t("chat.toolCall.roleLoad.title", "Role Load");
  }
  return name
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

// Get filename from path
export function getFileName(path: string): string {
  return path.split("/").pop() || path;
}

// Extract file path from tool call arguments, trying multiple possible field names
export function extractFilePath(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const path =
    args.path || args.file || args.filePath || args.filepath ||
    args.file_path || args.filename || args.target_file || args.targetFile || "";
  return String(path);
}

const PATCH_ARG_KEYS = [
  "patch",
  "patchText",
  "diff",
  "unifiedDiff",
  "unified_diff",
  "udiff",
] as const;

/**
 * Parse a patch that only contains file deletions (*** Delete File: xxx).
 * Returns the list of deleted file paths, or null if the patch contains non-delete operations.
 */
export function parseDeleteOnlyPatch(patchText: string): string[] | null {
  const lines = patchText.trim().split('\n').filter(l => l.trim());
  const deleteFiles: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '*** Begin Patch' || trimmed === '*** End Patch') continue;
    const match = trimmed.match(/^\*\*\* Delete File:\s*(.+)$/);
    if (match) {
      deleteFiles.push(match[1].trim());
    } else {
      return null;
    }
  }

  return deleteFiles.length > 0 ? deleteFiles : null;
}

export type ManageSkillsToolResult = {
  slug?: string;
  path?: string;
  runtimeActivation?: string;
  warnings?: string[];
};

export function parseManageSkillsToolResult(result: unknown): ManageSkillsToolResult | null {
  let payload: unknown = result;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  return {
    slug: typeof record.slug === "string" ? record.slug : undefined,
    path: typeof record.path === "string" ? record.path : undefined,
    runtimeActivation:
      typeof record.runtimeActivation === "string" ? record.runtimeActivation : undefined,
    warnings: Array.isArray(record.warnings)
      ? record.warnings.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

/**
 * Extract raw patch / unified-diff text from apply_patch (and similar) tool arguments.
 */
export function extractPatchTextFromToolArgs(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;

  for (const k of PATCH_ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }

  const content = args.content;
  if (typeof content === "string" && content.trim().length > 0) {
    const t = content.trim();
    if (
      t.startsWith("diff --git") ||
      t.includes("*** Begin Patch") ||
      t.startsWith("--- ") ||
      t.includes("\n@@")
    ) {
      return content;
    }
  }

  for (const v of Object.values(args)) {
    if (typeof v !== "string" || v.trim().length === 0) continue;
    const t = v.trim();
    if (t.startsWith("diff --git") || t.includes("*** Begin Patch")) {
      return v;
    }
  }

  return null;
}
