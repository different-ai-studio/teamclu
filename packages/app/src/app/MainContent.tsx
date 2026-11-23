//! Column three: the conversation. Files and web tabs open beside it in
//! column four; a nav section's items (skills, knowledge, ideas, contacts)
//! replace this column altogether — see components/content-column.

import { ChatPanel } from "@/components/chat/ChatPanel";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export function MainContent() {
  return (
    <div className="relative h-full flex flex-col">
      <div className="absolute inset-0">
        <ErrorBoundary scope="Chat" inline>
          <ChatPanel />
        </ErrorBoundary>
      </div>
    </div>
  );
}
