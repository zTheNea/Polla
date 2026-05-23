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
from dataclasses import dataclass
import firebase_admin
from firebase_admin import credentials, firestore

import random
import string
import secrets
import hashlib
import hmac
import jwt
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

    async def connect(self, websocket: WebSocket, grupo_id: str, liga: str):
        await websocket.accept()
        if grupo_id not in self.active_connections:
            self.active_connections[grupo_id] = {"sockets": [], "liga": liga}
        self.active_connections[grupo_id]["sockets"].append(websocket)

    def disconnect(self, websocket: WebSocket, grupo_id: str):
        if grupo_id in self.active_connections:
            if websocket in self.active_connections[grupo_id]["sockets"]:
                self.active_connections[grupo_id]["sockets"].remove(websocket)
            if not self.active_connections[grupo_id]["sockets"]:
                del self.active_connections[grupo_id]

    async def broadcast(self, message: dict, grupo_id: str):
        if grupo_id in self.active_connections:
            dead = []
            for connection in self.active_connections[grupo_id]["sockets"]:
                try:
                    await connection.send_json(message)
                except Exception:
                    dead.append(connection)
            for d in dead:
                self.active_connections[grupo_id]["sockets"].remove(d)

ws_manager = ConnectionManager()

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Clave secreta para HMAC (Tokens). DEBE configurarse en variable de entorno 'POLLA_SECRET'
SECRET_KEY = os.getenv("POLLA_SECRET")
if not SECRET_KEY:
    try:
        if not firebase_admin._apps: firebase_admin.initialize_app()
        db_cfg = firestore.client().collection('system').document('config').get()
        if db_cfg.exists and 'jwt_secret' in db_cfg.to_dict():
            SECRET_KEY = db_cfg.to_dict()['jwt_secret']
        else:
            SECRET_KEY = secrets.token_hex(32)
            firestore.client().collection('system').document('config').set({'jwt_secret': SECRET_KEY})
            logger.info("POLLA_SECRET generada y persistida en Firestore.")
    except Exception as e:
        SECRET_KEY = secrets.token_hex(32)

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
    nombre: str = Field(..., min_length=3, max_length=20)
    correo: EmailStr
    password: str = Field(..., max_length=72)

class UsuarioLogin(BaseModel):
    correo: EmailStr
    password: str = Field(..., max_length=72)

class PerfilActualizar(BaseModel):
    correo: EmailStr
    nombre: Optional[str] = Field(None, min_length=3, max_length=20)
    avatar: Optional[str] = None
    alertas: Optional[bool] = None
    password_actual: Optional[str] = Field(None, max_length=72)
    password_nueva: Optional[str] = Field(None, max_length=72)

class CuentaEliminar(BaseModel):
    correo: EmailStr

class GrupoCrear(BaseModel):
    nombre: str = Field(..., min_length=3, max_length=20, pattern=r"^[a-zA-Z0-9 áéíóúÁÉÍÓÚñÑ_\-]+$")
    limite: int
    liga: str

class GrupoUnirse(BaseModel):
    codigo: str

class GrupoAccion(BaseModel):
    grupo_id: str

class PronosticoIndividual(BaseModel):
    id_partido: str
    goles_local: int = Field(..., ge=0)
    goles_visitante: int = Field(..., ge=0)

class GuardarPronosticosRequest(BaseModel):
    grupo_id: str
    pronosticos: List[PronosticoIndividual]

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

# --- BASE DE DATOS (Firestore) ---
if not firebase_admin._apps:
    # Usar las credenciales por defecto de Google Cloud / Firebase (Cloud Run las inyecta automáticamente)
    firebase_admin.initialize_app()

def get_db():
    yield firestore.client()

def init_db():
    # Firestore no necesita inicializar tablas. Las colecciones se crean dinámicamente.
    pass

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
    "eliminatorias": "fifa.worldq.conmebol",
}

BADGES = {
    "primer_pronostico": {"nombre": "Primer Gol", "emoji": "⚽", "descripcion": "Hiciste tu primer pronóstico"},
    "veterano": {"nombre": "Veterano", "emoji": "🎖️", "descripcion": "Más de 50 pronósticos realizados"},
    "explorador": {"nombre": "Explorador", "emoji": "🌍", "descripcion": "Te uniste a 3 o más grupos"},
    "perfeccionista": {"nombre": "Perfeccionista", "emoji": "🎯", "descripcion": "Acertaste un marcador exacto único (MU)"},
    "leyenda": {"nombre": "Leyenda", "emoji": "👑", "descripcion": "Alcanzaste 50+ puntos en un grupo"},
    "racha_3": {"nombre": "Hat-Trick", "emoji": "🔥", "descripcion": "3 aciertos de ganador consecutivos"},
    "madrugador": {"nombre": "Madrugador", "emoji": "⏰", "descripcion": "Pronosticaste todas las jornadas"},
}

def _otorgar(db, correo, badge_id):
    try: 
        logro_ref = db.collection('logros').document(f"{correo}_{badge_id}")
        if not logro_ref.get().exists:
            logro_ref.set({'correo': correo, 'badge_id': badge_id, 'fecha': datetime.now(timezone.utc).isoformat()})
    except Exception: pass

def verificar_y_otorgar_logros(db, correo: str):
    """Verifica condiciones y otorga badges automáticamente."""
    try:
        n_pronos = db.collection('pronosticos').where('correo_usuario', '==', correo).count().get()[0][0].value
        if n_pronos >= 1: _otorgar(db, correo, "primer_pronostico")
        if n_pronos >= 50: _otorgar(db, correo, "veterano")
        
        n_grupos = db.collection('grupos').where('miembros', 'array_contains', correo).count().get()[0][0].value
        if n_grupos >= 3: _otorgar(db, correo, "explorador")
        
        best = db.collection('puntos_historial').where('correo_usuario', '==', correo).order_by('puntos', direction=firestore.Query.DESCENDING).limit(1).get()
        if best and best[0].to_dict().get('puntos', 0) >= 50: 
            _otorgar(db, correo, "leyenda")
    except Exception as e:
        logger.error(f"Error verificando logros para {correo}: {e}")

def obtener_url_espn(liga: str):
    hoy = datetime.now(timezone.utc)
    inicio = (hoy - timedelta(days=15)).strftime('%Y%m%d')
    fin = (hoy + timedelta(days=60)).strftime('%Y%m%d')
    torneo_espn = LIGAS_ESPN.get(liga, liga)
    return f"https://site.api.espn.com/apis/site/v2/sports/soccer/{torneo_espn}/scoreboard?dates={inicio}-{fin}"

pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")

def escape_html(text: str) -> str:
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;').replace("'", '&#039;')

def get_current_user(authorization: str = Header(None, alias="Authorization"), token_legacy: str = Header(None, alias="x-token"), db = Depends(get_db)):
    token = authorization or token_legacy
    if not token:
        raise HTTPException(status_code=401, detail="No proporcionaste un token de sesión.")
    
    if token.startswith("Bearer "):
        token = token.split(" ")[1]

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        correo: str = payload.get("sub")
        if correo is None:
            raise HTTPException(status_code=401, detail="Token inválido")
        return correo
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Tu sesión ha expirado. Vuelve a iniciar sesión.")
    except Exception:
        raise HTTPException(status_code=401, detail="Sesión inválida.")

# --- RUTAS ---
@app.post("/api/auth/registro")
@limiter.limit("5/minute")
def registro(request: Request, u: UsuarioRegistro, db = Depends(get_db)):
    user_ref = db.collection('usuarios').document(u.correo)
    if user_ref.get().exists:
        raise HTTPException(status_code=400, detail="El correo ya está registrado")
    try:
        hashed_pwd = pwd_context.hash(u.password)
        user_ref.set({
            'nombre': u.nombre,
            'password': hashed_pwd,
            'avatar': '👤',
            'alertas': 1
        })
        return {"mensaje": "OK"}
    except Exception as e:
        logger.error(f"Error en registro: {e}")
        raise HTTPException(status_code=500, detail="Error interno del servidor")

@app.post("/api/auth/login")
@limiter.limit("5/minute")
def login(request: Request, u: UsuarioLogin, db = Depends(get_db)):
    user_ref = db.collection('usuarios').document(u.correo)
    user_doc = user_ref.get()
    
    if not user_doc.exists:
        raise HTTPException(status_code=401, detail="Credenciales incorrectas")
        
    user_data = user_doc.to_dict()
    valid_password = False
    try: 
        valid_password = pwd_context.verify(u.password, user_data.get('password'))
    except Exception:
        if u.password == user_data.get('password'):
            valid_password = True
            new_hash = pwd_context.hash(u.password)
            user_ref.update({'password': new_hash})

    if valid_password:
        expire = datetime.now(timezone.utc) + timedelta(hours=48)
        to_encode = {"sub": u.correo, "exp": expire}
        nuevo_token = jwt.encode(to_encode, SECRET_KEY, algorithm="HS256")
        
        return {
            "nombre": user_data.get('nombre'), 
            "correo": u.correo, 
            "avatar": user_data.get('avatar', '👤'), 
            "alertas": bool(user_data.get('alertas', 1)), 
            "token": nuevo_token
        }
    raise HTTPException(status_code=401, detail="Credenciales incorrectas")

@app.post("/api/perfil/actualizar")
def actualizar_perfil(req: PerfilActualizar, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    if req.correo != user_req:
        raise HTTPException(status_code=403, detail="No tienes permiso para modificar este perfil.")
    try:
        user_ref = db.collection('usuarios').document(user_req)
        user_doc = user_ref.get()
        if not user_doc.exists:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")
            
        user_data = user_doc.to_dict()
        updates = {}
        
        if req.password_actual and req.password_nueva:
            valid_password = False
            try: valid_password = pwd_context.verify(req.password_actual, user_data.get('password'))
            except Exception: valid_password = (req.password_actual == user_data.get('password'))
            if not valid_password:
                raise HTTPException(status_code=400, detail="La contraseña actual es incorrecta")
            updates['password'] = pwd_context.hash(req.password_nueva)
            
        if req.nombre is not None: updates['nombre'] = req.nombre
        if req.avatar is not None: updates['avatar'] = req.avatar
        if req.alertas is not None: updates['alertas'] = int(req.alertas)
        
        if updates:
            user_ref.update(updates)
            
    except HTTPException: raise
    except Exception as e:
        logger.error(f"Error actualizando perfil: {e}")
        raise HTTPException(status_code=500, detail="Error interno al actualizar perfil")
    
    if user_req in USER_CACHE: del USER_CACHE[user_req]
    return {"mensaje": "Perfil actualizado con éxito"}

@app.get("/api/perfil/{correo}")
def get_perfil(correo: str, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    now = time.time()
    if user_req in USER_CACHE:
        data, ts = USER_CACHE[user_req]
        if now - ts < USER_CACHE_TTL:
            return data

    user_doc = db.collection('usuarios').document(user_req).get()
    if user_doc.exists:
        user_data = user_doc.to_dict()
        res = {
            "nombre": user_data.get('nombre'), 
            "correo": user_req, 
            "avatar": user_data.get('avatar', '👤'), 
            "alertas": bool(user_data.get('alertas', 1))
        }
        USER_CACHE[user_req] = (res, now)
        return res
    raise HTTPException(status_code=404, detail="Usuario no encontrado")

@app.post("/api/perfil/eliminar")
def eliminar_cuenta(req: CuentaEliminar, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    if req.correo != user_req:
        raise HTTPException(status_code=403, detail="No tienes permiso para eliminar esta cuenta.")
    try:
        grupos_ref = db.collection('grupos')
        grupos_query = grupos_ref.where('miembros', 'array_contains', user_req).stream()
        for g_doc in grupos_query:
            g_ref = g_doc.reference
            g_data = g_doc.to_dict()
            if g_data.get('correo_creador') == user_req:
                g_ref.delete()
            else:
                g_ref.update({'miembros': firestore.ArrayRemove([user_req])})
                
        pronos = db.collection('pronosticos').where('correo_usuario', '==', user_req).stream()
        for p in pronos: p.reference.delete()
        

        historial = db.collection('puntos_historial').where('correo_usuario', '==', user_req).stream()
        for h in historial: h.reference.delete()
        
        logros = db.collection('logros').where('correo', '==', user_req).stream()
        for l in logros: l.reference.delete()
        
        db.collection('usuarios').document(user_req).delete()
        
    except Exception as e:
        logger.error(f"Error eliminando cuenta: {e}")
        raise HTTPException(status_code=500, detail="Error interno al eliminar cuenta")
    return {"mensaje": "Cuenta y datos eliminados correctamente"}

@app.post("/api/grupos/crear")
def crear_grupo(g: GrupoCrear, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    try:
        count = db.collection('grupos').where('miembros', 'array_contains', user_req).count().get()[0][0].value
        if count >= 5: raise HTTPException(status_code=400, detail="Has alcanzado el límite máximo de 5 grupos por usuario.")
        while True:
            cod = ''.join(random.choices(string.ascii_uppercase + string.digits, k=5))
            existing = db.collection('grupos').where('codigo', '==', cod).limit(1).count().get()[0][0].value
            if existing == 0:
                break
                
        doc_ref = db.collection('grupos').document()
        doc_ref.set({
            'nombre': g.nombre,
            'codigo': cod,
            'limite': g.limite,
            'correo_creador': user_req,
            'liga': g.liga,
            'miembros': [user_req]
        })
        return {"codigo": cod, "id": doc_ref.id}
    except HTTPException: raise
    except Exception as e:
        logger.error(f"Error creando grupo: {e}"); raise HTTPException(status_code=500, detail="Error interno al crear grupo")

@app.post("/api/grupos/unirse")
def unirse(d: GrupoUnirse, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    count = db.collection('grupos').where('miembros', 'array_contains', user_req).count().get()[0][0].value
    if count >= 5: raise HTTPException(status_code=400, detail="Has alcanzado el límite máximo de 5 grupos por usuario.")
    
    grupo_query = db.collection('grupos').where('codigo', '==', d.codigo.upper()).limit(1).stream()
    grupo_doc = None
    for doc in grupo_query:
        grupo_doc = doc
        break
        
    if not grupo_doc: 
        raise HTTPException(status_code=404, detail=f"Código de grupo '{d.codigo}' no encontrado")
        
    g_data = grupo_doc.to_dict()
    if user_req in g_data.get('miembros', []):
        raise HTTPException(status_code=400, detail="Ya eres miembro de este grupo")
        
    if len(g_data.get('miembros', [])) >= g_data.get('limite', 10): 
        raise HTTPException(status_code=400, detail="Este grupo ya está lleno.")
        
    try:
        grupo_doc.reference.update({'miembros': firestore.ArrayUnion([user_req])})
        return {"mensaje": "OK"}
    except Exception as e: 
        logger.error(f"Error al unirse: {e}")
        raise HTTPException(status_code=400, detail="Error interno al unirse")

@app.post("/api/grupos/salir")
def salir_grupo(req: GrupoAccion, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    g_ref = db.collection('grupos').document(str(req.grupo_id))
    g_doc = g_ref.get()
    if g_doc.exists:
        if g_doc.to_dict().get('correo_creador') == user_req: 
            raise HTTPException(status_code=400, detail="El creador no puede salir del grupo.")
        g_ref.update({'miembros': firestore.ArrayRemove([user_req])})
        
    pronos = db.collection('pronosticos').where('grupo_id', '==', str(req.grupo_id)).where('correo_usuario', '==', user_req).stream()
    for p in pronos: p.reference.delete()
    return {"mensaje": "Has salido del grupo"}

@app.post("/api/grupos/eliminar")
def eliminar_grupo(req: GrupoAccion, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    g_ref = db.collection('grupos').document(str(req.grupo_id))
    g_doc = g_ref.get()
    if not g_doc.exists or g_doc.to_dict().get('correo_creador') != user_req: 
        raise HTTPException(status_code=403, detail="Solo el creador puede eliminar el grupo")
        
    g_ref.delete()
    
    gid_str = str(req.grupo_id)
    pronos = db.collection('pronosticos').where('grupo_id', '==', gid_str).stream()
    for p in pronos: p.reference.delete()

    
    puntos = db.collection('puntos_historial').where('grupo_id', '==', gid_str).stream()
    for p in puntos: p.reference.delete()
    
    return {"mensaje": "Grupo eliminado"}

@app.get("/api/grupos/mis-grupos")
def mis_grupos(db = Depends(get_db), user_req: str = Depends(get_current_user)):
    grupos_query = db.collection('grupos').where('miembros', 'array_contains', user_req).stream()
    grupos = []
    for g in grupos_query:
        gd = g.to_dict()
        gd['id'] = g.id
        grupos.append(gd)
    return {"grupos": grupos}


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
                                    for gid, gdata in list(ws_manager.active_connections.items()):
                                        if gdata.get('liga') == liga:
                                            if f"pos_{gid}" in posiciones_cache: del posiciones_cache[f"pos_{gid}"]
                                            await ws_manager.broadcast({"tipo": "goal", "liga": liga, "partido_id": ev.get('id')}, gid)
            
            await asyncio.sleep(60)
        except Exception as e:
            logger.error(f"Error en sync_loop: {e}")
            await asyncio.sleep(60)

# --- LIGAS ACTIVAS Y SUS FECHAS ---
ligas_fechas_cache = {}

async def sync_league_dates():
    """Descarga de forma asincrónica las fechas de inicio y fin oficiales para cada liga."""
    logger.info("Iniciando sync_league_dates...")
    while True:
        try:
            for liga_key, liga_espn in LIGAS_ESPN.items():
                url = f"https://site.api.espn.com/apis/site/v2/sports/soccer/{liga_espn}/scoreboard"
                try:
                    async with httpx.AsyncClient() as client:
                        r = await client.get(url, timeout=10.0)
                        if r.status_code == 200:
                            data = r.json()
                            leagues = data.get("leagues", [])
                            if leagues:
                                season = leagues[0].get("season", {})
                                start_date = season.get("startDate", "")
                                end_date = season.get("endDate", "")
                                if start_date and end_date:
                                    # Convert to YYYY-MM-DD
                                    ligas_fechas_cache[liga_key] = {
                                        "fecha_inicio": start_date.split("T")[0],
                                        "fecha_fin": end_date.split("T")[0]
                                    }
                except Exception as e:
                    logger.debug(f"Error fetching dates for {liga_key}: {e}")
                # Esperar un poco entre ligas para no saturar
                await asyncio.sleep(2)
        except Exception as e:
            logger.error(f"Error en sync_league_dates loop: {e}")
        # Refrescar cada 24 horas
        await asyncio.sleep(86400)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(sync_loop())
    asyncio.create_task(sync_league_dates())

@app.get("/api/ligas/info")
def get_ligas_info():
    return {"estado": "exito", "ligas": ligas_fechas_cache}

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
async def guardar(req: GuardarPronosticosRequest, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    grupo_doc = db.collection('grupos').document(req.grupo_id).get()
    if not grupo_doc.exists:
        raise HTTPException(status_code=404, detail="Grupo no encontrado")
        
    g_data = grupo_doc.to_dict()
    if user_req not in g_data.get('miembros', []):
        raise HTTPException(status_code=403, detail="No eres miembro de este grupo.")
        
    try:
        liga = g_data.get('liga', 'champions')
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
        
        batch = db.batch()
        for p in req.pronosticos:
            p_ref = db.collection('pronosticos').document(f"{req.grupo_id}_{user_req}_{p.id_partido}")
            batch.set(p_ref, {
                'grupo_id': req.grupo_id,
                'correo_usuario': user_req,
                'id_partido': p.id_partido,
                'goles_local': p.goles_local,
                'goles_visitante': p.goles_visitante
            })
        batch.commit()
        verificar_y_otorgar_logros(db, user_req)
        return {"mensaje": "Pronósticos guardados"}
    except HTTPException: raise
    except Exception as e:
        logger.error(f"Error al guardar pronósticos: {e}")
        raise HTTPException(status_code=500, detail="Error al guardar")

@app.get("/api/pronosticos/{grupo_id}/{correo}")
def get_pronosticos(grupo_id: str, correo: str, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    grupo_doc = db.collection('grupos').document(grupo_id).get()
    if not grupo_doc.exists or user_req not in grupo_doc.to_dict().get('miembros', []):
        raise HTTPException(status_code=403, detail="No eres miembro de este grupo.")
        
    pronos_query = db.collection('pronosticos').where('grupo_id', '==', grupo_id).where('correo_usuario', '==', correo).stream()
    pronosticos = []
    for p in pronos_query:
        pd = p.to_dict()
        pronosticos.append({
            'id_partido': pd.get('id_partido'),
            'goles_local': pd.get('goles_local'),
            'goles_visitante': pd.get('goles_visitante')
        })
    return {"pronosticos": pronosticos}

@app.get("/api/pronosticos/distribucion/{grupo_id}/{id_partido}")
def get_pronosticos_distribucion(grupo_id: str, id_partido: str, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    try:
        pronos_query = db.collection('pronosticos').where('grupo_id', '==', grupo_id).where('id_partido', '==', id_partido).stream()
        frecuencias: Dict[str, int] = {}
        for p in pronos_query:
            pd = p.to_dict()
            marc = f"{pd.get('goles_local')} - {pd.get('goles_visitante')}"
            frecuencias[marc] = frecuencias.get(marc, 0) + 1
            
        if not frecuencias: return {"estado": "exito", "distribucion": []}
        max_frec = max(frecuencias.values())
        dist = [{"marcador": m, "porcentaje": int((c/max_frec)*100)} for m, c in sorted(frecuencias.items(), key=lambda x: (-x[1], x[0]))]
        return {"estado": "exito", "distribucion": dist}
    except Exception as e:
        logger.error(f"Error en estadísticas: {e}")
        raise HTTPException(status_code=500, detail="Error en estadísticas")

@app.get("/api/posiciones/{grupo_id}")
async def obtener_posiciones(grupo_id: str, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    now = time.time()
    cache_key = f"pos_{grupo_id}"
    if cache_key in posiciones_cache:
        resultado, ts = posiciones_cache[cache_key]
        if now - ts < POS_CACHE_TTL:
            return resultado

    grupo_doc = db.collection('grupos').document(grupo_id).get()
    if not grupo_doc.exists:
        raise HTTPException(status_code=404, detail="Grupo no encontrado")
        
    g_data = grupo_doc.to_dict()
    liga = str(g_data.get('liga', 'champions'))
    miembros_correos = g_data.get('miembros', [])
    
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
    
    miembros = []
    for m_correo in miembros_correos:
        u_doc = db.collection('usuarios').document(m_correo).get()
        if u_doc.exists:
            u_data = u_doc.to_dict()
            miembros.append({
                'nombre': u_data.get('nombre', 'Usuario'),
                'correo': m_correo,
                'avatar': u_data.get('avatar', '👤')
            })
            
    pronos_query = db.collection('pronosticos').where('grupo_id', '==', grupo_id).stream()
    pronos_db = [p.to_dict() for p in pronos_query]
    
    mapa_pronos: Dict[str, Dict[str, Tuple[int, int]]] = {}
    for p in pronos_db: 
        c_u, id_p = str(p.get('correo_usuario')), str(p.get('id_partido'))
        mapa_pronos.setdefault(c_u, {})[id_p] = (int(p.get('goles_local',0)), int(p.get('goles_visitante',0)))
    
    frec_marcador: Dict[str, Dict[Tuple[int, int], int]] = {}
    for p in pronos_db: 
        idp, marc = str(p.get('id_partido')), (int(p.get('goles_local',0)), int(p.get('goles_visitante',0)))
        frec_marcador.setdefault(idp, {})[marc] = frec_marcador.get(idp, {}).get(marc, 0) + 1
        
    tabla: List[UserStats] = []
    for m in miembros:
        m_correo = str(m['correo'])
        u_stats = UserStats(nombre=str(m['nombre']), correo=m_correo, avatar=str(m['avatar']))
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
    
    from datetime import date as _date_type
    hoy_str = _date_type.today().isoformat()
    
    hist_query = db.collection('puntos_historial').where('grupo_id', '==', grupo_id).stream()
    hist_docs = [h.to_dict() for h in hist_query]
    
    fechas_anteriores = [h.get('fecha', '') for h in hist_docs if h.get('fecha', '') < hoy_str]
    fecha_anterior = max(fechas_anteriores) if fechas_anteriores else None
        
    pos_anterior_map = {}
    if fecha_anterior:
        prev_puntos = [h for h in hist_docs if h.get('fecha', '') == fecha_anterior]
        prev_sorted = sorted(prev_puntos, key=lambda r: r.get('puntos', 0), reverse=True)
        for idx, r in enumerate(prev_sorted):
            pos_anterior_map[str(r.get('correo_usuario'))] = idx + 1
            
    tabla_dicts = []
    for idx, t in enumerate(tabla):
        pos_actual = idx + 1
        pos_prev = pos_anterior_map.get(t.correo, None)
        cambio = (pos_prev - pos_actual) if pos_prev is not None else None
        tabla_dicts.append({
            "nombre": t.nombre, "correo": t.correo, "avatar": t.avatar,
            "puntos": t.puntos, "mu": t.mu, "me": t.me, "ga": t.ga, "gg": t.gg, "pe": t.pe,
            "cambio": cambio
        })
    
    batch_puntos = db.batch()
    for t in tabla:
        h_ref = db.collection('puntos_historial').document(f"{grupo_id}_{t.correo}_{hoy_str}")
        batch_puntos.set(h_ref, {
            'grupo_id': grupo_id,
            'correo_usuario': t.correo,
            'puntos': t.puntos,
            'fecha': hoy_str
        })
        if t.puntos >= 50: _otorgar(db, t.correo, "leyenda")
        if t.mu > 0: _otorgar(db, t.correo, "perfeccionista")
    batch_puntos.commit()

    resultado = {"posiciones": tabla_dicts}
    posiciones_cache[cache_key] = (resultado, now)
    return resultado

@app.get("/api/posiciones/historial/{grupo_id}")
def obtener_historial_puntos(grupo_id: str, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    hist_query = db.collection('puntos_historial').where('grupo_id', '==', grupo_id).stream()
    hist_docs = [h.to_dict() for h in hist_query]
    hist_docs.sort(key=lambda x: x.get('fecha', ''))
    
    historial: Dict[str, List[Dict[str, Any]]] = {}
    for rd in hist_docs:
        c_u = str(rd.get('correo_usuario'))
        if c_u not in historial: historial[c_u] = []
        historial[c_u].append({"puntos": rd.get('puntos', 0), "fecha": rd.get('fecha')})
    return {"historial": historial}

@app.get("/api/stats/personal")
def stats_personal(db = Depends(get_db), user_req: str = Depends(get_current_user)):
    try:
        n_pronos = db.collection('pronosticos').where('correo_usuario', '==', user_req).count().get()[0][0].value
        grupos_ids = [g.id for g in db.collection('grupos').where('miembros', 'array_contains', user_req).stream()]
        n_grupos = len(grupos_ids)
        
        puntos_totales = 0
        mejor_grupo = None
        mejor_puntos = 0
        
        for gid in grupos_ids:
            hist_query = db.collection('puntos_historial').where('grupo_id', '==', gid).where('correo_usuario', '==', user_req).stream()
            hist_docs = [h.to_dict() for h in hist_query]
            if hist_docs:
                latest = max(hist_docs, key=lambda x: x.get('fecha', ''))
                pts = latest.get('puntos', 0)
                puntos_totales += pts
                if pts > mejor_puntos:
                    mejor_puntos = pts
                    gi = db.collection('grupos').document(gid).get()
                    mejor_grupo = gi.to_dict().get('nombre') if gi.exists else None
                
        logros_query = db.collection('logros').where('correo', '==', user_req).stream()
        logros_docs = [l.to_dict() for l in logros_query]
        logros_docs.sort(key=lambda x: x.get('fecha', ''), reverse=True)
        
        logros = []
        for ld in logros_docs:
            bid = ld.get('badge_id')
            if bid in BADGES:
                logros.append({**BADGES[bid], "badge_id": bid, "fecha": ld.get('fecha')})
                
        return {
            "puntos_totales": puntos_totales,
            "grupos": n_grupos,
            "pronosticos": n_pronos,
            "mensajes": 0,
            "mejor_grupo": mejor_grupo,
            "mejor_puntos": mejor_puntos,
            "logros": logros
        }
    except Exception as e:
        logger.error(f"Error stats personal: {e}")
        raise HTTPException(status_code=500, detail="Error al obtener estadísticas")

@app.get("/api/logros/{correo}")
def get_logros(correo: str, db = Depends(get_db), user_req: str = Depends(get_current_user)):
    if correo != user_req:
        grupos_user = {g.id for g in db.collection('grupos').where('miembros', 'array_contains', user_req).stream()}
        grupos_target = {g.id for g in db.collection('grupos').where('miembros', 'array_contains', correo).stream()}
        if not grupos_user.intersection(grupos_target):
            raise HTTPException(status_code=403, detail="No tienes permiso para ver estos logros.")
            
    logros_query = db.collection('logros').where('correo', '==', correo).stream()
    logros_raw = [l.to_dict() for l in logros_query]
    logros_raw.sort(key=lambda x: x.get('fecha', ''), reverse=True)
    
    logros = []
    for l in logros_raw:
        bid = l.get('badge_id')
        if bid in BADGES:
            logros.append({**BADGES[bid], "badge_id": bid, "fecha": l.get('fecha')})
            
    all_badges = [{**v, "badge_id": k, "obtenido": any(l.get('badge_id') == k for l in logros_raw)} for k, v in BADGES.items()]
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
