@echo off
REM Kill process listening on a port. Default: 3000
REM Usage: kill-port.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=3000

echo Looking for process on port %PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  echo Killing PID %%a...
  taskkill /PID %%a /F
  goto :done
)

echo No process found on port %PORT%
:done
