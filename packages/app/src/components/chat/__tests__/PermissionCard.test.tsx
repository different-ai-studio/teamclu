import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useSessionStore } from '@/stores/session-store';
import { useSessionSelectionStore } from '@/stores/session-selection-store';
import { useV2StreamingStore } from '@/stores/v2-streaming-store';
import {
  resetSessionPermissionModesForTests,
  setSessionPermissionMode,
} from '@/lib/session/session-permission-mode';
import { PendingPermissionInline } from '../PendingPermissionInline';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      const template = fallback ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(options?.[token] ?? `{{${token}}}`));
    },
  }),
}));

vi.mock('@/hooks/use-actor-display-name', () => ({
  useActorDisplayName: (actorId: string) => `Agent-${actorId}`,
}));

/// Session selection lives in `useSessionSelectionStore`. `useSessionStore`
/// carries a copy, kept current by a one-way subscription in `session-store.ts`
/// — so seeding the copy leaves the source null, and `ComposerStack` reads the
/// source. Drive the source and the copy follows, the same way it does in the app.
function seedActiveSession(sessionId: string | null) {
  useSessionSelectionStore.setState({
    activeSessionId: sessionId,
    currentSessionId: sessionId,
  });
}

function resetStores() {
  resetSessionPermissionModesForTests();
  seedActiveSession(null);
  useV2StreamingStore.setState({ byKey: {} });
  useSessionStore.setState({
    activeSessionId: null,
    sessions: [],
    pendingPermissions: [],
    replyPermission: vi.fn(() => Promise.resolve()),
  });
}

describe('PendingPermissionInline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('does not render when session is in fullAccess mode', async () => {
    setSessionPermissionMode('sess-full', 'fullAccess');
    seedActiveSession('sess-full');
    useSessionStore.setState({
      pendingPermissions: [
        {
          permission: {
            id: 'perm-1',
            permission: 'bash',
            patterns: ['ls'],
          },
          childSessionId: null,
          ownerSessionId: 'sess-full',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.queryByTestId('streaming-agents-dock')).toBeNull();
  });

  it('renders permission request details', async () => {
    useSessionStore.setState({
      pendingPermissions: [
        {
          permission: {
            id: 'perm-1',
            permission: 'bash',
            patterns: ['ls -la'],
          },
          childSessionId: 'child-sess-1',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByTestId('streaming-agents-dock')).toBeTruthy();
    expect(screen.getByTestId('streaming-agent-shell')).toBeTruthy();

    const card = screen.getByTestId('pending-permission-card');
    expect(card.className).toContain('border-b');

    const actions = screen.getByTestId('pending-permission-actions');
    expect(actions.className).toContain('flex-col');

    expect(screen.getByText('Bash Request command execution')).toBeTruthy();
    expect(screen.getByText('ls -la')).toBeTruthy();
    expect(screen.getByText('Allow')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
  });

  it('summarizes long bash command details to avoid squeezing the UI', async () => {
    const longCommand = "ps -axo pid,ppid,stat,command rg '[[:<:]]8082[[:>:]]' printf 'no ps-visible process args mention 8082\\n'"
    useSessionStore.setState({
      pendingPermissions: [
        {
          permission: {
            id: 'perm-long-bash',
            permission: 'bash',
            patterns: [longCommand],
          },
          childSessionId: 'child-sess-long',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText(/ps -axo pid,ppid,stat,command/)).toBeTruthy();
    expect(screen.getByText((text) => text.includes(' ... '))).toBeTruthy();
    expect(screen.queryByText(longCommand)).toBeNull();
  });

  it('clicking allow calls replyPermission with correct arguments', async () => {
    const replyMock = vi.fn(() => Promise.resolve());
    useSessionStore.setState({
      replyPermission: replyMock,
      pendingPermissions: [
        {
          permission: {
            id: 'perm-1',
            permission: 'bash',
            patterns: ['ls -la'],
          },
          childSessionId: 'child-sess-1',
        },
      ],
    });

    render(<PendingPermissionInline />);

    const allowButton = screen.getByText('Allow').closest('button');
    expect(allowButton).not.toBeNull();
    fireEvent.click(allowButton!);

    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith('perm-1', 'allow');
    });
  });

  it('promotes the next queued permission immediately before reply resolves', async () => {
    let resolveReply: (() => void) | null = null;
    const replyMock = vi.fn(() => new Promise<void>((resolve) => {
      resolveReply = resolve;
    }));
    useSessionStore.setState({
      replyPermission: replyMock,
      pendingPermissions: [
        {
          permission: {
            id: 'perm-1',
            permission: 'bash',
            patterns: ['first-command'],
          },
          childSessionId: 'child-sess-1',
        },
        {
          permission: {
            id: 'perm-2',
            permission: 'read',
            patterns: ['second-path'],
          },
          childSessionId: 'child-sess-2',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText('first-command')).toBeTruthy();
    fireEvent.click(screen.getByText('Allow'));

    await waitFor(() => {
      expect(screen.queryByText('first-command')).toBeNull();
      expect(screen.getByText('second-path')).toBeTruthy();
    });

    resolveReply?.();
    await waitFor(() => {
      expect(replyMock).toHaveBeenCalledWith('perm-1', 'allow');
    });
  });

  it('renders unified action group for skill permissions without command or file details', async () => {
    useSessionStore.setState({
      pendingPermissions: [
        {
          permission: {
            id: 'perm-skill-1',
            permission: 'skill',
            patterns: [],
            metadata: {
              skill: 'brainstorming',
            },
          },
          childSessionId: 'child-sess-2',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText('Skill Request skill run')).toBeTruthy();
    expect(screen.getByText('Allow')).toBeTruthy();
    expect(screen.getByText('Always allow')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
    expect(screen.getByText('brainstorming')).toBeTruthy();
  });

  it('renders only the oldest permission with queue position when multiple are pending', async () => {
    useSessionStore.setState({
      pendingPermissions: [
        {
          permission: {
            id: 'perm-1',
            permission: 'bash',
            patterns: ['first-command'],
          },
          childSessionId: 'child-sess-1',
        },
        {
          permission: {
            id: 'perm-2',
            permission: 'skill',
            patterns: [],
            metadata: {
              skill: 'second-skill',
            },
          },
          childSessionId: 'child-sess-2',
        },
        {
          permission: {
            id: 'perm-3',
            permission: 'read',
            patterns: ['third-path'],
          },
          childSessionId: 'child-sess-3',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText('first-command')).toBeTruthy();
    expect(screen.queryByText('second-skill')).toBeNull();
    expect(screen.queryByText('third-path')).toBeNull();
    expect(screen.getByTestId('pending-permission-queue').textContent).toMatch(/1.*\/.*3/);
    expect(screen.getByTestId('pending-permission-actions')).toBeTruthy();
  });

  it('does not render a global pending permission owned by a different active session', async () => {
    seedActiveSession('session-2');
    useSessionStore.setState({
      sessions: [
        { id: 'session-1', messages: [] },
        { id: 'session-2', messages: [] },
      ],
      pendingPermissions: [
        {
          permission: {
            id: 'perm-session-1',
            sessionID: 'child-session-1',
            permission: 'bash',
            patterns: ['belongs-to-session-1'],
          },
          childSessionId: 'child-session-1',
          ownerSessionId: 'session-1',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.queryByTestId('streaming-agents-dock')).toBeNull();
    expect(screen.queryByText('belongs-to-session-1')).toBeNull();
  });

  it('renders a child-session global pending permission for its owning active session', async () => {
    seedActiveSession('parent-1');
    useSessionStore.setState({
      sessions: [
        { id: 'parent-1', messages: [] },
      ],
      pendingPermissions: [
        {
          permission: {
            id: 'perm-child-owned',
            sessionID: 'child-session-owned',
            permission: 'bash',
            patterns: ['child-owned-command'],
          },
          childSessionId: 'child-session-owned',
          ownerSessionId: 'parent-1',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText('child-owned-command')).toBeTruthy();
    expect(screen.getByText('A subagent is waiting for your approval')).toBeTruthy();
  });

  it('uses the same stacked approval UI for tool-attached and child-session permissions together', async () => {
    seedActiveSession('session-1');
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          messages: [
            {
              toolCalls: [
                {
                  id: 'tool-1',
                  name: 'bash',
                  status: 'waiting',
                  permission: {
                    id: 'perm-tool-1',
                    permission: 'external_directory',
                    patterns: ['/tmp/outside'],
                    metadata: {
                      file: '/tmp/outside',
                    },
                    decision: 'pending',
                  },
                },
              ],
            },
          ],
        },
      ],
      pendingPermissions: [
        {
          permission: {
            id: 'perm-child-1',
            permission: 'skill',
            patterns: [],
            metadata: {
              skill: 'brainstorming',
            },
          },
          childSessionId: 'child-sess-1',
          ownerSessionId: 'session-1',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText('Bash Request external path access')).toBeTruthy();
    expect(screen.getByText('/tmp/outside')).toBeTruthy();
    expect(screen.queryByText('brainstorming')).toBeNull();
    expect(screen.getByTestId('pending-permission-queue').textContent).toMatch(/1.*\/.*2/);
  });

  it('renders child-session permissions even when child streaming state is already gone', async () => {
    useSessionStore.setState({
      pendingPermissions: [
        {
          permission: {
            id: 'perm-edit-1',
            permission: 'edit',
            patterns: ['notes.md'],
            metadata: {
              file: '/workspace/notes.md',
            },
          },
          childSessionId: 'child-sess-edit',
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText('Edit Request file edit')).toBeTruthy();
    expect(screen.getByText('/workspace/notes.md')).toBeTruthy();
    expect(screen.getByText('Allow')).toBeTruthy();
  });

  it('renders tool-attached permissions from the active session above the input', async () => {
    seedActiveSession('session-1');
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          messages: [
            {
              toolCalls: [
                {
                  id: 'tool-1',
                  status: 'waiting',
                  permission: {
                    id: 'perm-tool-1',
                    permission: 'bash',
                    patterns: ['pnpm test'],
                    decision: 'pending',
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText('Bash Request command execution')).toBeTruthy();
    expect(screen.getByText('pnpm test')).toBeTruthy();
    expect(screen.getByText('A tool call is waiting for your approval')).toBeTruthy();
  });

  it('uses the source tool context for external directory approvals', async () => {
    seedActiveSession('session-1');
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          messages: [
            {
              toolCalls: [
                {
                  id: 'tool-bash-1',
                  name: 'bash',
                  status: 'waiting',
                  permission: {
                    id: 'perm-tool-external-1',
                    permission: 'external_directory',
                    patterns: ['/tmp/outside'],
                    metadata: {
                      file: '/tmp/outside',
                    },
                    decision: 'pending',
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    render(<PendingPermissionInline />);

    expect(screen.getByText('Bash Request external path access')).toBeTruthy();
    expect(screen.getByText('/tmp/outside')).toBeTruthy();
    expect(screen.getByText('From Bash tool call')).toBeTruthy();
  });
});
