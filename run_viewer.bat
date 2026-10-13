@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0tools\run_viewer.ps1" -InputPath "%~1"
set "VIEWER_EXIT=%ERRORLEVEL%"

if not "%VIEWER_EXIT%"=="0" (
  echo.
  echo 실행하지 못했습니다. 위 오류를 확인하세요.
  pause
)
exit /b %VIEWER_EXIT%
