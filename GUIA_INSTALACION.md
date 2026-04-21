# 📘 Guía de Instalación y Configuración — Polla Futbolera

Esta guía cubre la instalación local, configuración de producción y resolución de problemas comunes.

---

## Tabla de Contenido

1. [Requisitos Previos](#1-requisitos-previos)
2. [Instalación Local (Desarrollo)](#2-instalación-local-desarrollo)
3. [Configuración de Producción](#3-configuración-de-producción)
4. [Despliegue en la Nube](#4-despliegue-en-la-nube)
5. [Exposición con ngrok (Pruebas)](#5-exposición-con-ngrok-pruebas)
6. [Estructura de la Base de Datos](#6-estructura-de-la-base-de-datos)
7. [API Endpoints](#7-api-endpoints)
8. [Solución de Problemas](#8-solución-de-problemas)
9. [Mantenimiento](#9-mantenimiento)

---

## 1. Requisitos Previos

| Software | Versión Mínima | Verificar con |
|---|---|---|
| Python | 3.10+ | `python --version` |
| pip | 21.0+ | `pip --version` |
| Git | 2.30+ | `git --version` |

### Opcional (para pruebas remotas)
- [ngrok](https://ngrok.com/download) — Para exponer tu servidor local a Internet.

---

## 2. Instalación Local (Desarrollo)

### Paso 1: Clonar el Repositorio

```bash
git clone https://github.com/tu-usuario/PollaFutbolera.git
cd PollaFutbolera
```

### Paso 2: Crear Entorno Virtual

```bash
# Crear
python -m venv .venv

# Activar (Windows)
.venv\Scripts\activate

# Activar (Linux/Mac)
source .venv/bin/activate
```

### Paso 3: Instalar Dependencias

```bash
pip install -r requirements.txt
```

**Dependencias principales:**

| Paquete | Propósito |
|---|---|
| `fastapi` | Framework web asíncrono |
| `uvicorn` | Servidor ASGI |
| `passlib[bcrypt]` | Hash seguro de contraseñas |
| `httpx` | Cliente HTTP asíncrono (API ESPN) |
| `slowapi` | Rate limiting para prevenir abuso |
| `pydantic` | Validación de datos |
| `email-validator` | Validación de correos electrónicos |
| `python-multipart` | Soporte para form-data |
| `soccerdata` | Datos estadísticos ELO (opcional) |

### Paso 4: Configurar Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto:

```env
POLLA_SECRET=tu_clave_secreta_aqui_32_caracteres_minimo
```

Para generar una clave segura:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### Paso 5: Iniciar el Servidor

```bash
# Desarrollo con hot-reload
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

O usa los scripts de lanzamiento rápido:

- **Windows:** Doble clic en `iniciar.bat`
- **Linux/Mac:** `chmod +x iniciar.sh && ./iniciar.sh`

### Paso 6: Acceder a la Aplicación

- **App:** http://localhost:8000
- **Documentación API:** http://localhost:8000/docs (Swagger UI)

---

## 3. Configuración de Producción

### Variables de Entorno

| Variable | Descripción | Ejemplo |
|---|---|---|
| `POLLA_SECRET` | Clave HMAC para tokens JWT. **Obligatoria en producción.** | `08ae5ae1...cae6aa364` |
| `CORS_ORIGINS` | Orígenes permitidos (separados por coma) | `https://tudominio.com,https://app.tudominio.com` |
| `PORT` | Puerto del servidor | `8000` |

### Base de Datos

La aplicación usa SQLite con **modo WAL** (Write-Ahead Logging) para rendimiento en lectura concurrente.

**Importante para producción:**
- La base de datos (`polla.db`) se crea automáticamente en el directorio del proyecto.
- En plataformas cloud, monta un **volumen persistente** para evitar pérdida de datos entre deploys.
- SQLite es adecuado para hasta ~100 usuarios concurrentes. Para mayor escala, migrar a PostgreSQL.

### Seguridad

- Las contraseñas se almacenan con **bcrypt** (hash + salt).
- Los tokens de sesión expiran en **48 horas**.
- El rate limiter (`slowapi`) protege las rutas de autenticación:
  - Login: 20 intentos / minuto
  - Registro: 10 intentos / minuto
- Las entradas de chat se sanitizan para prevenir **XSS**.

---

## 4. Despliegue en la Nube

### Render

1. Crea un nuevo **Web Service** en [Render](https://render.com).
2. Conecta tu repositorio de GitHub.
3. Configura:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Agrega las variables de entorno en el dashboard.
5. (Opcional) Agrega un **Disk** montado en `/data` para persistir la base de datos.

### Railway

1. Crea un nuevo proyecto en [Railway](https://railway.app).
2. Conecta tu repositorio.
3. Railway detectará automáticamente FastAPI.
4. Agrega `POLLA_SECRET` en Settings → Variables.

### Heroku

El archivo `Procfile` ya está configurado:

```
web: uvicorn main:app --host 0.0.0.0 --port $PORT
```

```bash
heroku create polla-futbolera
heroku config:set POLLA_SECRET=$(python -c "import secrets; print(secrets.token_hex(32))")
git push heroku main
```

---

## 5. Exposición con ngrok (Pruebas)

Para compartir tu servidor local con amigos durante el desarrollo:

```bash
# Terminal 1: Servidor
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Terminal 2: Tunnel
ngrok http 8000
```

El script `iniciar.bat` automatiza este proceso en Windows.

---

## 6. Estructura de la Base de Datos

```sql
-- Usuarios registrados
usuarios (correo PK, nombre, password, avatar, alertas, token, token_expiry)

-- Grupos de juego
grupos (id PK, nombre, codigo UNIQUE, correo_creador, liga, limite)

-- Relación usuario-grupo
miembros_grupo (grupo_id, correo_usuario) PK(grupo_id, correo_usuario)

-- Pronósticos
pronosticos (grupo_id, correo_usuario, id_partido, goles_local, goles_visitante)
            PK(grupo_id, correo_usuario, id_partido)

-- Chat
chat_mensajes (id PK, grupo_id, correo_usuario, mensaje, fecha)

-- Historial de puntos
puntos_historial (grupo_id, correo_usuario, puntos, fecha)
                  PK(grupo_id, correo_usuario, fecha)

-- Logros / Badges
logros (id PK, correo, badge_id, fecha) UNIQUE(correo, badge_id)
```

---

## 7. API Endpoints

### Autenticación
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/registro` | Registrar nuevo usuario |
| POST | `/api/auth/login` | Iniciar sesión |

### Grupos
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/grupos/crear` | Crear nuevo grupo |
| POST | `/api/grupos/unirse` | Unirse a grupo por código |
| GET | `/api/grupos/mis-grupos` | Listar grupos del usuario |
| POST | `/api/grupos/eliminar` | Eliminar grupo (solo creador) |
| POST | `/api/grupos/salir` | Salir de un grupo |

### Partidos
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/partidos/{liga}` | Listar partidos de una liga |
| GET | `/api/partidos/detalle/{id}` | Detalle completo de un partido |

### Pronósticos
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/pronosticos/guardar` | Guardar pronóstico(s) |
| GET | `/api/pronosticos/{gid}/{correo}` | Obtener pronósticos de un usuario |
| GET | `/api/pronosticos/distribucion/{gid}/{pid}` | Distribución de pronósticos del grupo |

### Ranking
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/posiciones/{gid}` | Ranking completo del grupo |

### Chat
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/chat/{gid}` | Obtener mensajes del chat |
| POST | `/api/chat/{gid}` | Enviar mensaje al chat |
| WS | `/ws/{gid}` | WebSocket para chat en tiempo real |

### Utilidades
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/utils/server-time` | Hora del servidor (sincronización) |
| GET | `/api/ligas/info` | Info y fechas de ligas activas |

---

## 8. Solución de Problemas

### El servidor no inicia

```
ModuleNotFoundError: No module named 'fastapi'
```
**Solución:** Activa el entorno virtual y reinstala dependencias:
```bash
.venv\Scripts\activate  # Windows
pip install -r requirements.txt
```

### La base de datos está bloqueada

```
sqlite3.OperationalError: database is locked
```
**Solución:** SQLite tiene limitaciones con escritura concurrente. La aplicación usa modo WAL para mitigarlo. Si persiste:
1. Detén el servidor.
2. Elimina los archivos `*.db-wal` y `*.db-shm`.
3. Reinicia el servidor.

### Los datos de los partidos no cargan

**Posibles causas:**
1. La API de ESPN está temporalmente caída.
2. El slug de la liga no es válido.
3. Problema de red/firewall.

**Verificar:** Accede a `http://localhost:8000/docs` y prueba el endpoint `/api/partidos/champions`.

### Los tokens expiran muy rápido

Los tokens duran **48 horas** por defecto. Si `POLLA_SECRET` no está definida, se genera una clave temporal y **todos los tokens se invalidarán al reiniciar el servidor**.

**Solución:** Configura `POLLA_SECRET` en el archivo `.env`.

---

## 9. Mantenimiento

### Actualizar dependencias

```bash
pip install --upgrade -r requirements.txt
```

### Respaldar la base de datos

```bash
# Copia simple (detener servidor primero)
cp polla.db polla_backup_$(date +%Y%m%d).db
```

### Ejecutar tests

```bash
pytest test_main.py -v
```

### Actualizar el Service Worker

Al hacer cambios en el frontend, incrementa la versión del cache en `sw.js`:

```javascript
const CACHE_NAME = 'polla-v3.5';  // Incrementar la versión
```

---

## 📞 Soporte

Si tienes preguntas o encuentras un bug, abre un [Issue en GitHub](https://github.com/tu-usuario/PollaFutbolera/issues).
