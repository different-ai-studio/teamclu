import { describe, expect, it, beforeEach } from "vitest";
import {
  isTodoToolInvocation,
  mapRawTodosToPlanEntries,
  syncPlanFromTodoTool,
  syncPlanFromTodoToolResult,
} from "@/lib/stream/sync-plan-from-todowrite";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

describe("syncPlanFromTodoTool", () => {
  beforeEach(() => {
    useV2StreamingStore.setState({ byKey: {}, archived: [], persistedPlansBySession: {} });
  });

  it("detects todowrite via params.todos on other-kind wire name", () => {
    expect(
      isTodoToolInvocation("other", {
        description: "todowrite",
        todos: '[{"content":"A","status":"pending","priority":"high"}]',
      }),
    ).toBe(true);
  });

  it("maps tool result summary into planEntries for the inline dock", () => {
    const summary = JSON.stringify([
      { content: "优化搜索结果页面加载速度", status: "pending", priority: "high" },
      { content: "修复用户头像上传失败问题", status: "pending", priority: "medium" },
    ]);

    const synced = syncPlanFromTodoTool("sess-1", "agent-1", {
      toolName: "todo_write",
      params: { description: "todowrite" },
      summary,
      success: true,
    });

    expect(synced).toBe(true);
    const key = "sess-1::agent-1";
    expect(useV2StreamingStore.getState().byKey[key]?.planEntries).toHaveLength(2);
    expect(useV2StreamingStore.getState().byKey[key]?.planEntries[0].content).toBe(
      "优化搜索结果页面加载速度",
    );
  });

  it("syncs from params.todos on toolUse before result lands", () => {
    const todos = JSON.stringify([
      { content: "编写消息模块单元测试", status: "pending", priority: "medium" },
    ]);

    syncPlanFromTodoTool("sess-1", "agent-1", {
      toolName: "other",
      params: { description: "todowrite", todos },
    });

    expect(useV2StreamingStore.getState().byKey["sess-1::agent-1"]?.planEntries).toHaveLength(1);
  });

  it("does not sync failed todo tool results", () => {
    syncPlanFromTodoTool("sess-1", "agent-1", {
      toolName: "todo_write",
      params: {},
      summary: '[{"content":"x","status":"pending"}]',
      success: false,
    });

    expect(useV2StreamingStore.getState().byKey["sess-1::agent-1"]).toBeUndefined();
  });

  it("syncPlanFromTodoToolResult reads the completed tool row from the stream store", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("sess-1", "agent-1", {
      toolId: "call_00",
      toolName: "todo_write",
      description: "todowrite",
      params: {
        description: "todowrite",
        todos: '[{"content":"更新依赖","status":"pending","priority":"low"}]',
      },
    });

    const synced = syncPlanFromTodoToolResult("sess-1", "agent-1", {
      toolId: "call_00",
      success: true,
      summary: '[{"content":"更新依赖","status":"pending","priority":"low"}]',
    });

    expect(synced).toBe(true);
    expect(useV2StreamingStore.getState().byKey["sess-1::agent-1"]?.planEntries).toHaveLength(1);
  });

  it("mapRawTodosToPlanEntries drops empty content rows", () => {
    expect(
      mapRawTodosToPlanEntries([
        { content: "  ", status: "pending" },
        { content: "ok", status: "in_progress", priority: "high" },
      ]),
    ).toEqual([
      { content: "ok", status: "in_progress", priority: "high" },
    ]);
  });
});
