import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { RightPanel } from '@/components/panel/RightPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

// ── Mocks ────────────────────────────────────────────────────────────────────

// Use a mutable ref so tests can change the store's activeTab
const mockStoreState = { activeTab: 'shortcuts' as string };

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}));

vi.mock('@/stores/session', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ todos: [], sessionDiff: [] }),
}));

vi.mock('@/components/chat/SessionDiffPanel', () => ({
  SessionDiffPanel: ({ diff }: { diff: unknown[] }) =>
    React.createElement('div', { 'data-testid': 'session-diff' }, `${diff.length} diffs`),
}));

vi.mock('@/components/chat/SessionList', () => ({
  SessionList: () => React.createElement('div', { 'data-testid': 'session-list' }),
}));

vi.mock('@/components/workspace/FileBrowser', () => ({
  FileBrowser: ({ variant }: { variant?: string }) =>
    React.createElement('div', { 'data-testid': 'file-browser', 'data-variant': variant }),
}));

vi.mock('@/components/panel/ShortcutsPanel', () => ({
  ShortcutsPanel: () => React.createElement('div', { 'data-testid': 'shortcuts-panel' }),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RightPanel interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.activeTab = 'shortcuts';
  });

  describe('tab content rendering based on store state', () => {
    it('shows shortcuts tab when store activeTab is shortcuts', async () => {
      mockStoreState.activeTab = 'shortcuts';
      render(React.createElement(RightPanel));
      expect(screen.getByTestId('shortcuts-panel')).toBeDefined();
      expect(screen.queryByTestId('session-diff')).toBeNull();
      expect(screen.queryByTestId('file-browser')).toBeNull();
    });

    it('shows diff tab when store activeTab is diff', async () => {
      mockStoreState.activeTab = 'diff';
      render(React.createElement(RightPanel));
      expect(screen.getByText('No changes yet')).toBeDefined();
      expect(screen.queryByText('No tasks yet')).toBeNull();
    });

    it('shows session list when store activeTab is session', async () => {
      mockStoreState.activeTab = 'session';
      render(React.createElement(RightPanel));
      expect(screen.getByTestId('session-list')).toBeDefined();
      expect(screen.queryByText('No tasks yet')).toBeNull();
    });

    it('shows shortcuts panel when store activeTab is shortcuts', async () => {
      mockStoreState.activeTab = 'shortcuts';
      render(React.createElement(RightPanel));
      expect(screen.getByTestId('shortcuts-panel')).toBeDefined();
    });
  });

  describe('defaultTab overrides store tab', () => {
    it('uses defaultTab over store activeTab', async () => {
      mockStoreState.activeTab = 'shortcuts'; // store says shortcuts
      render(React.createElement(RightPanel, { defaultTab: 'diff' })); // but prop says diff
      expect(screen.getByText('No changes yet')).toBeDefined();
      expect(screen.queryByTestId('shortcuts-panel')).toBeNull();
    });
  });

  describe('data flow: props vs store fallback', () => {
    it('uses provided diff prop instead of store data', async () => {
      const customDiff = [
        { path: '/src/a.ts', before: 'old', after: 'new' },
      ];
      render(React.createElement(RightPanel, { defaultTab: 'diff', diff: customDiff }));
      expect(screen.getByTestId('session-diff')).toBeDefined();
      expect(screen.getByText('1 diffs')).toBeDefined();
    });

    it('uses shortcuts tab from store when no override is provided', async () => {
      render(React.createElement(RightPanel));
      expect(screen.getByTestId('shortcuts-panel')).toBeDefined();
    });

  });

  describe('compact mode', () => {
    it('applies compact padding class for tasks tab', async () => {
      const { container: compactEl } = render(React.createElement(RightPanel, { compact: true }));
      const { container: normalEl } = render(React.createElement(RightPanel, { compact: false }));
      // Compact should use p-1, normal should use p-2
      expect(compactEl.firstElementChild?.className).toContain('p-1');
      expect(normalEl.firstElementChild?.className).toContain('p-2');
    });

    it('removes padding for session and actors tabs', async () => {
      mockStoreState.activeTab = 'session';
      const { container } = render(React.createElement(RightPanel));
      // session/actors tabs should not have p-1 or p-2
      const className = container.firstElementChild?.className || '';
      expect(className).not.toContain('p-1');
      expect(className).not.toContain('p-2');
    });
  });

  describe('only one tab content is rendered at a time', () => {
    it('does not render multiple tabs simultaneously', async () => {
      mockStoreState.activeTab = 'shortcuts';
      render(React.createElement(RightPanel));

      // Only shortcuts should be visible
      expect(screen.getByTestId('shortcuts-panel')).toBeDefined();
      expect(screen.queryByTestId('session-diff')).toBeNull();
      expect(screen.queryByTestId('file-browser')).toBeNull();
      expect(screen.queryByTestId('session-list')).toBeNull();
      expect(screen.getAllByTestId('shortcuts-panel')).toHaveLength(1);
    });
  });
});
