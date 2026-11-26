import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  buildSkillInvocationName,
  loadAllSkills,
  getSkillDirectories,
} from "@/lib/skills/loader"

const mockExists = vi.fn()
const mockReadDir = vi.fn()
const mockReadTextFile = vi.fn()
const mockJoin = vi.fn((...args: string[]) => Promise.resolve(args.join("/")))
const mockHomeDir = vi.fn(() => Promise.resolve("/home/user"))

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (path: string) => mockExists(path),
  readDir: (path: string) => mockReadDir(path),
  readTextFile: (path: string) => mockReadTextFile(path),
}))

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: () => mockHomeDir(),
  join: (...args: unknown[]) => mockJoin(...(args as string[])),
}))

describe("skill-loader roots and bundles", () => {
  const workspacePath = "/tmp/ws"

  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockReturnValue(false)
    mockReadDir.mockResolvedValue([])
    mockReadTextFile.mockResolvedValue("# Test Skill\n")
    mockHomeDir.mockResolvedValue("/home/user")
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join("/")))
  })

  it("scans only the fixed roots; a workspace opencode.json declares nothing", async () => {
    mockExists.mockImplementation((path: string) =>
      Promise.resolve(path === `${workspacePath}/opencode.json`),
    )
    mockReadTextFile.mockResolvedValue(JSON.stringify({ skills: { paths: ["/opt/team-skills"] } }))

    expect(await getSkillDirectories(workspacePath)).toEqual([
      `${workspacePath}/.claude/skills`,
      "/home/user/.agents/skills",
      `${workspacePath}/.agents/skills`,
      "/home/user/.claude/skills",
    ])
    expect(mockReadTextFile).not.toHaveBeenCalledWith(`${workspacePath}/opencode.json`)
  })

  it("loads nested skills from bundle directories", async () => {
    const bundleDir = "/home/user/.agents/skills"
    const superpowersDir = `${bundleDir}/superpowers`

    mockExists.mockImplementation((path: string) => {
      if (path === bundleDir) return Promise.resolve(true)
      if (path === `${superpowersDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      if (path === `${superpowersDir}/systematic-debugging/SKILL.md`) return Promise.resolve(true)
      return Promise.resolve(false)
    })

    mockReadDir.mockImplementation((path: string) => {
      if (path === bundleDir) {
        return Promise.resolve([{ name: "superpowers", isDirectory: true }])
      }
      if (path === superpowersDir) {
        return Promise.resolve([
          { name: "brainstorming", isDirectory: true },
          { name: "systematic-debugging", isDirectory: true },
        ])
      }
      return Promise.resolve([])
    })

    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${superpowersDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\ndescription: Brainstorm first\n---\n")
      }
      if (path === `${superpowersDir}/systematic-debugging/SKILL.md`) {
        return Promise.resolve("---\nname: systematic-debugging\ndescription: Debug rigorously\n---\n")
      }
      return Promise.resolve("")
    })

    const { skills } = await loadAllSkills(workspacePath)
    const globalAgentSkills = skills.filter((s) => s.source === "global-agent")

    expect(globalAgentSkills.some((s) => s.filename === "brainstorming")).toBe(true)
    expect(globalAgentSkills.some((s) => s.filename === "systematic-debugging")).toBe(true)
    expect(globalAgentSkills.find((s) => s.filename === "brainstorming")?.dirPath).toBe(superpowersDir)
    expect(globalAgentSkills.find((s) => s.filename === "brainstorming")?.invocationName).toBe("superpowers/brainstorming")
  })

  it("prefers flat skill over bundled skill with same slug", async () => {
    const localDir = `${workspacePath}/.claude/skills`
    const globalBundleDir = "/home/user/.agents/skills"
    const superpowersDir = `${globalBundleDir}/superpowers`

    mockExists.mockImplementation((path: string) => {
      if (path === localDir) return Promise.resolve(true)
      if (path === globalBundleDir) return Promise.resolve(true)
      if (path === `${localDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      if (path === `${superpowersDir}/brainstorming/SKILL.md`) return Promise.resolve(true)
      return Promise.resolve(false)
    })

    mockReadDir.mockImplementation((path: string) => {
      if (path === localDir) {
        return Promise.resolve([{ name: "brainstorming", isDirectory: true }])
      }
      if (path === globalBundleDir) {
        return Promise.resolve([{ name: "superpowers", isDirectory: true }])
      }
      if (path === superpowersDir) {
        return Promise.resolve([{ name: "brainstorming", isDirectory: true }])
      }
      return Promise.resolve([])
    })

    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${localDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\ndescription: Local version\n---\n")
      }
      if (path === `${superpowersDir}/brainstorming/SKILL.md`) {
        return Promise.resolve("---\nname: brainstorming\ndescription: Global bundle version\n---\n")
      }
      return Promise.resolve("")
    })

    const { skills, overrides } = await loadAllSkills(workspacePath)
    const resolved = skills.find((s) => s.filename === "brainstorming")

    expect(resolved?.source).toBe("claude")
    expect(resolved?.dirPath).toBe(localDir)
    expect(resolved?.invocationName).toBe("brainstorming")
    expect(overrides).toContainEqual({
      name: "brainstorming",
      winner: "claude",
      loser: "global-agent",
    })
  })

  it("builds namespaced invocation names for bundled skills only", () => {
    expect(buildSkillInvocationName("/home/user/.agents/skills", "brainstorming")).toBe("brainstorming")
    expect(buildSkillInvocationName("/home/user/.agents/skills/superpowers", "brainstorming")).toBe("superpowers/brainstorming")
  })

  it("builds invocation names from Windows paths", () => {
    expect(buildSkillInvocationName("C:\\Users\\alice\\.agents\\skills", "brainstorming")).toBe("brainstorming")
    expect(buildSkillInvocationName("C:\\Users\\alice\\.agents\\skills\\superpowers", "brainstorming")).toBe("superpowers/brainstorming")
  })
})
