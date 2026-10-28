#!/usr/bin/env python3
"""
Amazon Resale Sniper — backend parser
=====================================

Pulls Amazon Resale (formerly "Amazon Warehouse") offers through the official
Amazon **Creators API** (the OAuth2 successor to PA-API 5, which Amazon retired
in 2026 — PA-API calls now return 403 AccessDenied), keeps only Used - Like New /
Used - Very Good listings that are >= MIN_DISCOUNT_PCT below the new price, and
writes a static `data.json` for the <amazon-sniper> web component.

How the "new price" is found
----------------------------
OffersV2 only returns the *featured* (Buy Box) offer(s) for an ASIN — there is no
per-condition offer list or Offers.Summaries any more. So the parser:
  1. records every featured NEW price it sees into `price_history.json`;
  2. when the featured offer is an Amazon Resale used offer, compares it against
     the most recent observed new price (<= HISTORY_MAX_AGE_DAYS old), falling
     back to the listing's own `price.savingBasis` (List / Was price).
Run it on a schedule and the history fills itself in.

Environment variables
---------------------
Required:
  CREATORS_CREDENTIAL_ID        Creators API Credential ID      (Associates Central > Tools > Creators API)
  CREATORS_CREDENTIAL_SECRET    Creators API Credential Secret
  AMAZON_PARTNER_TAG            Your Associates tag, e.g. mytag-20
Optional:
  CREATORS_CREDENTIAL_VERSION   3.1 (NA, default) | 3.2 (EU) | 3.3 (FE) | legacy 2.1/2.2/2.3
  AMAZON_MARKETPLACE            www.amazon.com (default)
  MIN_DISCOUNT_PCT              35
  MAX_DISCOUNT_PCT              92   (drops obvious data errors)
  TARGET_SUBCONDITIONS          LikeNew,VeryGood
  RESALE_MERCHANT_NAMES         Amazon Resale,Amazon Warehouse   (case-insensitive substring match)
  RESALE_MERCHANT_IDS           comma list of seller IDs to accept in addition to names
  SEARCH_KEYWORDS               comma list (see DEFAULT_KEYWORDS)
  SEARCH_INDEX                  All
  SEARCH_PAGES                  2   (10 items per page, max 10 pages)
  WATCHLIST_FILE                asins.txt  (one ASIN per line, '#' comments allowed; optional)
  DATA_FILE                     data.json
  HISTORY_FILE                  price_history.json
  HISTORY_MAX_AGE_DAYS          14
  REQUEST_INTERVAL_SEC          1.1  (new credentials start around 1 request/second)
"""
from __future__ import annotations

import json
import logging
import os
import random
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

import requests

log = logging.getLogger("sniper")

API_BASE = "https://creatorsapi.amazon/catalog/v1"
TOKEN_ENDPOINTS = {
    # Login with Amazon (current credentials)
    "3.1": "https://api.amazon.com/auth/o2/token",
    "3.2": "https://api.amazon.co.uk/auth/o2/token",
    "3.3": "https://api.amazon.co.jp/auth/o2/token",
    # Legacy Cognito credentials
    "2.1": "https://creatorsapi.auth.us-east-1.amazoncognito.com/oauth2/token",
    "2.2": "https://creatorsapi.auth.eu-south-2.amazoncognito.com/oauth2/token",
    "2.3": "https://creatorsapi.auth.us-west-2.amazoncognito.com/oauth2/token",
}
RESOURCES = [
    "itemInfo.title",
    "itemInfo.byLineInfo",
    "images.primary.medium",
    "offersV2.listings.availability",
    "offersV2.listings.condition",
    "offersV2.listings.isBuyBoxWinner",
    "offersV2.listings.merchantInfo",
    "offersV2.listings.price",
    "offersV2.listings.type",
]
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
UNBUYABLE = {"OUT_OF_STOCK", "UNAVAILABLE"}
SUBCONDITION_LABELS = {
    "LikeNew": "Like New",
    "VeryGood": "Very Good",
    "Good": "Good",
    "Acceptable": "Acceptable",
    "OpenBox": "Open Box",
}
DEFAULT_KEYWORDS = (
    "Apple AirPods,Apple iPad,Apple MacBook,Sony headphones,Sony PlayStation,"
    "RTX graphics card,Bose headphones,Samsung monitor,Nintendo Switch,mechanical keyboard"
)
ASIN_RE = re.compile(r"^[A-Z0-9]{10}$")


# --------------------------------------------------------------------------- config
def _env(name: str, default: str | None = None, *, required: bool = False) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    if required:
        raise SystemExit(f"Missing required environment variable: {name}")
    return default or ""


def _csv(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split(",") if part.strip())


@dataclass(frozen=True)
class Config:
    credential_id: str
    credential_secret: str
    credential_version: str
    partner_tag: str
    marketplace: str
    min_discount_pct: float
    max_discount_pct: float
    target_subconditions: frozenset[str]
    resale_merchant_names: tuple[str, ...]
    resale_merchant_ids: frozenset[str]
    keywords: tuple[str, ...]
    search_index: str
    search_pages: int
    watchlist_file: Path
    data_file: Path
    history_file: Path
    history_max_age: timedelta
    request_interval: float

    @classmethod
    def from_env(cls) -> "Config":
        version = _env("CREATORS_CREDENTIAL_VERSION", "3.1")
        if version not in TOKEN_ENDPOINTS:
            raise SystemExit(f"Unsupported CREATORS_CREDENTIAL_VERSION={version!r}; use one of {sorted(TOKEN_ENDPOINTS)}")
        return cls(
            credential_id=_env("CREATORS_CREDENTIAL_ID", required=True),
            credential_secret=_env("CREATORS_CREDENTIAL_SECRET", required=True),
            credential_version=version,
            partner_tag=_env("AMAZON_PARTNER_TAG", required=True),
            marketplace=_env("AMAZON_MARKETPLACE", "www.amazon.com"),
            min_discount_pct=float(_env("MIN_DISCOUNT_PCT", "35")),
            max_discount_pct=float(_env("MAX_DISCOUNT_PCT", "92")),
            target_subconditions=frozenset(_csv(_env("TARGET_SUBCONDITIONS", "LikeNew,VeryGood"))),
            resale_merchant_names=tuple(n.lower() for n in _csv(_env("RESALE_MERCHANT_NAMES", "Amazon Resale,Amazon Warehouse"))),
            resale_merchant_ids=frozenset(_csv(_env("RESALE_MERCHANT_IDS", ""))),
            keywords=_csv(_env("SEARCH_KEYWORDS", DEFAULT_KEYWORDS)),
            search_index=_env("SEARCH_INDEX", "All"),
            search_pages=max(1, min(10, int(_env("SEARCH_PAGES", "2")))),
            watchlist_file=Path(_env("WATCHLIST_FILE", "asins.txt")),
            data_file=Path(_env("DATA_FILE", "data.json")),
            history_file=Path(_env("HISTORY_FILE", "price_history.json")),
            history_max_age=timedelta(days=int(_env("HISTORY_MAX_AGE_DAYS", "14"))),
            request_interval=float(_env("REQUEST_INTERVAL_SEC", "1.1")),
        )

    @property
    def store_origin(self) -> str:
        return f"https://{self.marketplace}"


# --------------------------------------------------------------------------- API client
class ApiError(RuntimeError):
    def __init__(self, operation: str, status: int | None, detail: str):
        super().__init__(f"{operation} failed (HTTP {status}): {detail}")
        self.status = status

    @property
    def fatal(self) -> bool:
        """Auth / permission problems won't fix themselves on the next keyword."""
        return self.status in (401, 403)


class CreatorsApiClient:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "AmazonResaleSniper/1.0 (+github-actions)"
        self._token: str | None = None
        self._token_expiry = 0.0
        self._last_call = 0.0

    # -- auth ------------------------------------------------------------
    def _fetch_token(self) -> None:
        version = self.cfg.credential_version
        url = TOKEN_ENDPOINTS[version]
        creds = {
            "grant_type": "client_credentials",
            "client_id": self.cfg.credential_id,
            "client_secret": self.cfg.credential_secret,
        }
        if version.startswith("3."):
            resp = self.session.post(url, json={**creds, "scope": "creatorsapi::default"}, timeout=20)
        else:  # legacy Cognito: form-encoded
            resp = self.session.post(url, data={**creds, "scope": "creatorsapi/default"}, timeout=20)
        if resp.status_code != 200:
            raise ApiError("token", resp.status_code, resp.text[:300])
        payload = resp.json()
        self._token = payload["access_token"]
        self._token_expiry = time.time() + int(payload.get("expires_in", 3600)) - 60
        log.info("Obtained access token (credential version %s)", version)

    def _authorization(self) -> str:
        if not self._token or time.time() >= self._token_expiry:
            self._fetch_token()
        if self.cfg.credential_version.startswith("2."):
            return f"Bearer {self._token}, Version {self.cfg.credential_version}"
        return f"Bearer {self._token}"

    # -- transport -------------------------------------------------------
    def _throttle(self) -> None:
        wait = self.cfg.request_interval - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def call(self, operation: str, body: dict[str, Any], max_attempts: int = 5) -> dict[str, Any]:
        payload = {
            "partnerTag": self.cfg.partner_tag,
            "marketplace": self.cfg.marketplace,
            "resources": RESOURCES,
            **body,
        }
        last_error = "unknown error"
        last_status: int | None = None
        for attempt in range(1, max_attempts + 1):
            self._throttle()
            headers = {
                "Authorization": self._authorization(),
                "Content-Type": "application/json",
                "x-marketplace": self.cfg.marketplace,
            }
            try:
                resp = self.session.post(f"{API_BASE}/{operation}", json=payload, headers=headers, timeout=30)
            except requests.RequestException as exc:
                last_status, last_error = None, str(exc)
            else:
                if resp.status_code == 200:
                    data = resp.json()
                    for err in data.get("errors") or []:
                        log.info("%s partial error: %s — %s", operation, err.get("code"), err.get("message"))
                    return data
                last_status, last_error = resp.status_code, resp.text[:500]
                if resp.status_code == 401 and attempt == 1:
                    self._token = None  # token revoked/expired early: refresh once
                    continue
                if resp.status_code not in RETRYABLE_STATUS:
                    raise ApiError(operation, resp.status_code, last_error)
            delay = min(60.0, 2.0 ** attempt) + random.uniform(0, 1)
            log.warning("%s attempt %d/%d failed (%s); retrying in %.1fs", operation, attempt, max_attempts, last_status, delay)
            time.sleep(delay)
        raise ApiError(operation, last_status, f"gave up after {max_attempts} attempts: {last_error}")

    # -- operations ------------------------------------------------------
    def get_items(self, asins: list[str]) -> Iterator[dict[str, Any]]:
        for i in range(0, len(asins), 10):  # GetItems accepts up to 10 ASINs per call
            data = self.call("getItems", {"itemIds": asins[i:i + 10], "itemIdType": "ASIN"})
            yield from (data.get("itemsResult") or {}).get("items") or []

    def search_items(self, keywords: str, page: int) -> list[dict[str, Any]]:
        data = self.call("searchItems", {
            "keywords": keywords,
            "searchIndex": self.cfg.search_index,
            "itemCount": 10,
            "itemPage": page,
        })
        return (data.get("searchResult") or {}).get("items") or []


# --------------------------------------------------------------------------- price history
class PriceHistory:
    """ASIN -> last observed featured NEW price. Persisted between runs (committed to the repo)."""

    def __init__(self, path: Path):
        self.path = path
        self.entries: dict[str, dict[str, Any]] = {}
        if path.exists():
            try:
                self.entries = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                log.warning("Ignoring unreadable %s: %s", path, exc)

    def record(self, asin: str, price: float, currency: str, now: datetime) -> None:
        self.entries[asin] = {"new_price": round(price, 2), "currency": currency, "seen_at": iso(now)}

    def lookup(self, asin: str, currency: str, now: datetime, max_age: timedelta) -> float | None:
        entry = self.entries.get(asin)
        if not entry or entry.get("currency") != currency:
            return None
        try:
            seen = datetime.fromisoformat(entry["seen_at"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            return None
        return float(entry["new_price"]) if now - seen <= max_age else None

    def prune(self, now: datetime, keep: timedelta) -> None:
        cutoff = now - keep
        def fresh(e: dict[str, Any]) -> bool:
            try:
                return datetime.fromisoformat(e["seen_at"].replace("Z", "+00:00")) >= cutoff
            except (KeyError, ValueError):
                return False
        self.entries = {a: e for a, e in self.entries.items() if fresh(e)}

    def save(self) -> None:
        atomic_write_json(self.path, dict(sorted(self.entries.items())))


# --------------------------------------------------------------------------- parsing
@dataclass
class Deal:
    asin: str
    title: str
    brand: str | None
    image: str | None
    condition: str
    condition_note: str | None
    resale_price: float
    new_price: float
    savings: float
    discount_pct: float
    currency: str
    reference: str
    merchant: str
    url: str


def dig(obj: Any, *path: str) -> Any:
    for key in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
    return obj


def money(node: Any) -> float | None:
    try:
        value = float(dig(node, "amount"))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def clean_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = re.sub(r"\s+", " ", value).strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def is_resale_merchant(listing: dict[str, Any], cfg: Config) -> bool:
    name = (dig(listing, "merchantInfo", "name") or "").lower()
    merchant_id = dig(listing, "merchantInfo", "id") or ""
    return merchant_id in cfg.resale_merchant_ids or any(n in name for n in cfg.resale_merchant_names)


def affiliate_link(cfg: Config, asin: str) -> str:
    """Canonical Associates link: https://www.amazon.com/dp/<ASIN>?tag=<tag>"""
    return f"{cfg.store_origin}/dp/{asin}?tag={requests.utils.quote(cfg.partner_tag)}"


def evaluate_item(item: dict[str, Any], cfg: Config, history: PriceHistory, now: datetime) -> Deal | None:
    asin = item.get("asin")
    if not isinstance(asin, str) or not asin:
        return None
    listings = [l for l in (dig(item, "offersV2", "listings") or []) if isinstance(l, dict)]

    def buyable(l: dict[str, Any]) -> bool:
        return (money(dig(l, "price", "money")) is not None
                and not l.get("violatesMAP")  # MAP-restricted prices may not be displayed
                and dig(l, "availability", "type") not in UNBUYABLE)

    # Pass 1: remember the featured NEW price as the reference for future runs.
    for l in listings:
        if buyable(l) and (dig(l, "condition", "value") or "").lower() == "new":
            history.record(asin, money(dig(l, "price", "money")), dig(l, "price", "money", "currency") or "USD", now)

    # Pass 2: cheapest qualifying Amazon Resale used offer.
    used = [
        l for l in listings
        if buyable(l)
        and (dig(l, "condition", "value") or "").lower() == "used"
        and dig(l, "condition", "subCondition") in cfg.target_subconditions
        and is_resale_merchant(l, cfg)
    ]
    if not used:
        return None
    offer = min(used, key=lambda l: money(dig(l, "price", "money")))
    resale_price = money(dig(offer, "price", "money"))
    currency = dig(offer, "price", "money", "currency") or "USD"

    new_price = history.lookup(asin, currency, now, cfg.history_max_age)
    reference = "observed_new_price"
    if new_price is None:
        new_price = money(dig(offer, "price", "savingBasis", "money"))
        reference = dig(offer, "price", "savingBasis", "savingBasisType") or "SAVING_BASIS"
    if new_price is None or new_price <= resale_price:
        return None

    discount = (new_price - resale_price) / new_price * 100
    if not (cfg.min_discount_pct <= discount <= cfg.max_discount_pct):
        return None

    sub = dig(offer, "condition", "subCondition")
    return Deal(
        asin=asin,
        title=clean_text(dig(item, "itemInfo", "title", "displayValue"), 200) or asin,
        brand=clean_text(dig(item, "itemInfo", "byLineInfo", "brand", "displayValue"), 60),
        image=dig(item, "images", "primary", "medium", "url"),
        condition=f"Used - {SUBCONDITION_LABELS.get(sub, sub)}",
        condition_note=clean_text(dig(offer, "condition", "conditionNote"), 180),
        resale_price=round(resale_price, 2),
        new_price=round(new_price, 2),
        savings=round(new_price - resale_price, 2),
        discount_pct=round(discount, 1),
        currency=currency,
        reference=reference,
        merchant=dig(offer, "merchantInfo", "name") or "Amazon Resale",
        url=affiliate_link(cfg, asin),
    )


# --------------------------------------------------------------------------- io helpers
def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)  # readers never see a half-written file


def read_watchlist(path: Path) -> list[str]:
    if not path.exists():
        return []
    asins: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        token = line.split("#", 1)[0].strip().upper()
        if not token:
            continue
        if ASIN_RE.match(token):
            asins.append(token)
        else:
            log.warning("Skipping invalid ASIN in %s: %r", path, token)
    return list(dict.fromkeys(asins))


# --------------------------------------------------------------------------- main
def run(cfg: Config) -> int:
    now = datetime.now(timezone.utc)
    client = CreatorsApiClient(cfg)
    history = PriceHistory(cfg.history_file)
    deals: dict[str, Deal] = {}
    scanned = 0

    def consume(items: Iterable[dict[str, Any]]) -> None:
        nonlocal scanned
        for item in items:
            scanned += 1
            deal = evaluate_item(item, cfg, history, now)
            if deal and (deal.asin not in deals or deal.discount_pct > deals[deal.asin].discount_pct):
                deals[deal.asin] = deal

    watchlist = read_watchlist(cfg.watchlist_file)
    if watchlist:
        log.info("Checking %d watchlist ASINs", len(watchlist))
        try:
            consume(client.get_items(watchlist))
        except ApiError as exc:
            if exc.fatal:
                raise
            log.error("%s", exc)

    for keyword in cfg.keywords:
        for page in range(1, cfg.search_pages + 1):
            try:
                items = client.search_items(keyword, page)
            except ApiError as exc:
                if exc.fatal:
                    raise
                log.error("%s", exc)
                break
            consume(items)
            if len(items) < 10:
                break

    if scanned == 0:
        log.error("No items retrieved from the API; leaving %s untouched.", cfg.data_file)
        return 1

    history.prune(now, keep=cfg.history_max_age * 2)
    history.save()

    ranked = sorted(deals.values(), key=lambda d: d.discount_pct, reverse=True)
    atomic_write_json(cfg.data_file, {
        "schema": 1,
        "updated_at": iso(now),
        "marketplace": cfg.marketplace,
        "currency": ranked[0].currency if ranked else "USD",
        "min_discount_pct": cfg.min_discount_pct,
        "count": len(ranked),
        "deals": [asdict(d) for d in ranked],
    })
    log.info("Scanned %d items -> %d deals >= %.0f%% off. Wrote %s", scanned, len(ranked), cfg.min_discount_pct, cfg.data_file)
    return 0


def main() -> int:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    try:
        return run(Config.from_env())
    except ApiError as exc:
        log.error("Fatal API error: %s", exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
