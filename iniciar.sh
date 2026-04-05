#!/bin/bash

echo "Iniciando servidor FastAPI..."
gnome-terminal --tab --title="PollaAPI" -- bash -c "uvicorn main:app --reload --host 0.0.0.0 --port 8000; exec bash" 2>/dev/null || \
xterm -e "uvicorn main:app --reload --host 0.0.0.0 --port 8000" &

sleep 3

echo "Iniciando tunnel ngrok..."
gnome-terminal --tab --title="NgrokTunnel" -- bash -c "ngrok http 8000; exec bash" 2>/dev/null || \
xterm -e "ngrok http 8000" &

echo ""
echo "==============================================="
echo "  Polla Futbolera iniciado!"
echo "  Servidor: http://localhost:8000"
echo "  Docs API: http://localhost:8000/docs"
echo "  Dashboard ngrok: http://localhost:4040"
echo "==============================================="
