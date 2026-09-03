// session.ts — barrel file re-exporting everything for backwards compatibility
// All implementation has been split into focused modules:
//   session-store.ts      — Zustand store: v2 mirrors + draft/error/question state
//   session-types.ts      — Type/interface definitions
//   session-utils.ts      — Utility functions (workspacePathsMatch)

// Store
export { useSessionStore } from './session-store';
export type { SessionState, AnsweredQuestionSnapshot } from './session-store';

// Types
export type {
  PermissionAskedEvent,
  PendingPermissionEntry,
  ToolCallPermission,
  ToolCall,
  MessagePart,
  Message,
  Session,
  QueuedMessage,
} from './session-types';

// Utilities
export { workspacePathsMatch } from './session-utils';
