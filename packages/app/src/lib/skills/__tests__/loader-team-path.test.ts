import { describe, it, expect, vi, beforeEach } from "vitest"
import { TEAM_REPO_DIR } from "@/lib/build-config"
import {
  buildSkillInvocationName,
  loadAllSkills,
  getSourceDirHint,
  readConfigSkillPaths,
} from "../loader"
import { collectTeamSkillPaths, TEAM_SHARE_LINK_DIR } from "@/lib/team-skill-paths"

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

const opencodeJson = (paths: string[]) => JSON.stringify({ skills: { paths } })

describe("skill-loader dynamic team paths (from opencode.json)", () => {
  const workspacePath = "/tmp/ws"

  beforeEach(() => {
    vi.clearAllMocks()
    mockExists.mockReturnValue(false)
    mockReadDir.mockResolvedValue([])
    mockReadTextFile.mockResolvedValue("# Test Skill\n")
    mockHomeDir.mockResolvedValue("/home/user")
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join("/")))
  })

  it("loads team skills from paths listed in opencode.json", async () => {
    const teamDir = `${workspacePath}/${TEAM_REPO_DIR}/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      if (path === teamDir) return Promise.resolve(true)
      if (path.includes("my-team-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(opencodeJson([`${TEAM_REPO_DIR}/skills`]))
      if (path.includes("my-team-skill"))
        return Promise.resolve("# my-team-skill\n")
      return Promise.resolve("")
    })
    mockReadDir.mockImplementation((path: string) => {
      if (path === teamDir)
        return Promise.resolve([{ name: "my-team-skill", isDirectory: true }])
      return Promise.resolve([])
    })

    const { skills } = await loadAllSkills(workspacePath)
    const teamSkills = skills.filter((s) => s.source === "team")

    expect(teamSkills.length).toBeGreaterThanOrEqual(1)
    expect(teamSkills.some((s) => s.filename === "my-team-skill")).toBe(true)
  })

  it("resolves ~ paths using homeDir()", async () => {
    const expandedDir = "/home/user/shared-skills"

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      if (path === expandedDir) return Promise.resolve(true)
      if (path.includes("home-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(opencodeJson(["~/shared-skills"]))
      if (path.includes("home-skill"))
        return Promise.resolve("# home-skill\n")
      return Promise.resolve("")
    })
    mockReadDir.mockImplementation((path: string) => {
      if (path === expandedDir)
        return Promise.resolve([{ name: "home-skill", isDirectory: true }])
      return Promise.resolve([])
    })

    const { skills } = await loadAllSkills(workspacePath)
    const teamSkills = skills.filter((s) => s.source === "team")

    expect(teamSkills.some((s) => s.filename === "home-skill")).toBe(true)
  })

  it("resolves Windows absolute skill paths without prefixing the workspace", async () => {
    const workspacePath = "C:\\Users\\alice\\project"
    const absoluteDir = "D:\\shared\\skills"

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) {
        return Promise.resolve(opencodeJson([absoluteDir]))
      }
      return Promise.resolve("")
    })

    await expect(readConfigSkillPaths(workspacePath)).resolves.toEqual([absoluteDir])
  })

  it("resolves Windows home-relative skill paths", async () => {
    const workspacePath = "C:\\Users\\alice\\project"
    mockHomeDir.mockResolvedValue("C:\\Users\\alice")

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) {
        return Promise.resolve(opencodeJson(["~\\shared-skills"]))
      }
      return Promise.resolve("")
    })

    await expect(readConfigSkillPaths(workspacePath)).resolves.toEqual([
      "C:\\Users\\alice\\shared-skills",
    ])
  })

  it("contributes zero team skills when no team share dir and no skills.paths", async () => {
    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      if (path === `${workspacePath}/${TEAM_SHARE_LINK_DIR}/skills`) return Promise.resolve(false)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(JSON.stringify({}))
      return Promise.resolve("")
    })

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.filter((s) => s.source === "team")).toHaveLength(0)
  })

  it("falls back to global team dir when workspace teamclu-team link is broken", async () => {
    const brokenLinkSkills = `${workspacePath}/${TEAM_SHARE_LINK_DIR}/skills`
    const globalTeamDir = `/home/user/.amuxd/teams/team-abc/shared/${TEAM_SHARE_LINK_DIR}`
    const globalSkills = `${globalTeamDir}/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      if (path === brokenLinkSkills) return Promise.resolve(false)
      if (path === `${workspacePath}/${TEAM_SHARE_LINK_DIR}`) return Promise.resolve(false)
      if (path === `/home/user/.amuxd/daemon.toml`) return Promise.resolve(true)
      if (path === globalSkills) return Promise.resolve(true)
      if (path === globalTeamDir) return Promise.resolve(true)
      if (path.includes("shared-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(JSON.stringify({ skills: { paths: ["teamclu-team/skills"] } }))
      if (path === `/home/user/.amuxd/daemon.toml`)
        return Promise.resolve('active_team = "team-abc"\n')
      if (path.includes("shared-skill")) return Promise.resolve("# shared-skill\n")
      return Promise.resolve("")
    })
    mockReadDir.mockImplementation((path: string) => {
      if (path === globalSkills)
        return Promise.resolve([{ name: "shared-skill", isDirectory: true }])
      return Promise.resolve([])
    })

    const paths = await collectTeamSkillPaths(workspacePath)
    expect(paths).toContain(globalSkills)

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.some((s) => s.source === "team" && s.filename === "shared-skill")).toBe(true)
  })

  it("does not auto-load the global team skills dir without a skills.paths entry", async () => {
    // The team drive's own `skills/` used to be added on sight. It has had no
    // writer since the registry took over (OSS sync RETIRED_PREFIXES), so what
    // is left on disk is whatever the last sync before that migration wrote —
    // exactly the stale copies the registry exists to retire.
    const globalTeamDir = `/home/user/.amuxd/teams/team-abc/shared/${TEAM_SHARE_LINK_DIR}`
    const globalSkills = `${globalTeamDir}/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === `/home/user/.amuxd/daemon.toml`) return Promise.resolve(true)
      if (path === globalTeamDir) return Promise.resolve(true)
      if (path === globalSkills) return Promise.resolve(true)
      if (path.includes("shared-skill") && path.endsWith("SKILL.md")) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadDir.mockImplementation((path: string) => {
      if (path === globalSkills)
        return Promise.resolve([{ name: "shared-skill", isDirectory: true }])
      return Promise.resolve([])
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `/home/user/.amuxd/daemon.toml`)
        return Promise.resolve('active_team = "team-abc"\n')
      if (path.includes("shared-skill")) return Promise.resolve("# shared-skill\n")
      return Promise.resolve("")
    })

    expect(await collectTeamSkillPaths(workspacePath)).toEqual([])

    const { skills } = await loadAllSkills(workspacePath)
    expect(skills.some((s) => s.filename === "shared-skill")).toBe(false)
  })

  it("still reads a daemon.toml that names the team with the legacy team_id key", async () => {
    // The daemon writes `active_team` but keeps a serde alias for `team_id`
    // (DaemonConfig::team_id), so an older daemon under a newer app must not
    // read as un-onboarded — the remap of a `teamclu-team/...` entry in
    // `opencode.json` depends on resolving the team.
    const globalTeamDir = `/home/user/.amuxd/teams/team-abc/shared/${TEAM_SHARE_LINK_DIR}`
    const globalSkills = `${globalTeamDir}/skills`

    mockExists.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`) return Promise.resolve(true)
      if (path === `/home/user/.amuxd/daemon.toml`) return Promise.resolve(true)
      if (path === globalTeamDir) return Promise.resolve(true)
      if (path === globalSkills) return Promise.resolve(true)
      return Promise.resolve(false)
    })
    mockReadTextFile.mockImplementation((path: string) => {
      if (path === `${workspacePath}/opencode.json`)
        return Promise.resolve(opencodeJson([`${TEAM_SHARE_LINK_DIR}/skills`]))
      if (path === `/home/user/.amuxd/daemon.toml`)
        return Promise.resolve('team_id = "team-abc"\n')
      return Promise.resolve("")
    })

    expect(await collectTeamSkillPaths(workspacePath)).toContain(globalSkills)
  })

  it("treats an unclaimed daemon as having no team dir", async () => {
    mockExists.mockImplementation((path: string) =>
      Promise.resolve(path === `/home/user/.amuxd/daemon.toml`),
    )
    mockReadTextFile.mockImplementation((path: string) =>
      Promise.resolve(path === `/home/user/.amuxd/daemon.toml` ? 'active_team = "_unclaimed"\n' : ""),
    )

    expect(await collectTeamSkillPaths(workspacePath)).toEqual([])
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

  it("getSourceDirHint(team) points at the one config that declares team paths", () => {
    expect(getSourceDirHint("team")).toBe("opencode.json → skills.paths")
  })
})
