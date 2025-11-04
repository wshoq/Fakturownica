from fastapi import FastAPI, Request
import sqlite3
import json
from datetime import datetime

app = FastAPI()

DB_PATH = "/srv/Fakturownica/faktury.db"

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
