@echo off
setlocal
rem ============================================================
rem  Big Fat Orange Cat - desktop pet launcher
rem  Clears ELECTRON_RUN_AS_NODE first: if it leaks in, Electron
rem  boots as plain Node and dies with "Cannot find module 'electron'".
rem ============================================================
set "ELECTRON_RUN_AS_NODE="
rem Dedicated home: keeps this pet's config / memory / voice-cache away from
rem DSH's own dsh-pet plugin, so the two never share a character again.
rem DSH reads ~/.dsh ; this app reads ~/.dsh-cat.
set "DSH_HOME=C:\Users\lianzhi\.dsh-cat"
rem Electron still lives in the DSH home, so point at it explicitly:
rem start-app.mjs looks under %DSH_HOME%\electron by default.
set "DSH_PET_ELECTRON_PATH=C:\Users\lianzhi\.dsh\electron\electron.exe"
set "NODE_EXE=C:\Users\lianzhi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "ELECTRON_EXE=C:\Users\lianzhi\.dsh\electron\electron.exe"

cd /d "%~dp0plugin"

if not exist "%NODE_EXE%" (
  echo [ERR] DSH node runtime not found:
  echo       %NODE_EXE%
  pause
  exit /b 1
)
if not exist "lib\app.js" (
  echo [ERR] lib\app.js missing - build it first:
  echo       "%NODE_EXE%" node_modules\tsdown\bin\tsdown.js --config tsdown.pet.mjs
  pause
  exit /b 1
)
if not exist "%ELECTRON_EXE%" (
  echo [ERR] Electron not found at %ELECTRON_EXE%
  echo       Run: node scripts\ensure-electron.mjs
  pause
  exit /b 1
)

echo Starting pet... (close this window to stop it)
"%NODE_EXE%" scripts\start-app.mjs
