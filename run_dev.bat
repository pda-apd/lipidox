@echo off
cd /d "%~dp0backend"

if not exist .venv\Scripts\python.exe (
    echo [1/3] Creating venv...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

python -c "import fastapi" 2>nul
if errorlevel 1 (
    echo [2/3] Installing requirements...
    pip install -r requirements.txt
)

echo [3/3] Freeing port 7860 from any stale server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7860 " ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1

echo [cache] Server sends no-cache headers for all pages/assets - no manual cache clearing needed.
echo Starting server at http://localhost:7860
start "" cmd /c "timeout /t 3 >nul & start http://localhost:7860"
python main.py
pause
