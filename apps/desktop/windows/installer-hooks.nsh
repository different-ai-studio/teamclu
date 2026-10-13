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

; Resolved when this file is included, so `File` looks next to the hooks file
; and not next to Tauri's generated installer.nsi. The exe is copied here by the
; Windows release job and is gitignored.
!define TEAMCLU_SUPPORT_HELPER "${__FILEDIR__}\teamclu-support.exe"

; $$ is an NSIS escape, so PowerShell still sees `$env:...`. Detail is passed
; through the environment because $INSTDIR contains backslashes.
!macro TEAMCLU_APPEND_JOURNAL STEP OK DETAIL
  System::Call 'Kernel32::SetEnvironmentVariable(t "TEAMCLU_J_STEP", t "${STEP}")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "TEAMCLU_J_OK", t "${OK}")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "TEAMCLU_J_DETAIL", t "${DETAIL}")'
  nsExec::ExecToLog "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $\"$$d=Join-Path $$env:USERPROFILE '.teamclu\support'; New-Item -ItemType Directory -Force -Path $$d | Out-Null; $$ok=($$env:TEAMCLU_J_OK -eq 'true'); $$o=[ordered]@{ts=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); step=$$env:TEAMCLU_J_STEP; ok=$$ok; detail=$$env:TEAMCLU_J_DETAIL}; $$line=($$o | ConvertTo-Json -Compress)+[char]10; [IO.File]::AppendAllText((Join-Path $$d 'journal.jsonl'), $$line, (New-Object System.Text.UTF8Encoding $$false))$\""
  Pop $R9
!macroend

!macro TEAMCLU_STOP_SIDECARS
  ; /T kills the process tree (opencode serve children, etc.). Image names match
  ; both the packaged plain names and any leftover target-triple copies.
  nsExec::ExecToLog 'taskkill /F /T /IM amuxd.exe'
  Pop $R0
  nsExec::ExecToLog 'taskkill /F /T /IM amuxd-x86_64-pc-windows-msvc.exe'
  Pop $R1
  nsExec::ExecToLog 'taskkill /F /T /IM teamclu-introspect.exe'
  Pop $R2
  nsExec::ExecToLog 'taskkill /F /T /IM teamclu-introspect-x86_64-pc-windows-msvc.exe'
  Pop $R3

  ; Give the kernel a beat to release the PE image mappings before Delete/File.
  Sleep 800

  ; Legacy: amuxd install-service registered an ONLOGON task. Desktop-managed
  ; mode no longer creates it, but old installs still have it.
  nsExec::ExecToLog 'schtasks /Delete /F /TN amuxd'
  Pop $R4
  ; Exit 128 (process not found) is normal. The step is still ok; the codes
  ; are the evidence.
  !insertmacro TEAMCLU_APPEND_JOURNAL "stop_sidecars" "true" "amuxd=$R0 amuxd_triple=$R1 introspect=$R2 introspect_triple=$R3 schtasks=$R4"
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
        !insertmacro TEAMCLU_APPEND_JOURNAL "wait_writable" "true" "ticks=$R7"
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
        !insertmacro TEAMCLU_APPEND_JOURNAL "wait_writable" "false" "ticks=$R7"
        Goto teamclu_wait_done
      ${EndIf}

      Sleep 200
      Goto teamclu_wait_writable
    teamclu_wait_done:
  ${Else}
    !insertmacro TEAMCLU_APPEND_JOURNAL "wait_writable" "true" "skipped"
  ${EndIf}
!macroend

; Inserted exactly once — the labels above are plain, not ${UniqueID}-suffixed,
; so a second insertion would fail to compile with a duplicate label.
; Extract the helper before any of the steps that can fail, then restore
; $INSTDIR because the template set it and the main File copy follows this hook.
!macro NSIS_HOOK_PREINSTALL
  SetOutPath $PLUGINSDIR
  File "${TEAMCLU_SUPPORT_HELPER}"
  SetOutPath $INSTDIR
  !insertmacro TEAMCLU_APPEND_JOURNAL "installer_image" "true" "$EXEFILE"
  !insertmacro TEAMCLU_APPEND_JOURNAL "install_dir" "true" "$INSTDIR"
  !insertmacro TEAMCLU_STOP_SIDECARS
  !insertmacro TEAMCLU_WAIT_FOR_WRITABLE_MAIN_BINARY
  !insertmacro TEAMCLU_APPEND_JOURNAL "helper_extracted" "true" "$PLUGINSDIR\teamclu-support.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CopyFiles /SILENT "$PLUGINSDIR\teamclu-support.exe" "$INSTDIR\teamclu-support.exe"
  ${If} $AppStartMenuFolder != ""
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\TeamClu 支持助手.lnk" "$INSTDIR\teamclu-support.exe" "--phase manual"
  ${Else}
    CreateShortcut "$SMPROGRAMS\TeamClu 支持助手.lnk" "$INSTDIR\teamclu-support.exe" "--phase manual"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TEAMCLU_STOP_SIDECARS
  !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
  ${If} $AppStartMenuFolder != ""
    Delete "$SMPROGRAMS\$AppStartMenuFolder\TeamClu 支持助手.lnk"
  ${EndIf}
  Delete "$SMPROGRAMS\TeamClu 支持助手.lnk"
  Delete "$INSTDIR\teamclu-support.exe"
!macroend

; The Tauri 2.11 template does not define this callback. It runs while
; $PLUGINSDIR still exists, before the installer deletes it on the way out.
Function .onInstFailed
  !insertmacro TEAMCLU_APPEND_JOURNAL "install_failed" "false" "$EXEFILE"
  Exec '"$PLUGINSDIR\teamclu-support.exe" --phase install'
FunctionEnd
