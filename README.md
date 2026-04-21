# ⚽ Polla Futbolera

> Plataforma de predicciones deportivas en tiempo real. Crea grupos, invita amigos, pronostica resultados y compite en rankings dinámicos.

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688?logo=fastapi&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![PWA](https://img.shields.io/badge/PWA-Ready-5A0FC8?logo=pwa&logoColor=white)

---

## 🎯 Características

- **Multi-Liga** — Champions League, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Copa Libertadores, Liga BetPlay, Brasileirão, Copa América, Eliminatorias y Mundial.
- **Grupos Privados** — Crea salas con código de invitación para competir con amigos (máx. 20 miembros).
- **Pronósticos** — Registra tu predicción antes de cada partido. Se bloquean 10 minutos antes del inicio.
- **Ranking Dinámico** — Tabla de posiciones en tiempo real con cambios de posición entre jornadas.
- **Datos en Vivo** — Sincronización automática con ESPN para marcadores, cronología, alineaciones y estadísticas.
- **Chat en Tiempo Real** — WebSockets con fallback a polling HTTP para garantizar la entrega de mensajes.
- **PWA** — Instalable en el celular como app nativa con soporte offline.
- **Modo Oscuro** — Cambio de tema automático o manual.

---

## 🏗️ Arquitectura

```
┌────────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Frontend (SPA)    │◄───►│  FastAPI Backend  │◄───►│  ESPN API   │
│  Vanilla JS + TW   │     │  SQLite + WAL     │     │  Live Data  │
│  index.html        │     │  main.py          │     └─────────────┘
│  js/*.js           │     │                   │
│  PWA (sw.js)       │     │  WebSockets       │
└────────────────────┘     └──────────────────┘
```

| Componente | Tecnología |
|---|---|
| Backend | FastAPI + Uvicorn |
| Base de Datos | SQLite (modo WAL) |
| Frontend | Vanilla JS + Tailwind CSS CDN |
| Tiempo Real | WebSockets + HTTP Polling (fallback) |
| Datos Deportivos | ESPN API (scoreboard + detalle) |
| Seguridad | bcrypt + HMAC tokens + rate limiting |
| PWA | Service Worker + Manifest |

---

## 🚀 Inicio Rápido

### Requisitos

- Python 3.10+
- pip

### Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/tu-usuario/PollaFutbolera.git
cd PollaFutbolera

# 2. Crear entorno virtual
python -m venv .venv

# Windows
.venv\Scripts\activate

# Linux/Mac
source .venv/bin/activate

# 3. Instalar dependencias
pip install -r requirements.txt

# 4. Configurar variables de entorno
cp .env.example .env
# Editar .env y establecer POLLA_SECRET
```

### Ejecución Local

```bash
# Opción 1: Comando directo
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Opción 2: Script Windows
iniciar.bat

# Opción 3: Script Linux/Mac
chmod +x iniciar.sh && ./iniciar.sh
```

Abre **http://localhost:8000** en tu navegador.

---

## 📁 Estructura del Proyecto

```
PollaFutbolera/
├── main.py              # 🐍 Backend completo (API + DB + WebSockets)
├── index.html           # 🌐 Frontend SPA
├── js/
│   ├── ui.js            # Navegación, temas, interceptor de auth
│   ├── auth.js          # Login, registro, gestión de tokens
│   ├── grupos.js        # Grupos, partidos, pronósticos, detalles
│   ├── chat.js          # Chat WebSocket con fallback polling
│   ├── ranking.js       # Tabla de posiciones del grupo
│   ├── stats.js         # Estadísticas personales y logros
│   └── icon-512.png     # Ícono de la PWA
├── sw.js                # Service Worker (cache + offline)
├── manifest.json        # Manifiesto PWA
├── requirements.txt     # Dependencias Python
├── Procfile             # Despliegue en cloud (Heroku/Render)
├── iniciar.bat          # Lanzador Windows (uvicorn + ngrok)
├── iniciar.sh           # Lanzador Linux/Mac
├── test_main.py         # Suite de tests unitarios (pytest)
├── .env                 # Variables de entorno (NO subir a Git)
├── .gitignore           # Exclusiones de Git
├── GUIA_INSTALACION.md  # Manual detallado de instalación
├── CONTRIBUTING.md      # Guía para contribuidores
└── LICENSE              # Licencia MIT
```

---

## 🔐 Variables de Entorno

| Variable | Descripción | Requerida |
|---|---|---|
| `POLLA_SECRET` | Clave secreta HMAC para firmar tokens de sesión | Sí |
| `CORS_ORIGINS` | Orígenes permitidos (separados por coma) | No |
| `PORT` | Puerto del servidor (default: 8000) | No |

> ⚠️ Si `POLLA_SECRET` no está definida, se genera una clave temporal. Los tokens no sobrevivirán reinicios del servidor.

---

## 🧪 Tests

```bash
# Ejecutar toda la suite
pytest test_main.py -v

# Ejecutar un test específico
pytest test_main.py::test_registrar_y_login -v
```

---

## 📊 Sistema de Puntuación

| Resultado | Puntos |
|---|---|
| Marcador exacto | **5** puntos |
| Resultado correcto (sin goles exactos) | **3** puntos |
| Sin coincidencia | **0** puntos |

---

## 🌐 Despliegue

### Render / Railway

1. Conectar el repositorio de GitHub.
2. Configurar variables de entorno (`POLLA_SECRET`).
3. Comando de inicio: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. La base de datos SQLite requiere un volumen persistente montado en `/data`.

### Heroku

El `Procfile` ya está configurado:
```
web: uvicorn main:app --host 0.0.0.0 --port $PORT
```

---

## 📝 Licencia

Este proyecto está bajo la [Licencia MIT](LICENSE).

---

## 🤝 Contribuir

¿Quieres contribuir? Lee nuestra [guía de contribución](CONTRIBUTING.md).
