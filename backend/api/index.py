"""
Vercel serverless entry point.
Re-exports the FastAPI `app` from the main module so Vercel can discover it.

Vercel's @vercel/python runtime looks for an `app` variable (ASGI/WSGI)
in the file specified by vercel.json builds[].src.
"""
import sys
import os

# Add the project root (one level up from /api/) to the Python path
# so that `import main` resolves to backend/main.py
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import app  # noqa: E402, F401

# Vercel needs the `app` variable to be importable at module level.
# The FastAPI instance is the ASGI application that Vercel will serve.
