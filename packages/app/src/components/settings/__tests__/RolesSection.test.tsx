import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const t = (k: string, d?: string) => d ?? k

const { mockLoadAllRoles, mockLoadAttachableSkills } = vi.hoisted(() => ({
  mockLoadAllRoles: vi.fn(async () => []),
  mockLoadAttachableSkills: vi.fn(async () => []),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t, i18n: { language: "en", changeLanguage: vi.fn() } }),
}))

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => sel({ workspacePath: null })),
}))

const startNewChat = vi.fn()
vi.mock("@/stores/ui", () => ({
  useUIStore: {
    getState: () => ({
      startNewChat,
    }),
  },
}))

const setDraftInput = vi.fn()
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({
      setDraftInput,
    }),
  },
}))

vi.mock("@/lib/utils", () => ({ cn: (...a: string[]) => a.join(" "), isTauri: () => false }))

vi.mock("../shared", () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

vi.mock("@/lib/roles/loader", () => ({
  attachSkillToRole: vi.fn(),
  createEmptyRoleEditorState: () => ({
    slug: "",
    name: "",
    description: "",
    role: "",
    whenToUse: "",
    workingStyle: "",
    roleSkills: [],
    rawMarkdown: "",
  }),
  deleteRole: vi.fn(),
  extractSkillDescription: vi.fn(() => ""),
  loadAllRoles: mockLoadAllRoles,
  loadAttachableSkills: mockLoadAttachableSkills,
  parseRoleMarkdown: vi.fn(),
  serializeRoleMarkdown: vi.fn(() => ""),
  saveRole: vi.fn(),
}))

import { RolesSection } from "../RolesSection"

describe("RolesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadAllRoles.mockResolvedValue([])
    mockLoadAttachableSkills.mockResolvedValue([])
  })

  it("renders the Roles title", () => {
    render(<RolesSection />)
    expect(screen.getByText("Roles")).toBeTruthy()
  })

  it("shows workspace selection prompt when no workspace", () => {
    render(<RolesSection />)
    expect(screen.getByText("Please select a workspace directory first")).toBeTruthy()
  })

  it("prefills the create-role skill chip when creating by agent", async () => {
    const { useWorkspaceStore } = await import("@/stores/workspace")
    vi.mocked(useWorkspaceStore).mockImplementation((selector: (s: any) => any) =>
      selector({ workspacePath: "/workspace" }),
    )

    render(<RolesSection />)

    fireEvent.click(screen.getByLabelText("Role creation options"))
    fireEvent.click(screen.getByText("Create by agent"))

    await waitFor(() => {
      expect(startNewChat).toHaveBeenCalled()
      expect(setDraftInput).toHaveBeenCalledWith("/{create-role} ")
    })
  })

  it("exposes linked skill chips as accessible navigation in embedded mode", async () => {
    mockLoadAllRoles.mockResolvedValueOnce([
      {
        slug: "java-sort-reviewer",
        name: "Java Sort Reviewer",
        description: "Reviews sort-heavy Java code.",
        body: "",
        role: "Review Java sorting changes.",
        whenToUse: "When sort logic changes.",
        workingStyle: "Direct and concise.",
        roleSkills: [{ name: "java-complexity-review", description: "Review complexity." }],
        filePath: "/workspace/.opencode/roles/java-sort-reviewer/ROLE.md",
        rawMarkdown: "",
      },
    ] as any)
    mockLoadAttachableSkills.mockResolvedValueOnce([])

    const { useWorkspaceStore } = await import("@/stores/workspace")
    vi.mocked(useWorkspaceStore).mockImplementation((selector: (s: any) => any) =>
      selector({ workspacePath: "/workspace" }),
    )

    render(<RolesSection embeddedConsole />)

    expect(await screen.findByRole("button", { name: /open linked skill/i })).toBeTruthy()
  })

  it("shows skeletons while embedded roles load", async () => {
    let resolveLoad: ((value: any) => void) | null = null
    mockLoadAllRoles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
    )
    mockLoadAttachableSkills.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolve([])
        }),
    )
    const { useWorkspaceStore } = await import("@/stores/workspace")
    vi.mocked(useWorkspaceStore).mockImplementation((selector: (s: any) => any) =>
      selector({ workspacePath: "/workspace" }),
    )

    render(<RolesSection embeddedConsole />)

    expect(screen.getByPlaceholderText("Search roles...")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)

    resolveLoad?.([])

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Refresh" })).toBeTruthy()
    })
  })
})
