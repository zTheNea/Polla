from fastapi import FastAPI, HTTPException, Depends, Header, Request, WebSocket, WebSocketDisconnect # type: ignore
import logging

logger = logging.getLogger("polla")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
from passlib.context import CryptContext # type: ignore
from fastapi.middleware.cors import CORSMiddleware # type: ignore
import uvicorn
from fastapi.staticfiles import StaticFiles # type: ignore
from fastapi.responses import FileResponse # type: ignore
from pydantic import BaseModel, Field, EmailStr # type: ignore
from typing import List, Optional, Dict, Tuple, Any
from dataclasses import dataclass
import sqlite3
import random
import string
import secrets
import hashlib
import hmac
import httpx # type: ignore
from datetime import datetime, timedelta, timezone
import os
from slowapi import Limiter, _rate_limit_exceeded_handler # type: ignore
from slowapi.util import get_remote_address # type: ignore
from slowapi.errors import RateLimitExceeded # type: ignore
import time
import asyncio
import threading
try:
    import soccerdata as sd
    HAS_SOCCERDATA = True
except ImportError:
    HAS_SOCCERDATA = False

# --- CACHE GLOBAL DE SOCCERDATA (Probabilidades y Forma) ---
sd_stats_cache = {}
sd_last_update = 0

def background_soccerdata():
    global sd_stats_cache
    while True:
        if HAS_SOCCERDATA:
            try:
                logger.info("SoccerData: Refrescando datos de Club ELO...")
                elo = sd.ClubElo()
                df = elo.read_by_date()
                elo_map = {}
                for idx, row in df.iterrows():
                    k = str(idx).lower().replace(" ", "").replace("fc", "").replace("cf", "").replace("cd", "")
                    elo_map[k] = float(row['elo'])
                sd_stats_cache['elo'] = elo_map
                logger.info("SoccerData: ELO actualizado correctamente.")
            except Exception as e:
                logger.error(f"Fallo en soccerdata ELO: {e}")
        time.sleep(3600 * 6) # Refrescar cada 6 horas

threading.Thread(target=background_soccerdata, daemon=True).start()

def normalizar_equipo(n):
    return str(n).lower().replace(" ", "").replace("fc", "").replace("cf", "").replace("cd", "").replace("ud", "").replace("ca", "")

def calcular_probabilidades_y_forma(nombre_local, nombre_visita):
    elo_cache = sd_stats_cache.get('elo', {})
    nl = normalizar_equipo(nombre_local)
    nv = normalizar_equipo(nombre_visita)
    
    elo_l = 1500
    elo_v = 1500
    for k, v in elo_cache.items():
        if k in nl or nl in k: elo_l = v; break
    for k, v in elo_cache.items():
        if k in nv or nv in k: elo_v = v; break

    # Probabilidades (V-E-D) basadas en matemática ELO + ventanja de localía (+70 ELO)
    elo_l_adj = elo_l + 70
    dr = elo_l_adj - elo_v
    we_l = 1 / (10**(-dr/400) + 1)
    # Empate fijo ajustado a curva normal, simplificado ~ 25% base + ajuste_paridad
    prob_e = 0.28 * (1 - min(abs(dr)/400, 1))
    prob_l = we_l * (1 - prob_e)
    prob_v = (1 - we_l) * (1 - prob_e)
    total = prob_l + prob_e + prob_v
    
    # Generar forma histórica de 5 partidos coherente con ELO
    def generar_forma(elo):
        f = []
        p_win = 0.35 + (elo - 1500) * 0.001
        for _ in range(5):
            r = random.random()
            if r < p_win: f.append('V')
            elif r < p_win + 0.3: f.append('E')
            else: f.append('D')
        return f
        
    return {
        "prob_l": int(prob_l/total*100), "prob_e": int(prob_e/total*100), "prob_v": int(prob_v/total*100),
        "forma_l": generar_forma(elo_l), "forma_v": generar_forma(elo_v)
    }

app = FastAPI()

# --- CACHÉ EN MEMORIA PARA ESPN ---
espn_cache = {}
CACHE_TTL = 15 # segundos de vida para la caché
CACHE_MAX_SIZE = 200

# --- CACHÉ EN MEMORIA PARA POSICIONES (RANKING PROCESADO) ---
posiciones_cache = {}
POS_CACHE_TTL = 30 # Segundos que vive el cálculo de la tabla

# --- LIGAS ACTIVAS (Sincronización Inteligente) ---
ACTIVE_LEAGUES = set()
USER_CACHE = {} 
USER_CACHE_TTL = 300 

# Cerraduras para evitar "Thundering Herd" (múltiples pedidos a ESPN al mismo tiempo)
fetch_locks: Dict[str, asyncio.Lock] = {}

async def get_espn_data(url: str, cache_key: str, ttl: int = CACHE_TTL) -> Optional[dict]:
    """Obtiene datos de ESPN manejando caché y bloqueos de concurrencia."""
    now = time.time()
    if cache_key in espn_cache:
        data, ts = espn_cache[cache_key]
        if now - ts < ttl:
            return data

    if url not in fetch_locks:
        fetch_locks[url] = asyncio.Lock()

    async with fetch_locks[url]:
        # Doble verificación dentro del candado
        if cache_key in espn_cache:
            data, ts = espn_cache[cache_key]
            if now - ts < ttl:
                return data
        
        try:
            async with httpx.AsyncClient() as client:
                logger.info(f"FETCH: Pidiendo datos a ESPN: {url}")
                r = await client.get(url, timeout=10.0)
                if r.status_code == 200:
                    datos = r.json()
                    espn_cache[cache_key] = (datos, time.time())
                    _evict_cache()
                    return datos
        except Exception as e:
            logger.error(f"Error en fetch_espn para {url}: {e}")
    return None

def _evict_cache():
    """Elimina entradas expiradas y las más antiguas si se excede el límite."""
    now = time.time()
    expired = [k for k, (_, ts) in espn_cache.items() if now - ts >= CACHE_TTL]
    for k in expired:
        del espn_cache[k]
    while len(espn_cache) > CACHE_MAX_SIZE:
        oldest_key = min(espn_cache, key=lambda k: espn_cache[k][1])
        del espn_cache[oldest_key]

# --- WEBSOCKET MANAGER ---
class ConnectionManager:
    def __init__(self):
        self.active_connections = {}

    async def connect(self, websocket: WebSocket, grupo_id: int):
        await websocket.accept()
        if grupo_id not in self.active_connections:
            self.active_connections[grupo_id] = []
        self.active_connections[grupo_id].append(websocket)

    def disconnect(self, websocket: WebSocket, grupo_id: int):
        if grupo_id in self.active_connections:
            if websocket in self.active_connections[grupo_id]:
                self.active_connections[grupo_id].remove(websocket)

    async def broadcast(self, message: dict, grupo_id: int):
        if grupo_id in self.active_connections:
            dead = []
            for connection in self.active_connections[grupo_id]:
                try:
                    await connection.send_json(message)
                except Exception:
                    dead.append(connection)
            for d in dead:
                self.active_connections[grupo_id].remove(d)

ws_manager = ConnectionManager()

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Clave secreta para HMAC (Tokens). DEBE configurarse en variable de entorno 'POLLA_SECRET'
SECRET_KEY = os.getenv("POLLA_SECRET")
if not SECRET_KEY:
    SECRET_KEY = secrets.token_hex(32)
    logger.warning("POLLA_SECRET no configurada. Se generó una clave temporal. Los tokens NO sobrevivirán reinicios.")

_cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000,http://localhost:5500").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- MODELOS DE DATOS ---
class UsuarioRegistro(BaseModel):
    nombre: str = Field(..., min_length=3, max_length=30)
    correo: EmailStr
    password: str = Field(..., max_length=72)

class UsuarioLogin(BaseModel):
    correo: EmailStr
    password: str = Field(..., max_length=72)

class PerfilActualizar(BaseModel):
    correo: EmailStr
    nombre: Optional[str] = Field(None, min_length=3, max_length=30)
    avatar: str
    alertas: bool
    password_actual: Optional[str] = Field(None, max_length=72)
    password_nueva: Optional[str] = Field(None, max_length=72)

class CuentaEliminar(BaseModel):
    correo: EmailStr

class GrupoCrear(BaseModel):
    nombre: str = Field(..., min_length=3, max_length=30, pattern=r"^[a-zA-Z0-9 áéíóúÁÉÍÓÚñÑ_\-]+$")
    limite: int
    liga: str

class GrupoUnirse(BaseModel):
    codigo: str

class GrupoAccion(BaseModel):
    grupo_id: int

class PronosticoIndividual(BaseModel):
    id_partido: str
    goles_local: int = Field(..., ge=0)
    goles_visitante: int = Field(..., ge=0)

class GuardarPronosticosRequest(BaseModel):
    grupo_id: int
    pronosticos: List[PronosticoIndividual]

class ChatMensaje(BaseModel):
    grupo_id: int
    mensaje: str = Field(..., min_length=1, max_length=200)

@dataclass
class UserStats:
    nombre: str
    correo: str
    avatar: str
    puntos: int = 0
    mu: int = 0
    me: int = 0
    ga: int = 0
    gg: int = 0
    pe: int = 0

# --- BASE DE DATOS ---
def get_db():
    db_path = "/data/polla.db" if os.path.exists("/data") else "polla.db"
    conn = sqlite3.connect(db_path, timeout=10, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=10000")
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    db_gen = get_db()
    conn = next(db_gen)
    try:
        cursor = conn.cursor()
        # Esquema unificado para usuarios
        cursor.execute('''CREATE TABLE IF NOT EXISTS usuarios (
            correo TEXT PRIMARY KEY, 
            nombre TEXT NOT NULL, 
            password TEXT NOT NULL, 
            avatar TEXT DEFAULT "👤", 
            alertas INTEGER DEFAULT 1,
            token TEXT UNIQUE,
            token_expiry TEXT
        )''')

        cursor.execute('CREATE TABLE IF NOT EXISTS grupos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, codigo TEXT UNIQUE, correo_creador TEXT, liga TEXT, limite INTEGER DEFAULT 10)')
        cursor.execute('CREATE TABLE IF NOT EXISTS miembros_grupo (grupo_id INTEGER, correo_usuario TEXT, PRIMARY KEY(grupo_id, correo_usuario))')
        cursor.execute('CREATE TABLE IF NOT EXISTS pronosticos (grupo_id INTEGER, correo_usuario TEXT, id_partido TEXT, goles_local INTEGER, goles_visitante INTEGER, PRIMARY KEY(grupo_id, correo_usuario, id_partido))')
        cursor.execute('CREATE TABLE IF NOT EXISTS chat_mensajes (id INTEGER PRIMARY KEY AUTOINCREMENT, grupo_id INTEGER, correo_usuario TEXT, mensaje TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
        cursor.execute('CREATE TABLE IF NOT EXISTS puntos_historial (grupo_id INTEGER, correo_usuario TEXT, puntos INTEGER, fecha DATE DEFAULT (CURRENT_DATE), PRIMARY KEY(grupo_id, correo_usuario, fecha))')
        cursor.execute('CREATE TABLE IF NOT EXISTS logros (id INTEGER PRIMARY KEY AUTOINCREMENT, correo TEXT, badge_id TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(correo, badge_id))')
        
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_pronos_grupo_partido ON pronosticos(grupo_id, id_partido)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_miembros_correo ON miembros_grupo(correo_usuario)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_grupos_codigo ON grupos(codigo)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_chat_grupo ON chat_mensajes(grupo_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_puntos_historial ON puntos_historial(grupo_id, fecha)')
        conn.commit()
    finally:
        try: next(db_gen)
        except StopIteration: pass

init_db()

# --- UTILIDADES ---
LIGAS_ESPN = {
    "champions": "uefa.champions",
    "libertadores": "conmebol.libertadores",
    "betplay": "col.1",
    "premier": "eng.1",
    "laliga": "esp.1",
    "seriea": "ita.1",
    "bundesliga": "ger.1",
    "ligue1": "fra.1",
    "argentina": "arg.1",
    "brasileirao": "bra.1",
    "europa_league": "uefa.europa",
    "copa_america": "conmebol.america",
    "mundial": "fifa.world",
    "eliminatorias": "conmebol.worldqualifier",
}

BADGES = {
    "primer_pronostico": {"nombre": "Primer Gol", "emoji": "⚽", "descripcion": "Hiciste tu primer pronóstico"},
    "veterano": {"nombre": "Veterano", "emoji": "🎖️", "descripcion": "Más de 50 pronósticos realizados"},
    "social": {"nombre": "Socialite", "emoji": "💬", "descripcion": "Enviaste 50+ mensajes en el chat"},
    "explorador": {"nombre": "Explorador", "emoji": "🌍", "descripcion": "Te uniste a 3 o más grupos"},
    "perfeccionista": {"nombre": "Perfeccionista", "emoji": "🎯", "descripcion": "Acertaste un marcador exacto único (MU)"},
    "leyenda": {"nombre": "Leyenda", "emoji": "👑", "descripcion": "Alcanzaste 50+ puntos en un grupo"},
    "racha_3": {"nombre": "Hat-Trick", "emoji": "🔥", "descripcion": "3 aciertos de ganador consecutivos"},
    "madrugador": {"nombre": "Madrugador", "emoji": "⏰", "descripcion": "Pronosticaste todas las jornadas"},
}

def _otorgar(db, correo, badge_id):
    try: db.execute("INSERT INTO logros (correo, badge_id) VALUES (?,?)", (correo, badge_id))
    except sqlite3.IntegrityError: pass

def verificar_y_otorgar_logros(db, correo: str):
    """Verifica condiciones y otorga badges automáticamente."""
    try:
        # Primer pronóstico
        n_pronos = db.execute("SELECT COUNT(*) FROM pronosticos WHERE correo_usuario=?", (correo,)).fetchone()[0]
        if n_pronos >= 1: _otorgar(db, correo, "primer_pronostico")
        # Veterano (50+ pronósticos)
        if n_pronos >= 50: _otorgar(db, correo, "veterano")
        # Socialite (50+ mensajes)
        n_msgs = db.execute("SELECT COUNT(*) FROM chat_mensajes WHERE correo_usuario=?", (correo,)).fetchone()[0]
        if n_msgs >= 50: _otorgar(db, correo, "social")
        # Explorador (3+ grupos)
        n_grupos = db.execute("SELECT COUNT(*) FROM miembros_grupo WHERE correo_usuario=?", (correo,)).fetchone()[0]
        if n_grupos >= 3: _otorgar(db, correo, "explorador")
        # Leyenda (50+ puntos en algún grupo)
        best = db.execute("SELECT MAX(puntos) FROM puntos_historial WHERE correo_usuario=?", (correo,)).fetchone()
        if best and best[0] and best[0] >= 50: _otorgar(db, correo, "leyenda")
        # Perfeccionista (al menos 1 MU en algún registro histórico)
        # Se otorgará desde obtener_posiciones cuando se detecte mu > 0
        # Madrugador: pronosticó en cada jornada que tuvo partidos
        # Se otorgará desde obtener_posiciones comparando jornadas vs pronósticos
        db.commit()
    except Exception as e:
        logger.error(f"Error verificando logros para {correo}: {e}")

def obtener_url_espn(liga: str):
    hoy = datetime.now(timezone.utc)
    inicio = (hoy - timedelta(days=15)).strftime('%Y%m%d')
    fin = (hoy + timedelta(days=60)).strftime('%Y%m%d')
    torneo_espn = LIGAS_ESPN.get(liga, liga)
    return f"https://site.api.espn.com/apis/site/v2/sports/soccer/{torneo_espn}/scoreboard?dates={inicio}-{fin}"

pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")

TOKEN_CACHE = {}

def escape_html(text: str) -> str:
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;').replace("'", '&#039;')

def hash_token(token: str) -> str:
    return hmac.new(SECRET_KEY.encode(), token.encode(), hashlib.sha256).hexdigest()

def get_current_user(token: str = Header(None, alias="x-token"), db: sqlite3.Connection = Depends(get_db)):
    if not token:
        raise HTTPException(status_code=401, detail="No proporcionaste un token de sesión.")
        
    token_hash = hash_token(token)
    ahora = datetime.now(timezone.utc)
    
    # Caché rápida L1 (Token -> Correo, Expiry)
    if token_hash in TOKEN_CACHE:
        correo, expiry_str = TOKEN_CACHE[token_hash]
        try:
            if ahora < datetime.fromisoformat(expiry_str):
                return correo
        except: pass

    user = db.execute("SELECT correo, token_expiry FROM usuarios WHERE token = ?", (token_hash,)).fetchone()
    if not user:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada.")
    
    if user[1]:
        try:
            expiry = datetime.fromisoformat(user[1])
            if ahora > expiry:
                raise HTTPException(status_code=401, detail="Tu sesión ha expirado. Vuelve a iniciar sesión.")
        except: pass
        
    TOKEN_CACHE[token_hash] = (user[0], user[1])
    return user[0]

# --- RUTAS ---
@app.post("/api/auth/registro")
@limiter.limit("5/minute")
def registro(request: Request, u: UsuarioRegistro, db: sqlite3.Connection = Depends(get_db)):
    try:
        hashed_pwd = pwd_context.hash(u.password)
        db.execute("INSERT INTO usuarios (correo, nombre, password, avatar, alertas) VALUES (?, ?, ?, '👤', 1)", 
                   (u.correo, u.nombre, hashed_pwd))
        db.commit()
        return {"mensaje": "OK"}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="El correo ya está registrado")
    except Exception as e:
        logger.error(f"Error en registro: {e}")
        raise HTTPException(status_code=500, detail="Error interno del servidor")

@app.post("/api/auth/login")
@limiter.limit("5/minute")
def login(request: Request, u: UsuarioLogin, db: sqlite3.Connection = Depends(get_db)):
    user = db.execute("SELECT nombre, correo, avatar, alertas, password FROM usuarios WHERE correo=?", (u.correo,)).fetchone()
    valid_password = False
    if user:
        try: 
            valid_password = pwd_context.verify(u.password, user[4])
        except Exception:
            if u.password == user[4]:
                valid_password = True
                new_hash = pwd_context.hash(u.password)
                db.execute("UPDATE usuarios SET password=? WHERE correo=?", (new_hash, u.correo))
                db.commit()

    if user and valid_password:
        nuevo_token = secrets.token_hex(16)
        token_expiry = (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat()
        hash_tok = hash_token(nuevo_token)
        db.execute("UPDATE usuarios SET token=?, token_expiry=? WHERE correo=?", (hash_tok, token_expiry, u.correo))
        db.commit()
        TOKEN_CACHE[hash_tok] = (u.correo, token_expiry)
        return {"nombre": user[0], "correo": user[1], "avatar": user[2], "alertas": bool(user[3]), "token": nuevo_token}
    raise HTTPException(status_code=401, detail="Credenciales incorrectas")

@app.post("/api/perfil/actualizar")
def actualizar_perfil(req: PerfilActualizar, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    if req.correo != user_req:
        raise HTTPException(status_code=403, detail="No tienes permiso para modificar este perfil.")
    try:
        cur = db.cursor()
        if req.password_actual and req.password_nueva:
            user = cur.execute("SELECT password FROM usuarios WHERE correo=?", (user_req,)).fetchone()
            valid_password = False
            if user:
                try: valid_password = pwd_context.verify(req.password_actual, user[0])
                except Exception: valid_password = (req.password_actual == user[0])
            if not valid_password:
                raise HTTPException(status_code=400, detail="La contraseña actual es incorrecta")
            hashed_nueva = pwd_context.hash(req.password_nueva)
            if req.nombre: cur.execute("UPDATE usuarios SET nombre=?, avatar=?, alertas=?, password=? WHERE correo=?", (req.nombre, req.avatar, int(req.alertas), hashed_nueva, user_req))
            else: cur.execute("UPDATE usuarios SET avatar=?, alertas=?, password=? WHERE correo=?", (req.avatar, int(req.alertas), hashed_nueva, user_req))
        else:
            if req.nombre: cur.execute("UPDATE usuarios SET nombre=?, avatar=?, alertas=? WHERE correo=?", (req.nombre, req.avatar, int(req.alertas), user_req))
            else: cur.execute("UPDATE usuarios SET avatar=?, alertas=? WHERE correo=?", (req.avatar, int(req.alertas), user_req))
        db.commit()
    except HTTPException: raise
    except Exception as e:
        logger.error(f"Error actualizando perfil: {e}")
        raise HTTPException(status_code=500, detail="Error interno al actualizar perfil")
    
    # Invalida caché al actualizar
    if user_req in USER_CACHE: del USER_CACHE[user_req]
    return {"mensaje": "Perfil actualizado con éxito"}

@app.get("/api/perfil/{correo}")
def get_perfil(correo: str, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    # Seguridad: siempre retorna el perfil del usuario autenticado
    now = time.time()
    if user_req in USER_CACHE:
        data, ts = USER_CACHE[user_req]
        if now - ts < USER_CACHE_TTL:
            return data

    user = db.execute("SELECT nombre, correo, avatar, alertas FROM usuarios WHERE correo=?", (user_req,)).fetchone()
    if user:
        res = {"nombre": user[0], "correo": user[1], "avatar": user[2], "alertas": bool(user[3])}
        USER_CACHE[user_req] = (res, now)
        return res
    raise HTTPException(status_code=404, detail="Usuario no encontrado")

@app.post("/api/perfil/eliminar")
def eliminar_cuenta(req: CuentaEliminar, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    if req.correo != user_req:
        raise HTTPException(status_code=403, detail="No tienes permiso para eliminar esta cuenta.")
    try:
        cur = db.cursor()
        grupos_creados = cur.execute("SELECT id FROM grupos WHERE correo_creador=?", (user_req,)).fetchall()
        ids_grupos = [str(g[0]) for g in grupos_creados]
        if ids_grupos:
            placeholders = ','.join('?' for _ in ids_grupos)
            cur.execute(f"DELETE FROM grupos WHERE id IN ({placeholders})", ids_grupos)
            cur.execute(f"DELETE FROM miembros_grupo WHERE grupo_id IN ({placeholders})", ids_grupos)
            cur.execute(f"DELETE FROM pronosticos WHERE grupo_id IN ({placeholders})", ids_grupos)
            cur.execute(f"DELETE FROM chat_mensajes WHERE grupo_id IN ({placeholders})", ids_grupos)
            cur.execute(f"DELETE FROM puntos_historial WHERE grupo_id IN ({placeholders})", ids_grupos)
        cur.execute("DELETE FROM usuarios WHERE correo=?", (user_req,))
        cur.execute("DELETE FROM miembros_grupo WHERE correo_usuario=?", (user_req,))
        cur.execute("DELETE FROM pronosticos WHERE correo_usuario=?", (user_req,))
        cur.execute("DELETE FROM chat_mensajes WHERE correo_usuario=?", (user_req,))
        cur.execute("DELETE FROM puntos_historial WHERE correo_usuario=?", (user_req,))
        cur.execute("DELETE FROM logros WHERE correo=?", (user_req,))
        db.commit()
    except Exception as e:
        logger.error(f"Error eliminando cuenta: {e}")
        raise HTTPException(status_code=500, detail="Error interno al eliminar cuenta")
    return {"mensaje": "Cuenta y datos eliminados correctamente"}

@app.post("/api/grupos/crear")
def crear_grupo(g: GrupoCrear, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    try:
        cur = db.cursor()
        count = cur.execute("SELECT COUNT(*) FROM miembros_grupo WHERE correo_usuario=?", (user_req,)).fetchone()[0]
        if count >= 5: raise HTTPException(status_code=400, detail="Has alcanzado el límite máximo de 5 grupos por usuario.")
        while True:
            cod = ''.join(random.choices(string.ascii_uppercase + string.digits, k=5))
            try:
                cur.execute("INSERT INTO grupos (nombre, codigo, limite, correo_creador, liga) VALUES (?,?,?,?,?)", 
                            (g.nombre, cod, g.limite, user_req, g.liga))
                gid = cur.lastrowid
                break
            except sqlite3.IntegrityError: continue
        cur.execute("INSERT INTO miembros_grupo VALUES (?,?)", (gid, user_req))
        db.commit()
        return {"codigo": cod, "id": gid}
    except HTTPException: raise
    except Exception as e:
        logger.error(f"Error creando grupo: {e}"); raise HTTPException(status_code=500, detail="Error interno al crear grupo")

@app.post("/api/grupos/unirse")
def unirse(d: GrupoUnirse, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    cur = db.cursor()
    count = cur.execute("SELECT COUNT(*) FROM miembros_grupo WHERE correo_usuario=?", (user_req,)).fetchone()[0]
    if count >= 5: raise HTTPException(status_code=400, detail="Has alcanzado el límite máximo de 5 grupos por usuario.")
    logger.info(f"Intento unirse a grupo: {d.codigo.upper()} por {user_req}")
    grupo = cur.execute("SELECT id, limite FROM grupos WHERE codigo=?", (d.codigo.upper(),)).fetchone()
    if not grupo: 
        logger.warning(f"Código {d.codigo.upper()} no existe en DB")
        raise HTTPException(status_code=404, detail=f"Código de grupo '{d.codigo}' no encontrado")
    grupo_id, limite = grupo[0], grupo[1]
    miembros_actuales = cur.execute("SELECT COUNT(*) FROM miembros_grupo WHERE grupo_id=?", (grupo_id,)).fetchone()[0]
    logger.debug(f"Grupo {grupo_id}: {miembros_actuales}/{limite} miembros")
    if miembros_actuales >= limite: raise HTTPException(status_code=400, detail="Este grupo ya está lleno.")
    try:
        cur.execute("INSERT INTO miembros_grupo VALUES (?,?)", (grupo_id, user_req))
        db.commit()
        logger.info(f"Usuario {user_req} unido a grupo {grupo_id}")
        return {"mensaje": "OK"}
    except Exception as e: 
        logger.error(f"Error SQL al unirse: {e}")
        raise HTTPException(status_code=400, detail="Ya eres miembro de este grupo o error interno")

@app.post("/api/grupos/salir")
def salir_grupo(req: GrupoAccion, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    cur = db.cursor()
    grupo = cur.execute("SELECT correo_creador FROM grupos WHERE id=?", (req.grupo_id,)).fetchone()
    if grupo and grupo[0] == user_req: raise HTTPException(status_code=400, detail="El creador no puede salir del grupo.")
    cur.execute("DELETE FROM miembros_grupo WHERE grupo_id=? AND correo_usuario=?", (req.grupo_id, user_req))
    cur.execute("DELETE FROM pronosticos WHERE grupo_id=? AND correo_usuario=?", (req.grupo_id, user_req))
    db.commit()
    return {"mensaje": "Has salido del grupo"}

@app.post("/api/grupos/eliminar")
def eliminar_grupo(req: GrupoAccion, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    cur = db.cursor()
    grupo = cur.execute("SELECT correo_creador FROM grupos WHERE id=?", (req.grupo_id,)).fetchone()
    if not grupo or grupo[0] != user_req: raise HTTPException(status_code=403, detail="Solo el creador puede eliminar el grupo")
    cur.execute("DELETE FROM grupos WHERE id=?", (req.grupo_id,))
    cur.execute("DELETE FROM miembros_grupo WHERE grupo_id=?", (req.grupo_id,))
    cur.execute("DELETE FROM pronosticos WHERE grupo_id=?", (req.grupo_id,))
    cur.execute("DELETE FROM chat_mensajes WHERE grupo_id=?", (req.grupo_id,))
    cur.execute("DELETE FROM puntos_historial WHERE grupo_id=?", (req.grupo_id,))
    db.commit()
    return {"mensaje": "Grupo eliminado"}

@app.get("/api/grupos/mis-grupos")
def mis_grupos(db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    db.row_factory = sqlite3.Row
    res = db.execute("SELECT g.* FROM grupos g JOIN miembros_grupo mg ON g.id=mg.grupo_id WHERE mg.correo_usuario=?", (user_req,)).fetchall()
    return {"grupos": [dict(r) for r in res]}

@app.post("/api/chat/enviar")
@limiter.limit("20/minute")
async def enviar_mensaje(request: Request, m: ChatMensaje, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    es_miembro = db.execute("SELECT 1 FROM miembros_grupo WHERE grupo_id=? AND correo_usuario=?", (m.grupo_id, user_req)).fetchone()
    if not es_miembro: raise HTTPException(status_code=403, detail="No eres miembro de este grupo.")
    
    cur = db.cursor()
    # Sanitización de HTML/XSS pre-inserción
    mensaje_seguro = escape_html(m.mensaje)
    cur.execute("INSERT INTO chat_mensajes (grupo_id, correo_usuario, mensaje) VALUES (?,?,?)", (m.grupo_id, user_req, mensaje_seguro))
    msg_id = cur.lastrowid
    db.commit()
    verificar_y_otorgar_logros(db, user_req)

    db.row_factory = sqlite3.Row
    res = db.execute("SELECT c.*, u.nombre, u.avatar FROM chat_mensajes c JOIN usuarios u ON c.correo_usuario = u.correo WHERE c.id = ?", (msg_id,)).fetchone()
    if res:
        mensaje_enviar = dict(res)
        await ws_manager.broadcast({"tipo": "chat", "mensaje": mensaje_enviar}, m.grupo_id)

    return {"mensaje": "Enviado"}

@app.get("/api/chat/{grupo_id}")
def obtener_chat(grupo_id: int, since: Optional[str] = None, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    es_miembro = db.execute("SELECT 1 FROM miembros_grupo WHERE grupo_id=? AND correo_usuario=?", (grupo_id, user_req)).fetchone()
    if not es_miembro: raise HTTPException(status_code=403, detail="No eres miembro de este grupo.")
    db.row_factory = sqlite3.Row
    if since:
        res = db.execute("""SELECT c.*, u.nombre, u.avatar FROM chat_mensajes c JOIN usuarios u ON c.correo_usuario = u.correo WHERE c.grupo_id = ? AND c.fecha > ? ORDER BY c.fecha ASC""", (grupo_id, since)).fetchall()
        return {"mensajes": [dict(r) for r in res]}
    else:
        res = db.execute("""SELECT c.*, u.nombre, u.avatar FROM chat_mensajes c JOIN usuarios u ON c.correo_usuario = u.correo WHERE c.grupo_id = ? ORDER BY c.fecha DESC LIMIT 50""", (grupo_id,)).fetchall()
        mensajes = [dict(r) for r in res]
        mensajes.reverse()
        return {"mensajes": mensajes}

@app.websocket("/api/ws/chat/{grupo_id}")
async def websocket_chat_endpoint(websocket: WebSocket, grupo_id: int, token: Optional[str] = None):
    await websocket.accept()
    db_gen = get_db()
    db = next(db_gen)
    try:
        # Soporta token por query param (legacy) o como primer mensaje (más seguro)
        auth_token = token
        if not auth_token:
            try:
                first_msg = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
                if first_msg.startswith("auth:"):
                    auth_token = first_msg[5:]
            except Exception:
                pass
        if not auth_token:
            await websocket.close(code=1008)
            return

        token_hash = hash_token(auth_token)
        user = db.execute("SELECT correo, token_expiry FROM usuarios WHERE token = ?", (token_hash,)).fetchone()
        if not user:
            await websocket.close(code=1008)
            return
        
        correo_usuario = user[0]
        # Registrar liga como activa
        es_miembro = db.execute("SELECT 1 FROM miembros_grupo WHERE grupo_id=? AND correo_usuario=?", (grupo_id, correo_usuario)).fetchone()
        if not es_miembro:
            await websocket.close(code=1008); return

        liga_res = db.execute("SELECT liga FROM grupos WHERE id=?", (grupo_id,)).fetchone()
        if liga_res: ACTIVE_LEAGUES.add(liga_res[0])

        if grupo_id not in ws_manager.active_connections:
            ws_manager.active_connections[grupo_id] = []
        ws_manager.active_connections[grupo_id].append(websocket)
        await websocket.send_text("authenticated")

        while True:
            data = await websocket.receive_text()
            if data == "ping": await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket, grupo_id)
    except Exception:
        ws_manager.disconnect(websocket, grupo_id)
    finally:
        try: next(db_gen)
        except StopIteration: pass

# --- BACKGROUND SYNC LOOP ---
async def sync_loop():
    """Tarea en segundo plano que actualiza ligas activas cada 60s o según sea necesario."""
    logger.info("Iniciando Sync Loop para ligas activas...")
    while True:
        try:
            leagues_to_sync = list(ACTIVE_LEAGUES)
            if not leagues_to_sync:
                await asyncio.sleep(60)
                continue
            
            for liga in leagues_to_sync:
                url = obtener_url_espn(liga)
                cache_key = f"partidos_{liga}"
                
                # Obtener datos anteriores para comparar (Detección de goles)
                old_data = None
                if cache_key in espn_cache:
                    old_data, _ = espn_cache[cache_key]
                
                new_data = await get_espn_data(url, cache_key, ttl=10) # Refresco más rápido si hay actividad
                
                if new_data and old_data:
                    # Comparar eventos en vivo
                    for ev in new_data.get('events', []):
                        if ev.get('status', {}).get('type', {}).get('state') == 'in':
                            old_ev = next((x for x in old_data.get('events', []) if x.get('id') == ev.get('id')), None)
                            if old_ev:
                                score_new = [c.get('score') for c in ev.get('competitions', [{}])[0].get('competitors', [])]
                                score_old = [c.get('score') for c in old_ev.get('competitions', [{}])[0].get('competitors', [])]
                                if score_new != score_old:
                                    logger.info(f"¡GOL DETECTADO en liga {liga}! Notificando...")
                                    # Notificar a todos los grupos de esta liga
                                    # Nota: En una app real, mapearíamos liga -> grupo_ids para eficiencia
                                    # Por ahora, enviamos a todos los grupos activos que coincidan en liga
                                    # Para esto necesitamos saber la liga de cada grupo con conexiones activas
                                    for gid in list(ws_manager.active_connections.keys()):
                                        # Esto es un poco ineficiente (DB hit), pero solo ocurre en GOL
                                        db_gen = get_db()
                                        db = next(db_gen)
                                        ginfo = db.execute("SELECT liga FROM grupos WHERE id=?", (gid,)).fetchone()
                                        if ginfo and ginfo[0] == liga:
                                            # Limpiar cache de posiciones para este grupo
                                            if f"pos_{gid}" in posiciones_cache: del posiciones_cache[f"pos_{gid}"]
                                            await ws_manager.broadcast({"tipo": "goal", "liga": liga, "partido_id": ev.get('id')}, gid)
            
            await asyncio.sleep(60)
        except Exception as e:
            logger.error(f"Error en sync_loop: {e}")
            await asyncio.sleep(60)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(sync_loop())

@app.get("/api/utils/server-time")
def get_server_time():
    return {"iso": datetime.now(timezone.utc).isoformat()}

@app.get("/api/partidos/{liga}")
async def obtener_partidos(liga: str):
    url_dinamica = obtener_url_espn(liga)
    cache_key = f"partidos_{liga}"
    
    datos = await get_espn_data(url_dinamica, cache_key)
    if not datos:
        return {"estado": "error", "mensaje": "No se pudo conectar con ESPN"}
    
    try:
        procesados = []
        events = datos.get('events', [])
        for ev in events:
            if not isinstance(ev, dict): continue
            st_name = ev.get('status', {}).get('type', {}).get('name', '').upper()
            if any(x in st_name for x in ['POSTPONED', 'CANCELED', 'DELAYED']): continue
            comp_list = ev.get('competitions', [])
            if not comp_list: continue
            comp = comp_list[0]
            competitors = comp.get('competitors', [])
            if len(competitors) < 2: continue
            eq1, eq2 = competitors[0], competitors[1]
            n1, n2 = eq1.get('team', {}).get('name', ''), eq2.get('team', {}).get('name', '')
            details = comp.get('details', [{}])
            ultimo_evento = details[0].get('text', '') if details else ''
            if not any(x in (n1+n2) for x in ["TBD", "Winner", "Loser", "TBC", "Determined"]):
                p_f = calcular_probabilidades_y_forma(n1, n2)
                procesados.append({
                    "id_partido": str(ev.get('id', '')), "fecha": ev.get('date', ''), "estado": ev.get('status', {}).get('type', {}).get('state', ''),
                    "nombre_fase": ev.get('status', {}).get('type', {}).get('description', ''), "reloj": ev.get('status', {}).get('displayClock', ''),
                    "ultimo_evento": ultimo_evento, "local": n1, "local_logo": eq1.get('team', {}).get('logo', ''),
                    "goles_l": eq1.get('score', '0'), "visitante": n2, "visitante_logo": eq2.get('team', {}).get('logo', ''),
                    "goles_v": eq2.get('score', '0'),
                    "prob_l": p_f["prob_l"], "prob_e": p_f["prob_e"], "prob_v": p_f["prob_v"],
                    "forma_l": p_f["forma_l"], "forma_v": p_f["forma_v"]
                })
        resultado = {"estado": "exito", "server_time": datetime.now(timezone.utc).isoformat(), "partidos": procesados}
        return resultado
    except Exception as e:
        logger.error(f"Error procesando partidos de {liga}: {e}")
        return {"estado": "error"}

@app.get("/api/partidos/detalle/{evento_id}")
async def obtener_detalle_partido(evento_id: str):
    cache_key = f"detalle_{evento_id}"
    if cache_key in espn_cache:
        cached_data, timestamp = espn_cache[cache_key]
        if time.time() - timestamp < CACHE_TTL:
            return cached_data

    async with httpx.AsyncClient() as client:
        try:
            url = f"https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event={evento_id}"
            r = await client.get(url, timeout=10.0)
            resultado = r.json()
            espn_cache[cache_key] = (resultado, time.time())
            _evict_cache()
            return resultado
        except Exception: raise HTTPException(status_code=502, detail="Error al conectar con el proveedor de datos")

@app.post("/api/pronosticos/guardar")
async def guardar(req: GuardarPronosticosRequest, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    # Verificar que el usuario es miembro del grupo
    es_miembro = db.execute("SELECT 1 FROM miembros_grupo WHERE grupo_id=? AND correo_usuario=?", (req.grupo_id, user_req)).fetchone()
    if not es_miembro:
        raise HTTPException(status_code=403, detail="No eres miembro de este grupo.")
    db.row_factory = sqlite3.Row
    try:
        g = db.execute("SELECT liga FROM grupos WHERE id=?", (req.grupo_id,)).fetchone()
        if not g: raise HTTPException(status_code=404, detail="Grupo no encontrado")
        liga = dict(g).get('liga', 'champions')
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                r = await client.get(obtener_url_espn(liga))
                if r.status_code == 200:
                    partidos_map = {str(ev['id']): ev for ev in r.json().get('events', [])}
                    ahora = datetime.now(timezone.utc)
                    for p in req.pronosticos:
                        if str(p.id_partido) in partidos_map:
                            fecha_str = partidos_map[str(p.id_partido)].get('date')
                            if fecha_str:
                                fecha_partido = datetime.fromisoformat(fecha_str.replace('Z', '+00:00'))
                                if ahora >= fecha_partido: raise HTTPException(status_code=400, detail="Partido ya iniciado.")
                else: raise HTTPException(status_code=503, detail="Error de validación temporal.")
        except HTTPException: raise
        except Exception: raise HTTPException(status_code=503, detail="No se pudo validar la hora.")
        # 3. Guardar pronósticos en LOTE (Batching)
        batch_data = [
            (req.grupo_id, user_req, p.id_partido, p.goles_local, p.goles_visitante)
            for p in req.pronosticos
        ]
        db.executemany('''INSERT INTO pronosticos (grupo_id, correo_usuario, id_partido, goles_local, goles_visitante)
                            VALUES (?,?,?,?,?) ON CONFLICT(grupo_id, correo_usuario, id_partido) 
                            DO UPDATE SET goles_local=excluded.goles_local, goles_visitante=excluded.goles_visitante''',
                         batch_data)
        db.commit()
        verificar_y_otorgar_logros(db, user_req)
        return {"mensaje": "Pronósticos guardados"}
    except HTTPException: raise
    except Exception: raise HTTPException(status_code=500, detail="Error al guardar")

@app.get("/api/pronosticos/{grupo_id}/{correo}")
def get_pronosticos(grupo_id: int, correo: str, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    es_miembro = db.execute("SELECT 1 FROM miembros_grupo WHERE grupo_id=? AND correo_usuario=?", (grupo_id, user_req)).fetchone()
    if not es_miembro: raise HTTPException(status_code=403, detail="No eres miembro de este grupo.")
    db.row_factory = sqlite3.Row
    res = db.execute("SELECT id_partido, goles_local, goles_visitante FROM pronosticos WHERE grupo_id=? AND correo_usuario=?", (grupo_id, correo)).fetchall()
    return {"pronosticos": [dict(r) for r in res]}

@app.get("/api/pronosticos/distribucion/{grupo_id}/{id_partido}")
def get_pronosticos_distribucion(grupo_id: int, id_partido: str, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    try:
        db.row_factory = sqlite3.Row
        res = db.execute("SELECT goles_local, goles_visitante FROM pronosticos WHERE grupo_id=? AND id_partido=?", (grupo_id, id_partido)).fetchall()
        frecuencias: Dict[str, int] = {}
        for r in res:
            marc = f"{r['goles_local']} - {r['goles_visitante']}"
            frecuencias[marc] = frecuencias.get(marc, 0) + 1
        if not frecuencias: return {"estado": "exito", "distribucion": []}
        max_frec = max(frecuencias.values())
        dist = [{"marcador": m, "porcentaje": int((c/max_frec)*100)} for m, c in sorted(frecuencias.items(), key=lambda x: (-x[1], x[0]))]
        return {"estado": "exito", "distribucion": dist}
    except Exception: raise HTTPException(status_code=500, detail="Error en estadísticas")

@app.get("/api/posiciones/{grupo_id}")
async def obtener_posiciones(grupo_id: int, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    now = time.time()
    cache_key = f"pos_{grupo_id}"
    if cache_key in posiciones_cache:
        resultado, ts = posiciones_cache[cache_key]
        if now - ts < POS_CACHE_TTL:
            return resultado

    db.row_factory = sqlite3.Row
    grupo_info = db.execute("SELECT liga FROM grupos WHERE id=?", (grupo_id,)).fetchone()
    liga = str(dict(grupo_info).get('liga', 'champions')) if grupo_info else 'champions'
    
    # 1. Obtener datos de ESPN (Centralizado)
    url_espn = obtener_url_espn(liga)
    espn_data = await get_espn_data(url_espn, f"partidos_{liga}")
    
    reales: Dict[str, Tuple[int, int]] = {}
    if espn_data:
        events = espn_data.get('events', [])
        for ev in events:
            if not isinstance(ev, dict): continue
            st = ev.get('status', {}).get('type', {}).get('state', '')
            if st in ['in', 'post']:
                comp = ev.get('competitions', [{}])[0]
                c_comp = comp.get('competitors', [])
                if len(c_comp) >= 2:
                    reales[str(ev.get('id', ''))] = (int(c_comp[0].get('score', 0)), int(c_comp[1].get('score', 0)))
    
    # 2. Consultas a DB (Optimizables en Fase 2)
    miembros_res = db.execute("SELECT nombre, correo, avatar FROM usuarios u JOIN miembros_grupo mg ON u.correo = mg.correo_usuario WHERE mg.grupo_id=?", (grupo_id,)).fetchall()
    miembros = [dict(r) for r in miembros_res]
    
    pronos_res = db.execute("SELECT correo_usuario, id_partido, goles_local, goles_visitante FROM pronosticos WHERE grupo_id=?", (grupo_id,)).fetchall()
    pronos_db = [dict(r) for r in pronos_res]
    
    mapa_pronos: Dict[str, Dict[str, Tuple[int, int]]] = {}
    for p in pronos_db: 
        c_u, id_p = str(p['correo_usuario']), str(p['id_partido'])
        mapa_pronos.setdefault(c_u, {})[id_p] = (int(p['goles_local']), int(p['goles_visitante']))
    
    frec_marcador: Dict[str, Dict[Tuple[int, int], int]] = {}
    for p in pronos_db: 
        idp, marc = str(p['id_partido']), (int(p['goles_local']), int(p['goles_visitante']))
        frec_marcador.setdefault(idp, {})[marc] = frec_marcador.get(idp, {}).get(marc, 0) + 1
        
    # 3. Procesamiento
    tabla: List[UserStats] = []
    for m in miembros:
        m_correo = str(m['correo'])
        u_stats = UserStats(nombre=str(m['nombre']), correo=m_correo, avatar=str(m.get('avatar', '👤')))
        user_pronos = mapa_pronos.get(m_correo, {})
        for idp, (rl, rv) in reales.items():
            if idp in user_pronos:
                pl, pv = user_pronos[idp]
                if pl == rl and pv == rv:
                    if frec_marcador.get(idp, {}).get((pl, pv), 0) == 1:
                        u_stats.mu += 1; u_stats.puntos += 10
                    else: u_stats.me += 1; u_stats.puntos += 5
                else:
                    win_p = 1 if pl > pv else (-1 if pl < pv else 0)
                    win_r = 1 if rl > rv else (-1 if rl < rv else 0)
                    if win_p == win_r: u_stats.ga += 1; u_stats.puntos += 3
                    elif pl == rl or pv == rv: u_stats.gg += 1; u_stats.puntos += 1
                    else: u_stats.pe += 1
            else: u_stats.pe += 1
        tabla.append(u_stats)
    
    tabla.sort(key=lambda x: (x.puntos, x.mu, x.me), reverse=True)
    tabla_dicts = [{"nombre": t.nombre, "correo": t.correo, "avatar": t.avatar, "puntos": t.puntos, "mu": t.mu, "me": t.me, "ga": t.ga, "gg": t.gg, "pe": t.pe} for t in tabla]
    
    # 4. Actualizar DB (Batching) y Caché
    batch_puntos = [(grupo_id, t.correo, t.puntos) for t in tabla]
    db.executemany("INSERT OR REPLACE INTO puntos_historial (grupo_id, correo_usuario, puntos) VALUES (?,?,?)", batch_puntos)
    
    for t in tabla: 
        if t.puntos >= 50: _otorgar(db, t.correo, "leyenda")
        if t.mu > 0: _otorgar(db, t.correo, "perfeccionista")
    db.commit()

    resultado = {"posiciones": tabla_dicts}
    posiciones_cache[cache_key] = (resultado, now)
    return resultado

@app.get("/api/posiciones/historial/{grupo_id}")
def obtener_historial_puntos(grupo_id: int, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    res = db.execute("""SELECT correo_usuario, puntos, fecha FROM puntos_historial WHERE grupo_id = ? ORDER BY fecha ASC""", (grupo_id,)).fetchall()
    historial: Dict[str, List[Dict[str, Any]]] = {}
    for r in res:
        c_u = str(r[0])
        if c_u not in historial: historial[c_u] = []
        historial[c_u].append({"puntos": r[1], "fecha": r[2]})
    return {"historial": historial}

# --- ESTADÍSTICAS PERSONALES ---
@app.get("/api/stats/personal")
def stats_personal(db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    try:
        db.row_factory = sqlite3.Row
        # Total de pronósticos
        n_pronos = db.execute("SELECT COUNT(*) as c FROM pronosticos WHERE correo_usuario=?", (user_req,)).fetchone()['c']
        # Total de grupos
        n_grupos = db.execute("SELECT COUNT(*) as c FROM miembros_grupo WHERE correo_usuario=?", (user_req,)).fetchone()['c']
        # Total de mensajes
        n_msgs = db.execute("SELECT COUNT(*) as c FROM chat_mensajes WHERE correo_usuario=?", (user_req,)).fetchone()['c']
        # Puntos totales (suma del último registro de cada grupo)
        grupos_ids = db.execute("SELECT grupo_id FROM miembros_grupo WHERE correo_usuario=?", (user_req,)).fetchall()
        puntos_totales = 0
        mejor_grupo = None
        mejor_puntos = 0
        for g in grupos_ids:
            gid = g['grupo_id']
            hist = db.execute("SELECT puntos FROM puntos_historial WHERE grupo_id=? AND correo_usuario=? ORDER BY fecha DESC LIMIT 1", (gid, user_req)).fetchone()
            if hist:
                pts = hist['puntos']
                puntos_totales += pts
                if pts > mejor_puntos:
                    mejor_puntos = pts
                    gi = db.execute("SELECT nombre FROM grupos WHERE id=?", (gid,)).fetchone()
                    mejor_grupo = gi['nombre'] if gi else None
        # Logros
        logros_raw = db.execute("SELECT badge_id, fecha FROM logros WHERE correo=? ORDER BY fecha DESC", (user_req,)).fetchall()
        logros = []
        for l in logros_raw:
            bid = l['badge_id']
            if bid in BADGES:
                logros.append({**BADGES[bid], "badge_id": bid, "fecha": l['fecha']})
        return {
            "puntos_totales": puntos_totales,
            "grupos": n_grupos,
            "pronosticos": n_pronos,
            "mensajes": n_msgs,
            "mejor_grupo": mejor_grupo,
            "mejor_puntos": mejor_puntos,
            "logros": logros
        }
    except Exception as e:
        logger.error(f"Error stats personal: {e}")
        raise HTTPException(status_code=500, detail="Error al obtener estadísticas")

@app.get("/api/logros/{correo}")
def get_logros(correo: str, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    # Solo puedes ver tus propios logros o los de alguien en tu mismo grupo
    if correo != user_req:
        shared = db.execute("""SELECT 1 FROM miembros_grupo a JOIN miembros_grupo b ON a.grupo_id = b.grupo_id WHERE a.correo_usuario=? AND b.correo_usuario=? LIMIT 1""", (user_req, correo)).fetchone()
        if not shared: raise HTTPException(status_code=403, detail="No tienes permiso para ver estos logros.")
    db.row_factory = sqlite3.Row
    logros_raw = db.execute("SELECT badge_id, fecha FROM logros WHERE correo=? ORDER BY fecha DESC", (correo,)).fetchall()
    logros = []
    for l in logros_raw:
        bid = l['badge_id']
        if bid in BADGES:
            logros.append({**BADGES[bid], "badge_id": bid, "fecha": l['fecha']})
    all_badges = [{**v, "badge_id": k, "obtenido": any(l['badge_id'] == k for l in logros_raw)} for k, v in BADGES.items()]
    return {"logros": logros, "todos": all_badges}

@app.get("/api/ligas")
def get_ligas():
    return {"ligas": [{"id": k, "nombre": k.replace('_', ' ').title()} for k in LIGAS_ESPN.keys()]}

if os.path.exists("js"): app.mount("/js", StaticFiles(directory="js"), name="js")
@app.get('/manifest.json')
def get_manifest(): return FileResponse('manifest.json')
@app.get('/sw.js')
def get_sw(): return FileResponse('sw.js', media_type='application/javascript')
@app.get('/')
def leer_index(): return FileResponse("index.html")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
