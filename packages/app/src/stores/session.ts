// session.ts — barrel file re-exporting everything for backwards compatibility
// All implementation has been split into focused modules:
//   session-store.ts      — Zustand create() composing all action creators
//   session-loader.ts     — Session CRUD: load, create, archive, setActive, etc.
//   session-messages.ts   — sendMessage, abortSession, message queue, reloadMessages
//   session-sse-handlers.ts — All SSE event handlers (message, tool, session lifecycle)
//   session-questions.ts  — Question tool handling
//   session-types.ts      — All type/interface definitions
//   session-cache.ts      — Session lookup cache utilities
//   session-internals.ts  — Module-level mutable state, timers, buffers
//   session-data-cache.ts — Session-specific data cache (todos, diffs, queue)
//   session-utils.ts      — Utility functions (workspacePathsMatch)

// Store
export { useSessionStore } from './session-store';

// Types
export type {
  PermissionAskedEvent,
  PendingPermissionEntry,
  ToolCallPermission,
  ToolCall,
  MessagePart,
  Message,
  Session,
  ChildStreamingState,
  QueuedMessage,
  SelectedModel,
  SessionState,
  SessionSet,
  SessionGet,
} from './session-types';

// Cache utilities
export { sessionLookupCache, getSessionById, updateSessionCache, UI_PAGE_SIZE } from './session-cache';

// Utilities
export { workspacePathsMatch } from './session-utils';
