@echo off
REM Builds SwiffCP.dll (x64). Needs VS Build Tools with the C++ workload and a Windows SDK.
setlocal

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo ERROR: vswhere not found - Visual Studio Build Tools are not installed.
  exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * ^
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 ^
    -property installationPath`) do set "VSPATH=%%i"

if not defined VSPATH (
  echo ERROR: no installation with the C++ toolset found.
  exit /b 1
)

call "%VSPATH%\VC\Auxiliary\Build\vcvarsall.bat" x64 >nul
if errorlevel 1 (
  echo ERROR: vcvarsall failed.
  exit /b 1
)

if not exist "%~dp0build" mkdir "%~dp0build"
pushd "%~dp0build"

cl /nologo /LD /W4 /WX /EHsc /O2 /DUNICODE /D_UNICODE /std:c++17 ^
   /Fe:SwiffCP.dll ^
   "%~dp0Provider.cpp" "%~dp0Credential.cpp" "%~dp0Ticket.cpp" ^
   /link /DEF:"%~dp0SwiffCP.def" ^
   Secur32.lib Crypt32.lib Advapi32.lib Ole32.lib User32.lib

set ERR=%ERRORLEVEL%
popd

if %ERR% neq 0 (
  echo.
  echo BUILD FAILED
  exit /b %ERR%
)

echo.
echo Built: %~dp0build\SwiffCP.dll
dumpbin /nologo /exports "%~dp0build\SwiffCP.dll" | findstr /i "DllGetClassObject DllCanUnloadNow"
endlocal
