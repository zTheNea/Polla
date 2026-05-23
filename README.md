# ⚽ Polla Futbolera

> Plataforma de predicciones deportivas en tiempo real. Crea grupos, invita amigos, pronostica resultados y compite en rankings dinámicos.

![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688?logo=fastapi&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-FFCA28?logo=firebase&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![PWA](https://img.shields.io/badge/PWA-Ready-5A0FC8?logo=pwa&logoColor=white)

---

## 🎯 Características

- **Multi-Liga** — Champions League, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Copa Libertadores, Liga BetPlay, Brasileirão, Copa América, Eliminatorias y Mundial.
- **Grupos Privados** — Crea salas con código de invitación para competir con amigos (máx. 20 miembros).
- **Pronósticos** — Registra tu predicción antes de cada partido. Se bloquean 10 minutos antes del inicio.
- **Ranking Dinámico** — Tabla de posiciones en tiempo real con cambios de posición entre jornadas.
- **Datos en Vivo** — Sincronización automática con ESPN para marcadores, cronología, alineaciones y estadísticas.
- **Arquitectura Serverless** — Backend en Google Cloud Run y base de datos en Firebase Firestore.
- **PWA** — Instalable en el celular como app nativa con soporte offline.
- **Diseño Moderno** — Fondos "Mesh Gradient", Dark Mode inteligente y micro-animaciones fluidas.

---

## 🏗️ Arquitectura

```
┌────────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Frontend PWA      │◄───►│  FastAPI Backend │◄───►│  ESPN API   │
│  Firebase Hosting  │     │  Google Cloud Run│     │  Live Data  │
│  Vanilla JS + TW   │     │  Firestore DB    │     └─────────────┘
└────────────────────┘     └──────────────────┘
```

| Componente | Tecnología |
|---|---|
| Backend | FastAPI + Uvicorn (Cloud Run) |
| Base de Datos | Firebase Firestore |
| Frontend | Vanilla JS + Tailwind CSS CDN (Firebase Hosting) |
| Datos Deportivos | ESPN API (scoreboard + detalle) |
| Seguridad | bcrypt + JWT tokens + rate limiting |
| PWA | Service Worker + Manifest |

---

## 📁 Estructura del Proyecto

```
PollaFutbolera/
├── main.py              # 🐍 Backend FastAPI (API + Firestore DB)
├── index.html           # 🌐 Frontend SPA
├── js/
│   ├── ui.js            # Navegación, temas, interceptor de auth
│   ├── auth.js          # Login, registro, gestión de tokens
│   ├── grupos.js        # Grupos, partidos, pronósticos, detalles
│   ├── ranking.js       # Tabla de posiciones del grupo
│   ├── stats.js         # Estadísticas personales y logros
│   └── icon-512.png     # Ícono de la PWA
├── sw.js                # Service Worker (cache + offline)
├── manifest.json        # Manifiesto PWA
├── requirements.txt     # Dependencias Python
├── Dockerfile           # Imagen Docker para Cloud Run
├── firebase.json        # Configuración de Firebase Hosting
├── .env                 # Variables de entorno (NO subir a Git)
├── .gitignore           # Exclusiones de Git
├── CONTRIBUTING.md      # Guía para contribuidores
└── LICENSE              # Licencia MIT
```

---

## 🔐 Variables de Entorno

Para despliegue en Cloud Run, debes configurar las siguientes variables de entorno:

| Variable | Descripción | Requerida |
|---|---|---|
| `POLLA_SECRET` | Clave secreta HMAC para firmar tokens de sesión | Sí |
| `CORS_ORIGINS` | Orígenes permitidos (separados por coma, ej: `https://tu-app.web.app`) | No |

> 💡 Si `POLLA_SECRET` no está definida, se generará una automáticamente y se almacenará en Firestore (`system/config`) para que las sesiones persistan sin configuración adicional.

---

## 📊 Sistema de Puntuación

| Resultado | Puntos |
|---|---|
| Marcador exacto | **5** puntos |
| Resultado correcto (sin goles exactos) | **3** puntos |
| Sin coincidencia | **0** puntos |

---

## 🌐 Despliegue Gratuito (Google Cloud / Firebase)

Este proyecto está optimizado para funcionar 100% en la capa gratuita de **Google Cloud Run** y **Firebase**.

### 1. Despliegue del Frontend (Firebase Hosting)
Instala las [Firebase CLI](https://firebase.google.com/docs/cli) y ejecuta:
```bash
firebase login
firebase deploy --only hosting
```

### 2. Despliegue del Backend (Google Cloud Run)
Asegúrate de tener instalado el [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) y ejecuta:
```bash
gcloud auth login
gcloud config set project TU_ID_DE_PROYECTO

# Desplegar el contenedor de FastAPI
gcloud run deploy polla-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --memory 512Mi
```
> **Nota:** Limitar a `--max-instances 1` garantiza que te mantengas siempre dentro del Free Tier de Google Cloud.

---

## 📝 Licencia

Este proyecto está bajo la [Licencia MIT](LICENSE).

---

## 🤝 Contribuir

¿Quieres contribuir? Lee nuestra [guía de contribución](CONTRIBUTING.md).
