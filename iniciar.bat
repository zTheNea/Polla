@echo off
title Polla Futbolera Server
chcp 65001 >nul

echo Iniciando servidor FastAPI...
start "PollaAPI" cmd /k "uvicorn main:app --reload --host 0.0.0.0 --port 8000"

timeout /t 2 /nobreak >nul

echo Iniciando tunnel ngrok...
start "NgrokTunnel" cmd /k "ngrok http 8000"

timeout /t 3 /nobreak >nul

start http://localhost:4040

echo.
echo ===============================================
echo    POLLA FUTBOLERA INICIADO!
echo ===============================================
echo    Link: https://silklike-groomishly-marybeth.ngrok-free.dev/
echo    Servidor: http://localhost:8000
echo ===============================================
