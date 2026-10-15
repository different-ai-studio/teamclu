import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { SessionGroup } from "../features/sessions/session-types";

type ElementWithProps = React.ReactElement<{
  children?: React.ReactNode;
  style?: unknown;
}>;

vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) => React.createElement("Ionicons", props),
}));

vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "Light", Medium: "Medium" },
  NotificationFeedbackType: { Error: "Error", Success: "Success", Warning: "Warning" },
  impactAsync: vi.fn(() => Promise.resolve()),
  notificationAsync: vi.fn(() => Promise.resolve()),
  selectionAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock("../ui/action-sheet", () => ({ showActionSheet: vi.fn() }));

vi.mock("@shopify/flash-list", () => ({
  FlashList: (props: Record<string, unknown>) => React.createElement("FlashList", props),
}));

vi.mock("react-native", () => {
  const makeComponent =
    (name: string) =>
    (props: Record<string, unknown>) =>
      React.createElement(name, props, props.children as React.ReactNode);

  return {
    ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
    Alert: { alert: vi.fn() },
    Platform: { OS: "ios", select: (values: Record<string, unknown>) => values.ios ?? values.default },
    Pressable: makeComponent("Pressable"),
    RefreshControl: makeComponent("RefreshControl"),
    ScrollView: makeComponent("ScrollView"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
    Text: makeComponent("Text"),
    TextInput: makeComponent("TextInput"),
    View: makeComponent("View"),
  };
});

function firstChild(element: ElementWithProps): ElementWithProps {
  return React.Children.toArray(element.props.children).filter(React.isValidElement)[0] as ElementWithProps;
}

function elementChildren(element: ElementWithProps): ElementWithProps[] {
  return React.Children.toArray(element.props.children).filter(React.isValidElement) as ElementWithProps[];
}

describe("SessionGroupSection layout", () => {
  it("keeps row dividers outside the horizontal row content", async () => {
    const { SessionGroupSection } = await import(
      "../features/sessions/screens/SessionsListScreen"
    );
    const group: SessionGroup = {
      label: "Today",
      sessions: [
        {
          sessionId: "session-1",
          teamId: "team-1",
          title: "Session one",
          summary: "",
          participantCount: 2,
          participantActorIds: ["actor-1", "actor-2"],
          lastMessagePreview: "Latest message",
          lastMessageAt: "2026-05-21T02:00:00.000Z",
          createdAt: "2026-05-21T01:00:00.000Z",
          createdBy: "actor-1",
        },
        {
          sessionId: "session-2",
          teamId: "team-1",
          title: "Session two",
          summary: "",
          participantCount: 1,
          participantActorIds: ["actor-3"],
          lastMessagePreview: "Another message",
          lastMessageAt: "2026-05-21T03:00:00.000Z",
          createdAt: "2026-05-21T01:30:00.000Z",
          createdBy: "actor-3",
        },
      ],
    };

    const section = SessionGroupSection({
      group,
      onSelectSession: () => {},
      selectedSessionId: null,
      selectionMode: false,
      selection: new Set(),
    });

    const groupItems = elementChildren(section as ElementWithProps)[1];
    const firstRowWrapper = firstChild(groupItems);
    const firstRowChildren = elementChildren(firstRowWrapper);
    const horizontalRow = firstRowChildren[0];

    expect(firstRowWrapper.props.style).not.toMatchObject({ flexDirection: "row" });
    expect(horizontalRow.props.style).toMatchObject({ flexDirection: "row" });
  });
});
