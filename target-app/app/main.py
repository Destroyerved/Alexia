"""ShopLite target application for Alexia monitoring and automated healing.

A realistic lightweight e-commerce API built with FastAPI and SQLite.
Contains endpoints:
- GET /health: Health probe endpoint
- POST /api/v1/auth/login: User authentication with brute force telemetry
- GET /search: Product search (vulnerable to SQL injection when DEMO_VULN=1)
- GET /orders/total: Order subtotal calculation (vulnerable to division by zero on bad deploy)
"""

from __future__ import annotations
import os
import sqlite3
from typing import Optional
from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel

app = FastAPI(title="ShopLite Target App", version="1.0.0")

DEMO_VULN = os.getenv("DEMO_VULN", "1") == "1"
DB_PATH = os.getenv("DATABASE_URL", "data/shoplite.db").replace("sqlite:///", "").replace("./", "")


def get_db():
    os.makedirs(os.path.dirname(DB_PATH) or "data", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                phone TEXT NOT NULL,
                username TEXT NOT NULL,
                password_hash TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                price REAL NOT NULL,
                stock INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                subtotal REAL NOT NULL,
                item_count INTEGER NOT NULL
            )
            """
        )
        # Seed initial synthetic records
        conn.execute("INSERT OR IGNORE INTO users VALUES (1, 'alice@example.com', '+919876543210', 'alice', 'pbkdf2:sha256:1000$demohash1')")
        conn.execute("INSERT OR IGNORE INTO users VALUES (2, 'bob@example.com', '+919876543211', 'bob', 'pbkdf2:sha256:1000$demohash2')")
        conn.execute("INSERT OR IGNORE INTO products VALUES (1, 'Wireless Keyboard', 49.99, 100)")
        conn.execute("INSERT OR IGNORE INTO products VALUES (2, 'Ergonomic Mouse', 29.99, 150)")
        conn.execute("INSERT OR IGNORE INTO products VALUES (3, 'USB-C Docking Hub', 89.99, 50)")
        conn.commit()


init_db()


@app.get("/health")
def health_check():
    return {"status": "healthy", "service": "shoplite-api", "version": "1.0.0"}


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/v1/auth/login")
def login(req: LoginRequest):
    # Simulated auth check
    if req.username == "admin" and req.password == "secretpass":
        return {"status": "authenticated", "token": "shoplite_jwt_token_demo"}
    raise HTTPException(status_code=401, detail="Invalid credentials")


@app.get("/search")
def search_products(q: str = Query("", description="Search term")):
    """Product search endpoint.

    When DEMO_VULN=1, demonstrates raw string SQL interpolation vulnerable to SQLi.
    Alexia Builder patches this to a parameterized query.
    """
    with get_db() as conn:
        cur = conn.cursor()
        if DEMO_VULN:
            # Vulnerable query: direct string interpolation
            query = f"SELECT id, name, price FROM products WHERE name LIKE '%{q}%'"
            try:
                cur.execute(query)
                rows = cur.fetchall()
                return {"query": q, "results": [dict(r) for r in rows]}
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Database query error: {str(e)}")
        else:
            # Safe parameterized query
            query = "SELECT id, name, price FROM products WHERE name LIKE ?"
            cur.execute(query, (f"%{q}%",))
            rows = cur.fetchall()
            return {"query": q, "results": [dict(r) for r in rows]}


@app.get("/orders/total")
def calculate_order_total(subtotal: float = 100.0, item_count: int = 2):
    """Calculates average price per item.

    During S1 Bad Deploy scenario, division by zero occurs if item_count is 0.
    """
    if item_count == 0:
        # Guard clause (this is what Builder agent generates!)
        return {"subtotal": subtotal, "item_count": 0, "average_per_item": 0.0}
    return {"subtotal": subtotal, "item_count": item_count, "average_per_item": round(subtotal / item_count, 2)}
