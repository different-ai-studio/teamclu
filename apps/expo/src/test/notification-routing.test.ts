import { describe, expect, it } from "vitest";

import {
  notificationResponseDedupeKey,
  notificationResponseToSessionHref,
  sessionIdFromNotificationData,
} from "../features/notifications/notification-routing";

describe("notification routing", () => {
  it("extracts session_id from the APNs payload emitted by push-dispatch", () => {
    expect(
      sessionIdFromNotificationData({
        data: { session_id: "session-1", message_id: "message-1", kind: "message" },
      }),
    ).toBe("session-1");
  });

  it("accepts camelCase payloads and ignores blank session ids", () => {
    expect(sessionIdFromNotificationData({ sessionId: "session-2" })).toBe(
      "session-2",
    );
    expect(sessionIdFromNotificationData({ session_id: "   " })).toBeNull();
  });

  it("builds the Expo session href from a notification response", () => {
    expect(
      notificationResponseToSessionHref({
        notification: {
          request: {
            content: {
              data: { session_id: "session-3" },
            },
          },
        },
      }),
    ).toBe("/(app)/sessions/session-3");
  });

  it("builds a dedupe key from the notification request id instead of only the session", () => {
    expect(
      notificationResponseDedupeKey({
        notification: {
          request: {
            identifier: "notif-1",
            content: {
              data: { session_id: "session-3" },
            },
          },
        },
      }),
    ).toBe("notif-1:/(app)/sessions/session-3");
  });

  it("carries the pushed message id so the session can scroll to it", () => {
    expect(
      notificationResponseToSessionHref({
        notification: {
          request: {
            content: {
              data: { session_id: "session-3", message_id: "msg-9" },
            },
          },
        },
      }),
    ).toBe("/(app)/sessions/session-3?focusMessageId=msg-9");
  });
});
