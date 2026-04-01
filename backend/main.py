import os
import json
import time
import asyncio
from urllib.parse import urlparse
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai

load_dotenv()  # no-op if .env is missing (e.g. on Vercel)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "gemini-3.1-flash"

# Lazy client — created on first request, not at import time.
# This prevents cold-start crashes when env vars aren't ready yet.
_client = None


def get_gemini_client():
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key or api_key == "your_api_key_here":
            raise HTTPException(
                status_code=500,
                detail="GEMINI_API_KEY not configured. Set it in Vercel Environment Variables.",
            )
        _client = genai.Client(api_key=api_key)
    return _client


app = FastAPI(title="Shield Phishing Detector API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


CACHE = {}           # domain -> { result, timestamp }
CACHE_TTL = 3600     # cache results for 1 hour (seconds)
MAX_CACHE_SIZE = 500


def get_cached(domain: str) -> dict | None:
    entry = CACHE.get(domain)
    if entry and (time.time() - entry["timestamp"]) < CACHE_TTL:
        return entry["result"]
    elif entry:
        del CACHE[domain]
    return None


def set_cache(domain: str, result: dict):
    if len(CACHE) >= MAX_CACHE_SIZE:
        # Evict oldest entry
        oldest = min(CACHE, key=lambda k: CACHE[k]["timestamp"])
        del CACHE[oldest]
    CACHE[domain] = {"result": result, "timestamp": time.time()}


# ─── Trusted domains (skip API call entirely) ───────────────────────────────

TRUSTED_DOMAINS = {
    "google.com", "youtube.com", "instagram.com", "amazon.com", "amazon.in",
    "facebook.com", "paypal.com", "bing.com", "yahoo.com", "apple.com",
    "github.com", "microsoft.com", "linkedin.com", "twitter.com", "x.com",
    "reddit.com", "stackoverflow.com", "wikipedia.org", "netflix.com",
    "spotify.com", "whatsapp.com",
}

SAFE_RESPONSE_TEMPLATE = {
    "final_probability": 0.02,
    "prediction": "legitimate",
    "reasons": {
        "security": [],
        "url": [],
        "domain": [],
        "behavior": [],
    },
}


def get_domain(url: str) -> str:
    return urlparse(url).netloc.lower()


def is_trusted(domain: str) -> bool:
    return any(domain == t or domain.endswith("." + t) for t in TRUSTED_DOMAINS)


def is_search_page(url: str) -> bool:
    lower = url.lower()
    return "google.com/search" in lower or "bing.com/search" in lower


def is_internal_page(url: str) -> bool:
    return url.startswith(("chrome://", "edge://", "about:", "chrome-extension://", "file://"))


# ─── Gemini analysis with retry ─────────────────────────────────────────────

SYSTEM_PROMPT = """You are a cybersecurity expert. Analyze the URL and assess phishing risk.

Respond with ONLY a valid JSON object (no markdown, no code fences):
{
  "final_probability": <float 0.0-1.0>,
  "prediction": "phishing" or "legitimate",
  "reasons": {
    "summary": "<ONE short sentence explaining the verdict>",
    "security": ["<short observation or empty list>"],
    "url": ["<short observation or empty list>"],
    "domain": ["<short observation or empty list>"],
    "behavior": ["<short observation or empty list>"]
  }
}

Rules:
- >= 0.70 = phishing, < 0.40 = safe, 0.40-0.69 = suspicious
- The "summary" MUST be one sentence under 15 words
- Each category list should have at most 1 short item
- Check for: typosquatting, brand impersonation, IP addresses, suspicious TLDs, phishing keywords, URL shorteners"""

MAX_RETRIES = 3
RETRY_BASE_DELAY = 5  # seconds


async def analyze_with_gemini(url: str) -> dict:
    """Send URL to Gemini for phishing analysis with retry on rate limit."""
    gemini_client = get_gemini_client()
    last_error = None

    for attempt in range(MAX_RETRIES):
        try:
            response = gemini_client.models.generate_content(
                model=MODEL,
                contents=f"Analyze this URL for phishing: {url}",
                config={
                    "system_instruction": SYSTEM_PROMPT,
                    "temperature": 0.1,
                },
            )

            raw_text = response.text.strip()

            # Clean potential markdown fences
            if raw_text.startswith("```"):
                raw_text = raw_text.split("\n", 1)[1]
            if raw_text.endswith("```"):
                raw_text = raw_text.rsplit("```", 1)[0]
            raw_text = raw_text.strip()

            result = json.loads(raw_text)

            # Validate and clamp probability
            prob = float(result.get("final_probability", 0.5))
            prob = max(0.0, min(1.0, prob))

            return {
                "final_probability": round(prob, 4),
                "prediction": result.get("prediction", "legitimate"),
                "reasons": result.get("reasons", {
                    "security": [],
                    "url": [],
                    "domain": [],
                    "behavior": [],
                }),
            }

        except json.JSONDecodeError as e:
            print(f"Gemini JSON parse error: {e}\nRaw response: {raw_text}")
            raise HTTPException(status_code=502, detail="Failed to parse Gemini response")

        except Exception as e:
            last_error = str(e)
            if "429" in last_error or "RESOURCE_EXHAUSTED" in last_error:
                delay = RETRY_BASE_DELAY * (2 ** attempt)
                print(f"Rate limited (attempt {attempt + 1}/{MAX_RETRIES}). Retrying in {delay}s...")
                await asyncio.sleep(delay)
            else:
                print(f"Gemini API error: {e}")
                raise HTTPException(status_code=502, detail=f"Gemini API error: {last_error}")

    # All retries exhausted
    raise HTTPException(
        status_code=429,
        detail=f"Gemini API rate limit exceeded after {MAX_RETRIES} retries. Please wait a minute and try again."
    )


# ─── API endpoints ──────────────────────────────────────────────────────────

class URLRequest(BaseModel):
    url: str


@app.get("/")
def root():
    return {
        "service": "Shield Phishing Detector API",
        "version": "1.0.0",
        "endpoints": {
            "POST /predict": "Analyze a URL for phishing",
            "GET /health": "Health check",
        },
    }


@app.post("/predict")
async def predict_url(request: URLRequest):
    url = request.url
    domain = get_domain(url)

    # Skip internal browser pages
    if is_internal_page(url):
        return SAFE_RESPONSE_TEMPLATE

    # Skip API call for search pages
    if is_search_page(url):
        return {
            **SAFE_RESPONSE_TEMPLATE,
            "final_probability": 0.05,
            "reasons": {
                **SAFE_RESPONSE_TEMPLATE["reasons"],
                "domain": ["This is a known search engine results page"],
            },
        }

    # Skip API call for trusted domains
    if is_trusted(domain):
        return {
            **SAFE_RESPONSE_TEMPLATE,
            "reasons": {
                **SAFE_RESPONSE_TEMPLATE["reasons"],
                "domain": [f"{domain} is a well-known, trusted domain"],
            },
        }

    # Check in-memory cache (domain-level)
    cached = get_cached(domain)
    if cached:
        print(f"Cache hit for {domain}")
        return cached

    # Full Gemini analysis
    result = await analyze_with_gemini(url)

    # Cache the result
    set_cache(domain, result)

    return result


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "model": MODEL,
        "api_key_set": bool(GEMINI_API_KEY and GEMINI_API_KEY != "your_api_key_here"),
        "cached_domains": len(CACHE),
    }
