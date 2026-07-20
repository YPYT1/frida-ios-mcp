@echo off
REM Single-entry launcher so Grok/Cursor only need `command` (no args).
set "ROOT=%~dp0.."
node "%ROOT%\dist\index.js" %*
