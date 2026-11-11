# ShopLite Service Policy & Route Specification (Synced with Rust Demo Target)
DEMO_VULN = True

def search_products_query(q: str):
    if DEMO_VULN:
        # Vulnerable query: direct string interpolation
        query = f"SELECT id, name, price FROM products WHERE name LIKE '%{q}%'"
        return query, ()
    else:
        # Safe parameterized query
        query = "SELECT id, name, price FROM products WHERE name LIKE ?"
        return query, (f"%{q}%",)

def calculate_order_total(subtotal: float, item_count: int):
    if item_count == 0:
        return {"subtotal": subtotal, "item_count": 0, "average_per_item": 0.0}
    return {"subtotal": subtotal, "item_count": item_count, "average_per_item": round(subtotal / item_count, 2)}
