; Kill sidecars that NSIS does not know about before it copies or deletes
; install-dir files. Tauri's CheckIfAppIsRunning only closes ${MAINBINARYNAME}.exe;
; amuxd / teamclu-introspect are externalBin children with kill_on_drop(false), so
; a force-closed (or crashed) desktop leaves them holding amuxd.exe /
; teamclu-introspect.exe open — Windows then refuses Delete / File overwrite and
; uninstall leaves the binaries behind (or the upgrade keeps a stale sidecar).
;
; Also drop the legacy ONLOGON scheduled task named "amuxd" (pre desktop-managed
; era). Best-effort: errors are ignored so a clean machine is not blocked.
;
; Deliberately no `"$INSTDIR\amuxd.exe" stop` here: a hung daemon would stall the
; installer; taskkill /T is enough to release the PE image lock.

!macro TEAMCLU_STOP_SIDECARS
  ; /T kills the process tree (opencode serve children, etc.). Image names match
  ; both the packaged plain names and any leftover target-triple copies.
  nsExec::ExecToLog 'taskkill /F /T /IM amuxd.exe'
  Pop $R9
  nsExec::ExecToLog 'taskkill /F /T /IM amuxd-x86_64-pc-windows-msvc.exe'
  Pop $R9
  nsExec::ExecToLog 'taskkill /F /T /IM teamclu-introspect.exe'
  Pop $R9
  nsExec::ExecToLog 'taskkill /F /T /IM teamclu-introspect-x86_64-pc-windows-msvc.exe'
  Pop $R9

  ; Give the kernel a beat to release the PE image mappings before Delete/File.
  Sleep 800

  ; Legacy: amuxd install-service registered an ONLOGON task. Desktop-managed
  ; mode no longer creates it, but old installs still have it.
  nsExec::ExecToLog 'schtasks /Delete /F /TN amuxd'
  Pop $R9
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro TEAMCLU_STOP_SIDECARS
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TEAMCLU_STOP_SIDECARS
!macroend
