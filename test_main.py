import pytest
from fastapi.testclient import TestClient
from main import app, get_db, limiter
import sqlite3
import os
import secrets

# Deshabilitar rate limiter en tests para evitar falsos positivos
limiter.enabled = False

# Base de datos local para pruebas - se recrea en cada sesión
TEST_DB = "test_polla.db"

@pytest.fixture(autouse=True)
def limpiar_db():
    """Elimina la DB de test antes de cada test para evitar datos residuales."""
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    # También eliminar WAL y SHM si existen
    for suffix in ["-wal", "-shm"]:
        path = TEST_DB + suffix
        if os.path.exists(path):
            os.remove(path)
    yield
    # Cleanup post-test
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)
    for suffix in ["-wal", "-shm"]:
        path = TEST_DB + suffix
        if os.path.exists(path):
            os.remove(path)

def override_get_db():
    conn = sqlite3.connect(TEST_DB, timeout=10, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    cur = conn.cursor()
    
    # Init DB schema matching main.py
    cur.execute('CREATE TABLE IF NOT EXISTS usuarios (correo TEXT PRIMARY KEY, nombre TEXT NOT NULL, password TEXT NOT NULL, avatar TEXT DEFAULT "👤", alertas INTEGER DEFAULT 1, token TEXT UNIQUE, token_expiry TEXT)')
    cur.execute('CREATE TABLE IF NOT EXISTS grupos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, codigo TEXT UNIQUE, correo_creador TEXT, liga TEXT, limite INTEGER DEFAULT 10)')
    cur.execute('CREATE TABLE IF NOT EXISTS miembros_grupo (grupo_id INTEGER, correo_usuario TEXT, PRIMARY KEY(grupo_id, correo_usuario))')
    cur.execute('CREATE TABLE IF NOT EXISTS pronosticos (grupo_id INTEGER, correo_usuario TEXT, id_partido TEXT, goles_local INTEGER, goles_visitante INTEGER, PRIMARY KEY(grupo_id, correo_usuario, id_partido))')
    cur.execute('CREATE TABLE IF NOT EXISTS chat_mensajes (id INTEGER PRIMARY KEY AUTOINCREMENT, grupo_id INTEGER, correo_usuario TEXT, mensaje TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
    cur.execute('CREATE TABLE IF NOT EXISTS puntos_historial (grupo_id INTEGER, correo_usuario TEXT, puntos INTEGER, fecha DATE DEFAULT (CURRENT_DATE), PRIMARY KEY(grupo_id, correo_usuario, fecha))')
    cur.execute('CREATE TABLE IF NOT EXISTS logros (id INTEGER PRIMARY KEY AUTOINCREMENT, correo TEXT, badge_id TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(correo, badge_id))')
    conn.commit()
    
    try:
        yield conn
    finally:
        conn.close()

app.dependency_overrides[get_db] = override_get_db
client = TestClient(app)

# ==========================================
# Helpers
# ==========================================
def _crear_usuario(email=None, nombre="Test User"):
    """Registra y loguea un usuario. Retorna (email, token, headers)."""
    email = email or f"test_{secrets.token_hex(4)}@gmail.com"
    pwd = "Password123"
    client.post("/api/auth/registro", json={"correo": email, "password": pwd, "nombre": nombre})
    res = client.post("/api/auth/login", json={"correo": email, "password": pwd})
    token = res.json()["token"]
    return email, token, {"x-token": token, "x-correo": email}

def _crear_grupo(headers, nombre="Test Group", liga="champions"):
    """Crea un grupo y retorna (grupo_id, código)."""
    res = client.post("/api/grupos/crear", json={"nombre": nombre, "limite": 10, "liga": liga}, headers=headers)
    return res.json().get("id"), res.json().get("codigo")

# ==========================================
# Tests de Autenticación
# ==========================================
def test_registrar_y_login():
    email = f"test_{secrets.token_hex(4)}@gmail.com"
    pwd = "Password123"
    
    # Registrar
    res = client.post("/api/auth/registro", json={
        "correo": email, "password": pwd, "nombre": "Test User"
    })
    assert res.status_code == 200

    # Login exitoso
    res = client.post("/api/auth/login", json={
        "correo": email, "password": pwd
    })
    assert res.status_code == 200
    assert "token" in res.json()
    assert "correo" in res.json()

    # Login fallido (bad password)
    res = client.post("/api/auth/login", json={
        "correo": email, "password": "WrongPassword"
    })
    assert res.status_code == 401

def test_registro_duplicado():
    email = f"dup_{secrets.token_hex(4)}@gmail.com"
    pwd = "Password123"
    client.post("/api/auth/registro", json={"correo": email, "password": pwd, "nombre": "User1"})
    res = client.post("/api/auth/registro", json={"correo": email, "password": pwd, "nombre": "User2"})
    assert res.status_code == 400

# ==========================================
# Tests de Grupos
# ==========================================
def test_comportamiento_grupos():
    _, _, headers = _crear_usuario()

    # Crear grupo
    grupo_id, codigo = _crear_grupo(headers)
    assert codigo is not None

    # Otro usuario se une
    _, _, headers2 = _crear_usuario()
    res = client.post("/api/grupos/unirse", json={"codigo": codigo}, headers=headers2)
    assert res.status_code == 200
    
    # Verificar mis-grupos
    res = client.get("/api/grupos/mis-grupos", headers=headers2)
    grupos = res.json()["grupos"]
    assert len(grupos) == 1
    assert grupos[0]["liga"] == "champions"

# ==========================================
# Tests de Perfil
# ==========================================
def test_perfil_solo_retorna_usuario_autenticado():
    """El endpoint /api/perfil/{correo} siempre retorna el perfil del usuario autenticado, 
    no del correo en la URL (hallazgo #9)."""
    email1, _, headers1 = _crear_usuario(nombre="User A")
    email2, _, _ = _crear_usuario(nombre="User B")
    
    # Intentar ver el perfil de User B usando el token de User A
    res = client.get(f"/api/perfil/{email2}", headers=headers1)
    assert res.status_code == 200
    # Debe retornar User A, no User B
    assert res.json()["nombre"] == "User A"
    assert res.json()["correo"] == email1

# ==========================================
# Tests de Seguridad — Membership en Pronósticos
# ==========================================
def test_pronosticos_requieren_membresia():
    """Un usuario NO miembro del grupo no puede guardar pronósticos (hallazgo #5)."""
    _, _, headers_creador = _crear_usuario(nombre="Creador")
    grupo_id, _ = _crear_grupo(headers_creador)
    
    # Crear un usuario que NO es miembro del grupo
    _, _, headers_intruso = _crear_usuario(nombre="Intruso")
    
    res = client.post("/api/pronosticos/guardar", json={
        "grupo_id": grupo_id,
        "pronosticos": [{"id_partido": "fake123", "goles_local": 1, "goles_visitante": 0}]
    }, headers=headers_intruso)
    
    assert res.status_code == 403
    assert "miembro" in res.json()["detail"].lower()

# ==========================================
# Tests de Chat REST
# ==========================================
def test_chat_requiere_membresia():
    """Solo miembros del grupo pueden ver el chat."""
    _, _, headers1 = _crear_usuario(nombre="Owner")
    grupo_id, _ = _crear_grupo(headers1)
    
    _, _, headers_otro = _crear_usuario(nombre="Outsider")
    res = client.get(f"/api/chat/{grupo_id}", headers=headers_otro)
    assert res.status_code == 403

# ==========================================
# Tests de Endpoints sin Auth
# ==========================================
def test_endpoints_requieren_auth():
    """Los endpoints protegidos deben rechazar requests sin token."""
    res = client.get("/api/grupos/mis-grupos")
    assert res.status_code in [401, 403, 422]
    
    res = client.get("/api/perfil/nonexistent@test.com")
    assert res.status_code in [401, 403, 422]
