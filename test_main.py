import pytest
from fastapi.testclient import TestClient
from main import app, get_db
import sqlite3
import os
import secrets

# Base de datos local para pruebas
TEST_DB = "test_polla.db"

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

def test_comportamiento_grupos():
    email = f"test_group_{secrets.token_hex(4)}@gmail.com"
    pwd = "Password123"
    client.post("/api/auth/registro", json={
        "correo": email, "password": pwd, "nombre": "Group Creator"
    })
    res = client.post("/api/auth/login", json={
        "correo": email, "password": pwd
    })
    assert "token" in res.json(), res.json()
    token = res.json()["token"]
    headers = {"x-token": token}

    # Creador crea grupo
    res = client.post("/api/grupos/crear", json={
        "nombre": "Test Group", "limite": 10, "liga": "champions"
    }, headers=headers)
    assert res.status_code == 200
    grupo_code = res.json()["codigo"]

    # Otro usuario se une
    email2 = f"test_group_2_{secrets.token_hex(4)}@gmail.com"
    client.post("/api/auth/registro", json={"correo": email2, "password": pwd, "nombre": "Group Joiner"})
    res2 = client.post("/api/auth/login", json={"correo": email2, "password": pwd})
    token2 = res2.json()["token"]
    
    res = client.post("/api/grupos/unirse", json={
        "codigo": grupo_code
    }, headers={"x-token": token2})
    assert res.status_code == 200
    
    # Verificar mis-grupos
    res = client.get("/api/grupos/mis-grupos", headers={"x-token": token2})
    grupos = res.json()["grupos"]
    assert len(grupos) == 1
    assert grupos[0]["liga"] == "champions"
