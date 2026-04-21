@echo off
title Polla Futbolera Server
chcp 65001 >nul

:: Cargar variables de entorno desde .env
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    set "%%A=%%B"
)

echo Iniciando servidor FastAPI...
start "PollaAPI" cmd /k "uvicorn main:app --reload --host 0.0.0.0 --port 8000"

timeout /t 2 /nobreak >nul

echo Iniciando tunnel ngrok...
start "NgrokTunnel" cmd /k ".\ngrok.exe http 8000"

timeout /t 3 /nobreak >nul

start http://localhost:4040

echo.
echo ===============================================
echo    POLLA FUTBOLERA INICIADO!
echo ===============================================
echo    Servidor Local: http://localhost:8000
echo    Dashboard ngrok (para ver tu link publico): http://localhost:4040
echo ===============================================
