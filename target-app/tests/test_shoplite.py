"""Tests for ShopLite target app."""

import os
import sys
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.main import app

client = TestClient(app)


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


def test_search_normal():
    resp = client.get("/search?q=Keyboard")
    assert resp.status_code == 200
    assert len(resp.json()["results"]) >= 1


def test_order_total():
    resp = client.get("/orders/total?subtotal=100.0&item_count=2")
    assert resp.status_code == 200
    assert resp.json()["average_per_item"] == 50.0
