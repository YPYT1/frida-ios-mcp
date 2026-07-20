@echo off
set "ROOT=%~dp0.."
node "%ROOT%\dist\daemon.js" %*
