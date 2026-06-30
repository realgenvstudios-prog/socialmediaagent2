#!/usr/bin/env python3
"""
One-time migration: adds clip_transcript TEXT column to clip_selection_log.
Safe to run multiple times (uses IF NOT EXISTS).
"""

import os
import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ["SUPABASE_KEY"]

# Use PostgREST RPC to call a postgres function that adds the column.
# We create the function inline via a direct SQL API call.

SQL = """
ALTER TABLE clip_selection_log
ADD COLUMN IF NOT EXISTS clip_transcript TEXT;
"""

# Supabase exposes a SQL endpoint via the service role key
resp = requests.post(
    f"{SUPABASE_URL}/rest/v1/rpc/exec",
    headers={
        "Authorization": f"Bearer {SERVICE_KEY}",
        "apikey": SERVICE_KEY,
        "Content-Type": "application/json",
    },
    json={"sql": SQL},
    timeout=15,
)

if resp.ok:
    print("Migration successful.")
else:
    # Try alternative: insert a dummy row with the column to trigger schema cache
    # Actually fall back to reporting what's needed
    print(f"Could not run via RPC ({resp.status_code}): {resp.text[:200]}")
    print()
    print("Run this SQL manually in Supabase SQL Editor:")
    print(SQL)
