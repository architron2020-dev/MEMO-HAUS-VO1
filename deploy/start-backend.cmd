@echo off
REM Memo-House - FastAPI backend launcher (ki-pc).
REM Runs uvicorn with the ml-sharp venv's Python so SHARP inference gets the GPU.
REM Binds 127.0.0.1 only: the backend is private; Caddy is the public HTTPS front.
REM Self-restarts if the server exits, so a crash doesn't take the exhibition down.

set "REPO=D:\Yegor\Github\MEMO-HAUS SUMMAERY-PARTHA\MEMO-HAUS-VO1"
set "PY=%REPO%\packages\ml-sharp\.venv\Scripts\python.exe"
set "MEMO_API_PORT=8001"
REM run-api.mjs's env tuning, replicated so the direct uvicorn launch behaves the same:
set "CUDA_MODULE_LOADING=LAZY"
set "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True"

cd /d "%REPO%\apps\api"

:loop
echo [%date% %time%] starting backend on 127.0.0.1:%MEMO_API_PORT%
"%PY%" -m uvicorn main:app --host 127.0.0.1 --port %MEMO_API_PORT%
echo [%date% %time%] backend exited (code %errorlevel%); restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
