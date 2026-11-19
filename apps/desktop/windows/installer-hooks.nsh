; Refuse to install on Windows we cannot run on: anything older than Windows 10,
; or a 32-bit OS (we only ship x64 / arm64 builds). WebView2 dropped Windows 7 /
; 8.1, and the template's WebView2 section runs before NSIS_HOOK_PREINSTALL — on
; Windows 7 its bootstrapper dies with "无法定位程序输入点 PackageIdFromFullName
; 于 KERNEL32.dll", which tells the user nothing. The template has no 32-bit
; guard either.
;
; The template offers no .onInit hook, but this file is included before any MUI
; page is declared, so MUI2's .onGUIInit picks up MUI_CUSTOMFUNCTION_GUIINIT and
; we run before the welcome page. Silent installs (/S, the updater) never reach
; .onGUIInit; they only come from an app that is already running, so the OS is
; already known to be fine.
!include WinVer.nsh
!include x64.nsh

!define MUI_CUSTOMFUNCTION_GUIINIT TeamCluCheckWindowsVersion

Function TeamCluCheckWindowsVersion
  ${IfNot} ${AtLeastWin10}
  ${OrIfNot} ${RunningX64}
    MessageBox MB_ICONSTOP|MB_OK "$(^Name) 需要 64 位 Windows 10 或 Windows 11，当前系统无法安装。$\r$\n$\r$\n$(^Name) requires 64-bit Windows 10 or Windows 11 and cannot be installed on this system."
    Quit
  ${EndIf}
FunctionEnd

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

; Wait until the main binary can actually be opened for writing.
;
; On an update the desktop app launches this installer and only then exits, so
; we arrive here while it is still tearing down — and Windows refuses to
; overwrite a .exe whose image is still mapped. The template's own protection
; (CheckIfAppIsRunning, inserted right after this hook) is thin on purpose: it
; sleeps 500 ms after terminating the process it finds, and when the process is
; *already gone* it skips that sleep entirely. A process that is gone from the
; process list but not yet finished rundown therefore lands straight on
; `File`, which fails with "Error opening file for writing" — the error Retry
; always clears, because a human click takes longer than the rundown does.
;
; Only in update mode. A manual install over a running app should still get the
; template's "close the app?" handling rather than a silent kill.
!macro TEAMCLU_WAIT_FOR_WRITABLE_MAIN_BINARY
  ${If} $UpdateMode = 1
  ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R7 0
    teamclu_wait_writable:
      ; Append mode, never "w": "w" truncates, and this file is the thing we are
      ; here to protect. Opening it is only a probe for the sharing violation.
      ClearErrors
      FileOpen $R8 "$INSTDIR\${MAINBINARYNAME}.exe" a
      ${IfNot} ${Errors}
        FileClose $R8
        Goto teamclu_wait_done
      ${EndIf}

      IntOp $R7 $R7 + 1
      ; 50 ticks = 10s of waiting politely for an exit that should take under a
      ; second. Past that something is wrong (a hung window, a modal dialog);
      ; kill it, which is what CheckIfAppIsRunning would do moments later anyway.
      ${If} $R7 = 50
        nsExec::ExecToLog 'taskkill /F /T /IM ${MAINBINARYNAME}.exe'
        Pop $R9
      ${EndIf}
      ; 75 ticks = 15s total. Stop waiting and let CheckIfAppIsRunning have its
      ; turn — better its error message than an installer that hangs here.
      ${If} $R7 >= 75
        Goto teamclu_wait_done
      ${EndIf}

      Sleep 200
      Goto teamclu_wait_writable
    teamclu_wait_done:
  ${EndIf}
!macroend

; Wait until the sidecar binaries can be opened for writing, killing them again
; for as long as they cannot.
;
; TEAMCLU_STOP_SIDECARS runs once, at the very top of this hook, while the
; desktop app is still alive — on an update it is only just exiting, and on a
; manual install it is still running until the template's CheckIfAppIsRunning
; closes it. An amuxd that comes up after that single taskkill (the app's
; supervisor healing a daemon it just saw die, or a `git` credential helper
; that runs `<install dir>\amuxd.exe`) outlives the app, because Windows does
; not take children down with their parent, and the copy then fails with
; "Error opening file for writing: ...\amuxd.exe".
;
; So probe again after the main binary is free — on an update the app is gone
; by then and nothing is left to respawn the daemon — and re-kill until the
; files open. Builds that tie amuxd to a kill-on-close job object (see
; amuxd_supervisor.rs) should never need more than the first probe; this is
; also what saves an update *from* a build that does not.
;
; Update mode only, like the main-binary wait. On a manual install the app is
; still running at this point and would just respawn what we kill; there the
; job object takes amuxd down when CheckIfAppIsRunning closes the app.
;
; Same append-mode probe as the main-binary wait, and the same registers
; ($R7-$R9, nothing the template is known to hold here): re-kill and re-probe
; every ~500 ms, give up after 25 rounds and let `File` raise its own Retry
; dialog rather than hang the installer.
!macro TEAMCLU_WAIT_FOR_WRITABLE_SIDECARS
  ${If} $UpdateMode = 1
  StrCpy $R7 0
  teamclu_sidecars_probe:
    StrCpy $R9 0
    ${If} ${FileExists} "$INSTDIR\amuxd.exe"
      ClearErrors
      FileOpen $R8 "$INSTDIR\amuxd.exe" a
      ${If} ${Errors}
        StrCpy $R9 1
      ${Else}
        FileClose $R8
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\teamclu-introspect.exe"
      ClearErrors
      FileOpen $R8 "$INSTDIR\teamclu-introspect.exe" a
      ${If} ${Errors}
        StrCpy $R9 1
      ${Else}
        FileClose $R8
      ${EndIf}
    ${EndIf}
    ${If} $R9 = 0
      Goto teamclu_sidecars_done
    ${EndIf}

    IntOp $R7 $R7 + 1
    ${If} $R7 > 25
      Goto teamclu_sidecars_done
    ${EndIf}
    nsExec::ExecToLog 'taskkill /F /T /IM amuxd.exe'
    Pop $R9
    nsExec::ExecToLog 'taskkill /F /T /IM teamclu-introspect.exe'
    Pop $R9
    ; The kernel releases the image mapping a beat after the process is gone.
    Sleep 400
    Goto teamclu_sidecars_probe
  teamclu_sidecars_done:
  ${EndIf}
!macroend

; Inserted exactly once — the labels above are plain, not ${UniqueID}-suffixed,
; so a second insertion would fail to compile with a duplicate label.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro TEAMCLU_STOP_SIDECARS
  !insertmacro TEAMCLU_WAIT_FOR_WRITABLE_MAIN_BINARY
  !insertmacro TEAMCLU_WAIT_FOR_WRITABLE_SIDECARS
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TEAMCLU_STOP_SIDECARS
!macroend
