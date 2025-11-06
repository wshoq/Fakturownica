from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import sqlite3
import json
from datetime import datetime
import os

app = FastAPI()

# ─────────────────────────────
# 🔧 Ścieżki
# ─────────────────────────────
DB_PATH = "/srv/Fakturownica/faktury.db"
UPLOADS_DIR = "/srv/Fakturownica/uploads"
os.makedirs(UPLOADS_DIR, exist_ok=True)

# ─────────────────────────────
# 🔓 CORS – dostęp z frontendu
# ─────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────
# 📂 Serwowanie plików PDF
# ─────────────────────────────
# Dzięki temu pliki będą dostępne pod:
# http://vps15151.awhost.cloud:3012/uploads/nazwa.pdf
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")


# ─────────────────────────────
# 🟢 Dodawanie faktury
# ─────────────────────────────
@app.post("/api/faktura")
async def add_faktura(request: Request):
    data = await request.json()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO faktury (
            firma,
            numer_faktury,
            data_wystawienia,
            termin_platnosci,
            waluta,
            suma_netto,
            suma_vat,
            suma_brutto,
            json_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        data.get("sprzedawca", {}).get("nazwa", ""),
        data.get("numer_faktury", ""),
        data.get("daty", {}).get("data_wystawienia", ""),
        data.get("daty", {}).get("termin_platnosci", ""),
        data.get("waluta", ""),
        data.get("suma_netto", 0),
        data.get("suma_vat", 0),
        data.get("suma_brutto", 0),
        json.dumps(data)
    ))
    conn.commit()
    conn.close()
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


# ─────────────────────────────
# 🟣 Pobieranie faktur
# ─────────────────────────────
@app.get("/api/faktury")
async def get_faktury():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT json_data FROM faktury ORDER BY id DESC")
    rows = cursor.fetchall()
    conn.close()

    faktury = []
    for row in rows:
        try:
            faktury.append(json.loads(row[0]))
        except Exception as e:
            print("❌ Błąd JSON:", e)
    return faktury


# ─────────────────────────────
# 🟡 Aktualizacja pola w json_data
# ─────────────────────────────
@app.patch("/api/faktura/update")
async def update_faktura(request: Request):
    payload = await request.json()
    numer_faktury = payload.get("numer_faktury")
    field_path = payload.get("field")
    new_value = payload.get("value")

    if not numer_faktury or not field_path:
        return {"error": "Brak danych"}

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id, json_data FROM faktury WHERE numer_faktury=?", (numer_faktury,))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return {"error": "Nie znaleziono faktury"}

    fid, json_str = row
    data = json.loads(json_str)
    keys = field_path.split(".")
    ref = data
    for k in keys[:-1]:
        ref = ref.get(k, {})
    ref[keys[-1]] = new_value

    cursor.execute("""
        UPDATE faktury
        SET json_data=?, data_wystawienia=?, termin_platnosci=?, waluta=?, suma_netto=?, suma_vat=?, suma_brutto=?
        WHERE id=?
    """, (
        json.dumps(data),
        data.get("daty", {}).get("data_wystawienia", ""),
        data.get("daty", {}).get("termin_platnosci", ""),
        data.get("waluta", ""),
        data.get("suma_netto", 0),
        data.get("suma_vat", 0),
        data.get("suma_brutto", 0),
        fid
    ))
    conn.commit()
    conn.close()
    return {"status": "updated", "field": field_path, "value": new_value}


# ─────────────────────────────
# 🧩 Debug – sprawdzenie plików w katalogu
# ─────────────────────────────
@app.get("/api/debug/files")
async def list_files():
    """Pomocniczy endpoint do sprawdzenia zawartości katalogu /uploads"""
    try:
        files = os.listdir(UPLOADS_DIR)
        return {"uploads_dir": UPLOADS_DIR, "files": files}
    except Exception as e:
        return {"error": str(e)}
