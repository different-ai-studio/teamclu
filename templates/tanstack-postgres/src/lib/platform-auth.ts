/**
 * Reading the signed-in visitor, when this app has a login wall.
 *
 * THE APP DOES NOT IMPLEMENT THE LOGIN. It has no login page, no callback
 * route, no session cookie of its own, and nothing to get wrong. The platform's
 * proxy sits in front of every request: it runs the whole email round trip on
 * its own hostname, decides who may enter, and only then forwards the request
 * here with the visitor's identity attached as headers.
 *
 * That placement is deliberate. This file is rewritten by an agent whenever the
 * app changes, and a login wall living in code like that survives exactly until
 * the next rewrite — while the control panel goes on saying the app requires a
 * sign-in. In the proxy it cannot be edited away.
 *
 * WHAT YOU GET
 *
 *   X-Teamclu-User-Id     the visitor's id in the platform's Supabase
 *   X-Teamclu-User-Email  their address
 *   X-Teamclu-Org-Id      their organisation, when there is one
 *
 * These appear only when the visitor satisfies EVERY condition for entering
 * this app. They carry exactly one meaning wherever they appear — "this person
 * is allowed in" — so an app never has to re-check an audience. On a public
 * path of an app whose wall is set to staff-only, an outsider arrives with no
 * headers at all rather than with headers you would have to second-guess.
 *
 * The proxy strips any client-supplied copy of these before writing its own, so
 * a caller cannot forge one. They are trustworthy exactly because they came
 * through that hop — never read them from a request that did not.
 *
 * WHAT THIS DOES NOT DO
 *
 * Path rules gate who can FETCH a URL, not who can see a screen. This app's
 * first paint is server-rendered and is gated, but an in-app navigation is
 * client-side routing the proxy never observes. Protect the DATA — the server
 * functions this app calls — and the interface follows. The proxy is the outer
 * layer; your own queries are still the real boundary.
 *
 * ENV, when the app's login is on:
 *   APP_PUBLIC_URL     this app's own address
 *   API_BASE           the platform's control-plane origin
 *   SUPABASE_URL       browser-reachable Supabase, if you want supabase-js
 *   SUPABASE_ANON_KEY  its anon key — public by design, never a service role
 */

/** Seeded from template placeholder {{APP_ID}} — this app's Cloud API id. */
export const APP_ID = '{{APP_ID}}'

export type Visitor = {
  id: string
  email: string
  /** Null when the app admits anyone, or when the visitor has no org. */
  orgId: string | null
}

/**
 * The visitor behind a request, or null when there is none.
 *
 * Null means one of three things, and the app should treat them the same: the
 * app has no login wall, the path is public and nobody is signed in, or the
 * visitor was not admitted. In every case there is nobody to name.
 *
 * Takes a `Headers` rather than a whole request so it works with anything —
 * a server function's request, a middleware, a test.
 */
export function visitorFrom(headers: Headers): Visitor | null {
  const id = headers.get('x-teamclu-user-id')?.trim()
  const email = headers.get('x-teamclu-user-email')?.trim()
  if (!id || !email) return null
  return { id, email, orgId: headers.get('x-teamclu-org-id')?.trim() || null }
}

/** True when this deployment injected the Supabase details an app may use itself. */
export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
}
