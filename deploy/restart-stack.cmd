@echo off
REM Memo-House - safe restart / takeover (ki-pc).
REM Stops any running Caddy and both projects' backend loops FIRST (they hold
REM ports 80/443/8000/8001), then starts the Memo-House stack via autostart.cmd.
REM Use this instead of re-running autostart.cmd by hand: the old self-restart
REM loops keep holding the ports, so a bare re-run would just fail to bind.
REM It kills by command line / image, so console window titles don't matter -
REM and it also stops the special-memory stack so Memo-House takes over the domain.

echo Stopping any running Caddy + backend loops (memo-haus AND special-memory)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.Name -eq 'caddy.exe' -or $_.CommandLine -match 'start-backend\.cmd' -or $_.CommandLine -match 'start-caddy\.cmd' -or $_.CommandLine -match 'uvicorn main:app' -or $_.CommandLine -match 'uvicorn backend\.app') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul

echo Starting memo-haus stack...
call "%~dp0autostart.cmd"
echo Done. Backend on 127.0.0.1:8001, Caddy on :80/:443.
