; Lumen's native desktop app, Windows installer. Per user and assisted (the
; folder can be changed), like electron-builder's NSIS target for the
; Electron app (oneClick: false, perMachine: false, allowElevation: false).
; Built by package.sh:
;
;   makensis -DVERSION=0.1.4 -DVERSION4=0.1.4.0 -DAPP_DIR=<folder with Lumen.exe>
;            -DOUTFILE=<setup.exe> -DICON=<icon.ico> installer.nsi
;
; Until it replaces the Electron app it installs beside it, as "Lumen Native",
; with its own folder, shortcuts and uninstall entry. Both use the same
; settings (%APPDATA%\Lumen), which uninstalling leaves alone.
;
; The in-app updater runs it with `--updated` (no pages, only progress, and it
; closes itself) and `--force-run` (start Lumen afterwards); on quit it runs
; it with `/S --updated`. It waits for a running Lumen to quit before
; replacing it.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!define PRODUCT "Lumen"
!define SHORTCUT "Lumen Native"
!define EXE "Lumen.exe"
!define UNINSTALLER "Uninstall Lumen.exe"
!define REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumenNative"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${SHORTCUT}"
InstallDirRegKey HKCU "${REG_KEY}" "InstallLocation"
BrandingText "${PRODUCT} ${VERSION}"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING

VIProductVersion "${VERSION4}"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "esson"
VIAddVersionKey "LegalCopyright" ""

Var Updated
Var ForceRun

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Run ${PRODUCT}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $Updated "1"
    SetAutoClose true
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    StrCpy $ForceRun "1"
  ${EndIf}
FunctionEnd

Function SkipWhenUpdating
  ${If} $Updated == "1"
    Abort
  ${EndIf}
FunctionEnd

; A running Lumen keeps its executable locked: wait for it to quit (the
; updater quits it right after starting this), then ask.
Function WaitForLumen
  StrCpy $R2 0
  retry:
    IfFileExists "$INSTDIR\${EXE}" 0 done
    ClearErrors
    Delete "$INSTDIR\${EXE}"
    IfErrors 0 done
    IntOp $R2 $R2 + 1
    IntCmp $R2 80 0 wait 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT} is still running. Close it, then choose Retry." /SD IDCANCEL IDRETRY again
    Abort "${PRODUCT} is still running."
  again:
    StrCpy $R2 0
    Goto retry
  wait:
    Sleep 250
    Goto retry
  done:
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  Call WaitForLumen
  File /r "${APP_DIR}\*.*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  CreateShortCut "$SMPROGRAMS\${SHORTCUT}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  ${If} $Updated != "1"
    CreateShortCut "$DESKTOP\${SHORTCUT}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  ${EndIf}

  WriteRegStr HKCU "${REG_KEY}" "DisplayName" "${PRODUCT} (native)"
  WriteRegStr HKCU "${REG_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REG_KEY}" "Publisher" "esson"
  WriteRegStr HKCU "${REG_KEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REG_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${REG_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REG_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${REG_KEY}" "EstimatedSize" "$0"

  ${If} $ForceRun == "1"
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  ; Only what the installer put there: the folder may hold other files.
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${SHORTCUT}.lnk"
  Delete "$DESKTOP\${SHORTCUT}.lnk"
  DeleteRegKey HKCU "${REG_KEY}"
SectionEnd
