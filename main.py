from fastapi import FastAPI, HTTPException, Depends, Header # type: ignore
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

app = FastAPI()

# Clave secreta para HMAC (Tokens). Se recomienda configurar en variable de entorno 'POLLA_SECRET'
SECRET_KEY = os.getenv("POLLA_SECRET", "SUPER_SECRET_POLLA_2024_DEFAULT_REPLACE_ME")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:5500",
        "https://silklike-groomishly-marybeth.ngrok-free.dev"
    ],
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
    correo_creador: EmailStr
    liga: str

class GrupoUnirse(BaseModel):
    codigo: str
    correo_usuario: EmailStr

class GrupoAccion(BaseModel):
    grupo_id: int
    correo_usuario: EmailStr

class PronosticoIndividual(BaseModel):
    id_partido: str
    goles_local: int = Field(..., ge=0)
    goles_visitante: int = Field(..., ge=0)

class GuardarPronosticosRequest(BaseModel):
    grupo_id: int
    correo_usuario: EmailStr
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
    # En Render usamos el disco persistente en /data, localmente usamos la raíz
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
        cursor.execute('CREATE TABLE IF NOT EXISTS usuarios (correo TEXT PRIMARY KEY, nombre TEXT NOT NULL, password TEXT NOT NULL, avatar TEXT DEFAULT "👤", alertas INTEGER DEFAULT 1)')
        try: cursor.execute("ALTER TABLE usuarios ADD COLUMN avatar TEXT DEFAULT '👤'")
        except sqlite3.OperationalError: pass
        try: cursor.execute("ALTER TABLE usuarios ADD COLUMN alertas INTEGER DEFAULT 1")
        except sqlite3.OperationalError: pass
        try: cursor.execute("ALTER TABLE usuarios ADD COLUMN token TEXT UNIQUE")
        except sqlite3.OperationalError: pass

        cursor.execute('CREATE TABLE IF NOT EXISTS grupos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, codigo TEXT UNIQUE, correo_creador TEXT, liga TEXT, limite INTEGER DEFAULT 10)')
        cursor.execute('CREATE TABLE IF NOT EXISTS miembros_grupo (grupo_id INTEGER, correo_usuario TEXT, PRIMARY KEY(grupo_id, correo_usuario))')
        cursor.execute('CREATE TABLE IF NOT EXISTS pronosticos (grupo_id INTEGER, correo_usuario TEXT, id_partido TEXT, goles_local INTEGER, goles_visitante INTEGER, PRIMARY KEY(grupo_id, correo_usuario, id_partido))')
        cursor.execute('CREATE TABLE IF NOT EXISTS chat_mensajes (id INTEGER PRIMARY KEY AUTOINCREMENT, grupo_id INTEGER, correo_usuario TEXT, mensaje TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
        cursor.execute('CREATE TABLE IF NOT EXISTS puntos_historial (grupo_id INTEGER, correo_usuario TEXT, puntos INTEGER, fecha DATE DEFAULT (CURRENT_DATE), PRIMARY KEY(grupo_id, correo_usuario, fecha))')
        
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
def obtener_url_espn(liga: str):
    hoy = datetime.now(timezone.utc)
    inicio = (hoy - timedelta(days=15)).strftime('%Y%m%d')
    fin = (hoy + timedelta(days=60)).strftime('%Y%m%d')
    if liga == "champions": torneo_espn = "uefa.champions"
    elif liga == "libertadores": torneo_espn = "conmebol.libertadores"
    elif liga == "betplay": torneo_espn = "col.1"
    else: torneo_espn = liga
    return f"https://site.api.espn.com/apis/site/v2/sports/soccer/{torneo_espn}/scoreboard?dates={inicio}-{fin}"

pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")

def hash_token(token: str) -> str:
    return hmac.new(SECRET_KEY.encode(), token.encode(), hashlib.sha256).hexdigest()

def get_current_user(token: str = Header(None, alias="x-token"), db: sqlite3.Connection = Depends(get_db)):
    if not token:
        raise HTTPException(status_code=401, detail="No proporcionaste un token de sesión.")
    token_hash = hash_token(token)
    user = db.execute("SELECT correo FROM usuarios WHERE token = ?", (token_hash,)).fetchone()
    if not user:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada.")
    return user[0]

# --- RUTAS ---
@app.post("/api/auth/registro")
def registro(u: UsuarioRegistro, db: sqlite3.Connection = Depends(get_db)):
    try:
        nuevo_token = secrets.token_hex(16)
        hashed_pwd = pwd_context.hash(u.password)
        db.execute("INSERT INTO usuarios (correo, nombre, password, avatar, alertas, token) VALUES (?, ?, ?, '\U0001f464', 1, ?)", 
                   (u.correo, u.nombre, hashed_pwd, hash_token(nuevo_token)))
        db.commit()
        return {"mensaje": "OK"}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="El correo ya está registrado")
    except Exception as e:
        print(f"Error en registro: {e}")
        raise HTTPException(status_code=500, detail="Error interno del servidor")

@app.post("/api/auth/login")
def login(u: UsuarioLogin, db: sqlite3.Connection = Depends(get_db)):
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
        db.execute("UPDATE usuarios SET token=? WHERE correo=?", (hash_token(nuevo_token), u.correo))
        db.commit()
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
        print(f"Error actualizando perfil: {e}")
        raise HTTPException(status_code=500, detail="Error interno al actualizar perfil")
    return {"mensaje": "Perfil actualizado con éxito"}

@app.get("/api/perfil/{correo}")
def get_perfil(correo: str, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    user = db.execute("SELECT nombre, correo, avatar, alertas FROM usuarios WHERE correo=?", (user_req,)).fetchone()
    if user: return {"nombre": user[0], "correo": user[1], "avatar": user[2], "alertas": bool(user[3])}
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
        cur.execute("DELETE FROM usuarios WHERE correo=?", (user_req,))
        cur.execute("DELETE FROM miembros_grupo WHERE correo_usuario=?", (user_req,))
        cur.execute("DELETE FROM pronosticos WHERE correo_usuario=?", (user_req,))
        db.commit()
    except Exception as e:
        print(f"Error eliminando cuenta: {e}")
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
        print(f"Error creando grupo: {e}"); raise HTTPException(status_code=500, detail="Error interno al crear grupo")

@app.post("/api/grupos/unirse")
def unirse(d: GrupoUnirse, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    cur = db.cursor()
    count = cur.execute("SELECT COUNT(*) FROM miembros_grupo WHERE correo_usuario=?", (user_req,)).fetchone()[0]
    if count >= 5: raise HTTPException(status_code=400, detail="Has alcanzado el límite máximo de 5 grupos por usuario.")
    grupo = cur.execute("SELECT id, limite FROM grupos WHERE codigo=?", (d.codigo,)).fetchone()
    if not grupo: raise HTTPException(status_code=404, detail="Código de grupo no encontrado")
    grupo_id, limite = grupo[0], grupo[1]
    miembros_actuales = cur.execute("SELECT COUNT(*) FROM miembros_grupo WHERE grupo_id=?", (grupo_id,)).fetchone()[0]
    if miembros_actuales >= limite: raise HTTPException(status_code=400, detail="Este grupo ya está lleno.")
    try:
        cur.execute("INSERT INTO miembros_grupo VALUES (?,?)", (grupo_id, user_req))
        db.commit()
        return {"mensaje": "OK"}
    except Exception: raise HTTPException(status_code=400, detail="Ya eres miembro de este grupo")

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
    db.commit()
    return {"mensaje": "Grupo eliminado"}

@app.get("/api/grupos/mis-grupos")
def mis_grupos(db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    db.row_factory = sqlite3.Row
    res = db.execute("SELECT g.* FROM grupos g JOIN miembros_grupo mg ON g.id=mg.grupo_id WHERE mg.correo_usuario=?", (user_req,)).fetchall()
    return {"grupos": [dict(r) for r in res]}

@app.post("/api/chat/enviar")
def enviar_mensaje(m: ChatMensaje, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    es_miembro = db.execute("SELECT 1 FROM miembros_grupo WHERE grupo_id=? AND correo_usuario=?", (m.grupo_id, user_req)).fetchone()
    if not es_miembro: raise HTTPException(status_code=403, detail="No eres miembro de este grupo.")
    db.execute("INSERT INTO chat_mensajes (grupo_id, correo_usuario, mensaje) VALUES (?,?,?)", (m.grupo_id, user_req, m.mensaje))
    db.commit()
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

@app.get("/api/utils/server-time")
def get_server_time():
    return {"iso": datetime.now(timezone.utc).isoformat()}

@app.get("/api/partidos/{liga}")
async def obtener_partidos(liga: str):
    url_dinamica = obtener_url_espn(liga)
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(url_dinamica, timeout=8.0)
            datos = r.json()
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
                    procesados.append({
                        "id_partido": str(ev.get('id', '')), "fecha": ev.get('date', ''), "estado": ev.get('status', {}).get('type', {}).get('state', ''),
                        "nombre_fase": ev.get('status', {}).get('type', {}).get('description', ''), "reloj": ev.get('status', {}).get('displayClock', ''),
                        "ultimo_evento": ultimo_evento, "local": n1, "local_logo": eq1.get('team', {}).get('logo', ''),
                        "goles_l": eq1.get('score', '0'), "visitante": n2, "visitante_logo": eq2.get('team', {}).get('logo', ''),
                        "goles_v": eq2.get('score', '0')
                    })
            return {"estado": "exito", "partidos": procesados}
        except Exception: return {"estado": "error"}

@app.get("/api/partidos/detalle/{evento_id}")
async def obtener_detalle_partido(evento_id: str):
    async with httpx.AsyncClient() as client:
        try:
            url = f"https://site.api.espn.com/apis/site/v2/sports/soccer/all/summary?event={evento_id}"
            r = await client.get(url, timeout=10.0)
            return r.json()
        except Exception: raise HTTPException(status_code=502, detail="Error al conectar con el proveedor de datos")

@app.post("/api/pronosticos/guardar")
def guardar(req: GuardarPronosticosRequest, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    db.row_factory = sqlite3.Row
    try:
        g = db.execute("SELECT liga FROM grupos WHERE id=?", (req.grupo_id,)).fetchone()
        if not g: raise HTTPException(status_code=404, detail="Grupo no encontrado")
        liga = dict(g).get('liga', 'champions')
        try:
            with httpx.Client(timeout=5.0) as client:
                r = client.get(obtener_url_espn(liga))
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
        except Exception: raise HTTPException(status_code=503, detail="No se pudo validar la hora.")
        for p in req.pronosticos:
            db.execute('''INSERT INTO pronosticos (grupo_id, correo_usuario, id_partido, goles_local, goles_visitante)
                            VALUES (?,?,?,?,?) ON CONFLICT(grupo_id, correo_usuario, id_partido) 
                            DO UPDATE SET goles_local=excluded.goles_local, goles_visitante=excluded.goles_visitante''',
                         (req.grupo_id, user_req, p.id_partido, p.goles_local, p.goles_visitante))
        db.commit()
        return {"mensaje": "Pronósticos guardados"}
    except Exception: raise HTTPException(status_code=500, detail="Error al guardar")

@app.get("/api/pronosticos/{grupo_id}/{correo}")
def get_pronosticos(grupo_id: int, correo: str, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
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
    db.row_factory = sqlite3.Row
    grupo_info = db.execute("SELECT liga FROM grupos WHERE id=?", (grupo_id,)).fetchone()
    liga = str(dict(grupo_info).get('liga', 'champions')) if grupo_info else 'champions'
    
    miembros_res = db.execute("SELECT nombre, correo, avatar FROM usuarios u JOIN miembros_grupo mg ON u.correo = mg.correo_usuario WHERE mg.grupo_id=?", (grupo_id,)).fetchall()
    miembros = [dict(r) for r in miembros_res]
    
    pronos_res = db.execute("SELECT correo_usuario, id_partido, goles_local, goles_visitante FROM pronosticos WHERE grupo_id=?", (grupo_id,)).fetchall()
    pronos_db = [dict(r) for r in pronos_res]
    
    mapa_pronos: Dict[str, Dict[str, Tuple[int, int]]] = {}
    for p in pronos_db: 
        c_u = str(p.get('correo_usuario', ''))
        id_p = str(p.get('id_partido', ''))
        gl = int(p.get('goles_local', 0))
        gv = int(p.get('goles_visitante', 0))
        if c_u not in mapa_pronos: mapa_pronos[c_u] = {}
        mapa_pronos[c_u][id_p] = (gl, gv)
    
    frec_marcador: Dict[str, Dict[Tuple[int, int], int]] = {}
    for p in pronos_db: 
        idp = str(p.get('id_partido', ''))
        gl = int(p.get('goles_local', 0))
        gv = int(p.get('goles_visitante', 0))
        if idp not in frec_marcador: frec_marcador[idp] = {}
        marc = (gl, gv)
        frec_marcador[idp][marc] = frec_marcador[idp].get(marc, 0) + 1
        
    reales: Dict[str, Tuple[int, int]] = {}
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(obtener_url_espn(liga))
            events = r.json().get('events', [])
            for ev in events:
                if not isinstance(ev, dict): continue
                st = ev.get('status', {}).get('type', {}).get('state', '')
                if st in ['in', 'post']:
                    comp = ev.get('competitions', [{}])[0]
                    c_comp = comp.get('competitors', [])
                    if len(c_comp) >= 2:
                        reales[str(ev.get('id', ''))] = (int(c_comp[0].get('score', 0)), int(c_comp[1].get('score', 0)))
        except Exception as e:
            print(f"Error fetching ESPN data: {e}")
    
    tabla: List[UserStats] = []
    for m in miembros:
        m_correo = str(m.get('correo', ''))
        u_stats = UserStats(
            nombre=str(m.get('nombre', '')),
            correo=m_correo,
            avatar=str(m.get('avatar', '👤'))
        )
        user_pronos = mapa_pronos.get(m_correo, {})
        for idp, (rl, rv) in reales.items():
            if idp in user_pronos:
                pl, pv = user_pronos[idp]
                if pl == rl and pv == rv:
                    if frec_marcador.get(idp, {}).get((pl, pv), 0) == 1:
                        u_stats.mu += 1
                        u_stats.puntos += 10
                    else:
                        u_stats.me += 1
                        u_stats.puntos += 5
                else:
                    win_p = 1 if pl > pv else (-1 if pl < pv else 0)
                    win_r = 1 if rl > rv else (-1 if rl < rv else 0)
                    if win_p == win_r:
                        u_stats.ga += 1
                        u_stats.puntos += 3
                    elif pl == rl or pv == rv:
                        u_stats.gg += 1
                        u_stats.puntos += 1
                    else:
                        u_stats.pe += 1
            else:
                u_stats.pe += 1
        tabla.append(u_stats)
    
    tabla.sort(key=lambda x: (x.puntos, x.mu, x.me), reverse=True)
    tabla_dicts = []
    for t in tabla:
        tabla_dicts.append({
            "nombre": t.nombre, "correo": t.correo, "avatar": t.avatar,
            "puntos": t.puntos, "mu": t.mu, "me": t.me,
            "ga": t.ga, "gg": t.gg, "pe": t.pe
        })
    try:
        for t in tabla: 
            db.execute("INSERT OR REPLACE INTO puntos_historial (grupo_id, correo_usuario, puntos) VALUES (?,?,?)", (grupo_id, t.correo, t.puntos))
        db.commit()
    except Exception as e:
        print(f"Error updating points history: {e}")
    return {"posiciones": tabla_dicts}

@app.get("/api/posiciones/historial/{grupo_id}")
def obtener_historial_puntos(grupo_id: int, db: sqlite3.Connection = Depends(get_db), user_req: str = Depends(get_current_user)):
    res = db.execute("""SELECT correo_usuario, puntos, fecha FROM puntos_historial WHERE grupo_id = ? ORDER BY fecha ASC""", (grupo_id,)).fetchall()
    historial: Dict[str, List[Dict[str, Any]]] = {}
    for r in res:
        c_u = str(r[0])
        if c_u not in historial: historial[c_u] = []
        historial[c_u].append({"puntos": r[1], "fecha": r[2]})
    return {"historial": historial}

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
