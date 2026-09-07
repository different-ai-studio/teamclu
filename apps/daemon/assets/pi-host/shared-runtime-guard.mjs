/**
 * Isolate per-session ExtensionRunner invalidation from the process-wide
 * ExtensionRuntime that TeamClu's multi-session pi host shares.
 *
 * Pi 0.84+ `AgentSession.dispose()` calls `extensionRunner.invalidate()`, which
 * marks that runner stale *and* the ExtensionRuntime it was constructed with.
 * The host reuses one ResourceLoader (hence one runtime) for every session in
 * the process, so disposing session A would make `pi.registerTool` / `pi.on`
 * throw "extension ctx is stale" on sessions B…N that are still live.
 */

export const STALE_EXTENSION_CTX_SNIPPET =
  "extension ctx is stale after session replacement or reload";

const STALE_EXTENSION_CTX_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

export function isStaleExtensionCtxError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(STALE_EXTENSION_CTX_SNIPPET);
}

/**
 * Wrap `runner.invalidate` so a session that still has live siblings only
 * marks *that* runner stale and leaves the shared runtime alone.
 *
 * `liveSessionCount` is read at invalidate-time. The host deletes the closing
 * session from its map *before* calling `dispose()`, so the count is the
 * number of remaining sessions (0 = this was the last one).
 */
export function shieldSharedRuntimeFromSessionDispose(runner, liveSessionCount) {
  if (!runner || typeof runner.invalidate !== "function") return;
  const orig = runner.invalidate.bind(runner);
  runner.invalidate = (message) => {
    const others = typeof liveSessionCount === "function" ? liveSessionCount() : liveSessionCount;
    if (Number(others) > 0) {
      if (!runner.staleMessage) {
        runner.staleMessage = message ?? STALE_EXTENSION_CTX_MESSAGE;
      }
      return;
    }
    orig(message);
  };
}
