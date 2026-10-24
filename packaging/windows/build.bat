@echo off
rem Builds launcher.exe with MSVC (Visual Studio 2022 or later, or Build Tools, "Desktop development with C++").
rem launcher.rc embeds launcher.ico (made from public\icons\icon.svg).
rem launcher.manifest (Common Controls 6, Per-Monitor DPI Awareness V2) is embedded in the exe.
setlocal
set "VS="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (echo vswhere not found & exit /b 1)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -property installationPath`) do set "VS=%%i"
if not defined VS (echo Visual Studio not found & exit /b 1)
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
rc /nologo /utf-8 launcher.rc || exit /b 1
cl /nologo /O2 /W3 /utf-8 /D_CRT_SECURE_NO_WARNINGS launcher.c launcher.res /link /SUBSYSTEM:WINDOWS /MANIFEST:EMBED /MANIFESTINPUT:launcher.manifest /OUT:launcher.exe || exit /b 1
del launcher.obj launcher.res 2>nul
