@echo off
REM Memo-House - Caddy launcher (ki-pc).
REM Serves the static frontend (apps\web\dist) and reverse-proxies the backend
REM with auto-TLS. Reuses the stable caddy.exe copy the special-memory deploy
REM installed at C:\Users\Yegor\bin. Self-restarts if Caddy exits.
REM NOTE: only one Caddy may hold 80/443 on this box - stop special-memory's
REM Caddy first (see deploy\README.md).

set "CADDY=C:\Users\Yegor\bin\caddy.exe"
set "REPO=D:\Yegor\Github\MEMO-HAUS SUMMAERY-PARTHA\MEMO-HAUS-VO1"
cd /d "%REPO%"

:loop
echo [%date% %time%] starting Caddy (HTTPS on 80/443)
"%CADDY%" run --config deploy\Caddyfile
echo [%date% %time%] caddy exited (code %errorlevel%); restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
