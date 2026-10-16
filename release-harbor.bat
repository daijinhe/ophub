@echo off
REM 云枢 OpsHub · 智能运维平台
REM Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
REM SPDX-License-Identifier: MIT

REM ==========================================================================
REM  release-harbor.bat  --  Windows entry point for scripts/harbor_release.sh
REM
REM  This file is pure ASCII on purpose (cmd.exe decodes .bat with the local
REM  ANSI codepage; non-ASCII bytes would turn into mojibake).
REM
REM  Usage:
REM    double-click                     -> asks for a commit message, then
REM                                        commit + build + push to Harbor
REM    release-harbor.bat --status      -> read-only check (Harbor + images)
REM    release-harbor.bat --with-base   -> also push postgres/redis base images
REM    release-harbor.bat --no-build    -> skip build, retag + push only
REM    release-harbor.bat --save-only   -> do not push, export images to dist/
REM    release-harbor.bat --login       -> docker login to Harbor only
REM
REM  Switches above can be combined, e.g.: release-harbor.bat --with-base
REM ==========================================================================
setlocal enabledelayedexpansion

set "GB=D:\01_Software_Tools\01_Work\Git\bin\bash.exe"
if not exist "%GB%" set "GB=C:\Program Files\Git\bin\bash.exe"
if not exist "%GB%" set "GB=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not exist "%GB%" (
  echo [ERROR] bash.exe not found. Install Git for Windows first.
  echo         Tried: D:\01_Software_Tools\01_Work\Git\bin\bash.exe
  pause
  exit /b 1
)

cd /d "%~dp0"

REM ---- collect switch flags (tokens without spaces) ----
set "FLAGS="
:parse
if "%~1"=="" goto parsed
set "FLAGS=!FLAGS! %~1"
shift
goto parse
:parsed

set "HR_MSG="
if defined FLAGS goto skipask
echo ==========================================================
echo   OpsHub Harbor Release
echo   Repo : %CD%
echo ==========================================================
for /f "delims=" %%i in ('"%GB%" -c "git rev-parse --abbrev-ref HEAD" 2^>nul') do set "BR=%%i"
echo   Branch: !BR!
if "!BR!"=="HEAD" (
  echo.
  echo   [WARN] detached HEAD - release.sh REFUSES to commit here.
  echo          Fix it first:  git checkout main
  echo.
)
echo.
set /p HR_MSG="Commit message (ENTER = skip git commit, build+push only): "
:skipask

echo.
if defined HR_MSG (
  echo   Running: bash scripts/harbor_release.sh%FLAGS% --git "!HR_MSG!"
  "%GB%" -c "bash scripts/harbor_release.sh%FLAGS% --git \"$HR_MSG\""
) else (
  echo   Running: bash scripts/harbor_release.sh%FLAGS%
  "%GB%" -c "bash scripts/harbor_release.sh%FLAGS%"
)
set "RC=!ERRORLEVEL!"

echo.
if "!RC!"=="0" (echo ================= SUCCESS ================) else (echo ================= FAILED  rc=!RC! ================)
pause
endlocal & exit /b !RC!
