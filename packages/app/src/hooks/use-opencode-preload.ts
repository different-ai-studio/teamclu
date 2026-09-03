/** A no-op that App still calls.
 *
 * The opencode sidecar preload it used to do is gone — the daemon's local HTTP
 * is probed in `useWorkspaceInit` instead. Kept as an empty hook so the call
 * site does not have to be edited in the same change that removed the work;
 * delete both together.
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
export function useOpenCodePreload() {}
