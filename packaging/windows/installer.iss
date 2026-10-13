; Inno Setup script for the Windows installer. Not run by hand: scripts/build_installer.ts stages
; the files in vendor\.build\installer\stage and passes Stage, Version and OutDir.
; Per-user install (no administrator rights), so models\ and voices\ beside the program stay
; writable. The models and the voices are not packed: the launcher's "Download models" fetches them.
; Uninstalling removes only what was installed here, so downloaded models and voices stay.

; The Visual C++ runtime is not packed: CodeDependencies.iss (DomGries/InnoDependencyInstaller,
; copied unchanged) downloads and runs Microsoft's redistributable when the machine lacks it.
#include "CodeDependencies.iss"

#ifndef Stage
  #error Stage is not defined; run: bun scripts/build_installer.ts
#endif

[Setup]
AppId={{6B0E5C47-3D5A-4B1E-9C57-5F3D2E0A7C11}
AppName=Index Translator
AppVersion={#Version}
AppPublisher=Index Translator
DefaultDirName={autopf}\Index Translator
DefaultGroupName=Index Translator
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=Index_Translator-Setup-x86_64
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
SetupIconFile=launcher.ico
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\launcher.exe

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Index Translator"; Filename: "{app}\launcher.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Index Translator"; Filename: "{app}\launcher.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\launcher.exe"; Description: "Start Index Translator"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
function InitializeSetup: Boolean;
begin
  Dependency_AddVC14;
  Result := True;
end;
