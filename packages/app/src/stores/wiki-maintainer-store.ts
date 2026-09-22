import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface State {
  sourceDirectoriesByTeamId: Record<string, string[]>
  compilerModelByTeamId: Record<string, string>
  setSourceDirectories: (teamId: string, paths: string[]) => void
  setCompilerModel: (teamId: string, modelId: string) => void
  sourceDirectories: (teamId: string | null | undefined) => string[]
}

export const useWikiMaintainerStore = create<State>()(
  persist(
    (set, get) => ({
      sourceDirectoriesByTeamId: {},
      compilerModelByTeamId: {},
      setSourceDirectories: (teamId, paths) =>
        set((state) => ({
          sourceDirectoriesByTeamId: {
            ...state.sourceDirectoriesByTeamId,
            [teamId]: [...new Set(paths)].sort(),
          },
        })),
      setCompilerModel: (teamId, modelId) =>
        set((state) => ({
          compilerModelByTeamId: {
            ...state.compilerModelByTeamId,
            [teamId]: modelId,
          },
        })),
      sourceDirectories: (teamId) =>
        teamId ? (get().sourceDirectoriesByTeamId[teamId] ?? []) : [],
    }),
    { name: 'teamclu-wiki-maintainer' },
  ),
)
