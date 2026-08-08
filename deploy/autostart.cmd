@echo off
REM Memo-House - exhibition autostart (ki-pc).
REM Launches the backend and Caddy, each in its own minimized, self-restarting window.
REM Put a shortcut to this file in the Startup folder to bring the stack up on login.
REM Run it by hand any time to (re)start everything.

start "memo-haus-backend" /min cmd /c "D:\Yegor\Github\MEMO-HAUS SUMMAERY-PARTHA\MEMO-HAUS-VO1\deploy\start-backend.cmd"
start "memo-haus-caddy"   /min cmd /c "D:\Yegor\Github\MEMO-HAUS SUMMAERY-PARTHA\MEMO-HAUS-VO1\deploy\start-caddy.cmd"
