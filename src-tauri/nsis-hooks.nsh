; Rebrand Justice Client -> Verdict Client (0.9.6).
; The installer folder, shortcuts and the "Apps" entry are named after productName, so an update from
; "Justice Client" would leave the old install next to the new one. Remove the old one after installing.
; Game data (D:\JusticeClient, %APPDATA%\JusticeClient) is not touched.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Justice Client" "InstallLocation"
  ${If} $R0 != ""
    ; the value is stored with quotes: "C:\...\Justice Client"
    StrCpy $R1 $R0 1
    ${If} $R1 == '"'
      StrCpy $R0 $R0 "" 1
      StrCpy $R0 $R0 -1
    ${EndIf}
    ; only ever delete a folder that really is the old "...\Justice Client" install, never the new one
    StrCpy $R1 $R0 "" -15
    ${If} $R1 == "\Justice Client"
    ${AndIf} $R0 != $INSTDIR
      ; the old launcher may still be closing after starting this update
      Sleep 1500
      RMDir /r "$R0"
    ${EndIf}
  ${EndIf}
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Justice Client"
  DeleteRegKey HKCU "Software\justice\Justice Client"
  Delete "$SMPROGRAMS\Justice Client.lnk"
  Delete "$DESKTOP\Justice Client.lnk"
!macroend
