export function registerTeamVoice(router) {
  // Mints a short-lived Alibaba NLS credential so amuxd can talk to speech
  // recognition / synthesis directly. FC holds the AccessKey; what leaves here
  // expires on its own. See lib/aliyun-nls.ts for why the audio itself does not
  // pass through this service.
  //
  // POST rather than GET: it is a mint, not a read — each call consumes an
  // upstream request and returns a different credential, so it must not be
  // cached or retried by anything that assumes GET is safe.
  router.post("/v1/teams/:teamId/voice/credentials", async (ctx) => {
    const result = await ctx.repository.mintVoiceCredentials(ctx.params.teamId);
    return { body: result };
  });
}
