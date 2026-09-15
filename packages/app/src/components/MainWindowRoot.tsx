import App from '@/App'
import { AuthGate } from '@/components/auth/AuthGate'
import { CloseToTrayHost } from '@/components/CloseToTrayDialog'
import { SidePanelHostGateOverlay } from '@/components/extension/SidePanelHostGateOverlay'
import { InviteLinkConfirmDialog } from '@/components/invite/InviteLinkConfirmDialog'
import { UpdateDialogContainer } from '@/components/updater/UpdateDialog'
import { E2E_BUILD } from '@/lib/e2e/v2-control-active'

/** Everything the main window mounts; `main.tsx` renders it outside panel mode. */
export function MainWindowRoot() {
  return (
    <>
      <SidePanelHostGateOverlay />
      {/*
        SEC-3: the invite-link confirmation lives outside AuthGate so a link
        arriving on the login screen is asked about just like one arriving
        inside the shell. Only a token accepted here is ever claimed.
      */}
      <InviteLinkConfirmDialog />
      {/*
        Outside AuthGate for the same reason: updating needs nothing from
        the backend — `check_update` is a plain fetch of the release
        manifest — but mounted inside App it only ever ran for a user who
        had already signed in AND passed team bootstrap. A build that cannot
        get anyone past the login screen was therefore also a build nobody
        could update out of.
      */}
      <UpdateDialogContainer />
      {/*
        Outside AuthGate too (#1403). The window close button is intercepted
        in Rust, which asks the frontend unless a choice was remembered; with
        this inside App nobody answered during first-run setup, so a fresh
        install could not be closed from its own title bar.
      */}
      <CloseToTrayHost />
      {/*
        An E2E build mounts App without AuthGate. The harness never signs
        in — it drives the app over the MCP socket and seeds sessions,
        actors and messages straight into the stores — so there is no
        session for the gate to pass. Inside AuthGate, App simply never
        mounts at the login screen, and it takes the tauri-plugin-mcp
        listeners and the `window.__TEAMCLU_V2_E2E__` control surface down
        with it, leaving the harness with nothing to talk to.

        `E2E_BUILD` is a build-time constant: a normal build folds this to
        the AuthGate branch and the bundler drops the other one.
      */}
      {E2E_BUILD ? (
        <App />
      ) : (
        <AuthGate>
          <App />
        </AuthGate>
      )}
    </>
  )
}
