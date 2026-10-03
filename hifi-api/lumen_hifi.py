"""Lumen's internal account-management extension for the pinned hifi-api.

The upstream service already owns TIDAL credentials and token refresh.  This
module adds a small device-authorization surface to the same ASGI process so
Lumen admins can link and unlink accounts without shell access.  Docker only
exposes this service to the private Compose network; Lumen's backend remains
the authenticated public boundary.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

import main as hifi
from tidal_auth import tidal_auth


app = hifi.app
logger = logging.getLogger("uvicorn.error")

_SCOPE = "r_usr+w_usr+w_sub"
_DEVICE_AUTH_URL = "https://auth.tidal.com/v1/oauth2/device_authorization"
_TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token"
_MAX_PENDING_FLOWS = 8
_flows_lock = asyncio.Lock()
_credentials_lock = asyncio.Lock()


@dataclass
class DeviceFlow:
    device_code: str
    verification_url: str
    user_code: str
    expires_at: float
    interval: float
    next_poll_at: float = 0


_flows: dict[str, DeviceFlow] = {}


def _flow_ref(flow_id: str) -> str:
    """Return a short correlation id without logging the live flow token."""
    return hashlib.sha256(flow_id.encode("utf-8")).hexdigest()[:10]


def _token_path() -> Path:
    return Path(hifi.TOKEN_FILE)


def _read_token_entries() -> list[dict[str, Any]]:
    path = _token_path()
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list):
        raise ValueError("token file must contain an object or array")
    return [entry for entry in value if isinstance(entry, dict)]


def _credential_from_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    refresh_token = entry.get("refresh_token") or hifi.REFRESH_TOKEN
    if not refresh_token:
        return None
    return {
        "client_id": entry.get("client_ID") or hifi.CLIENT_ID,
        "client_secret": entry.get("client_secret") or hifi.CLIENT_SECRET,
        "refresh_token": refresh_token,
        "user_id": entry.get("userID") or hifi.USER_ID,
        "access_token": None,
        "expires_at": 0,
    }


def _account_id(credential: dict[str, Any]) -> str:
    raw = f"{credential.get('client_id', '')}\0{credential.get('refresh_token', '')}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _account(credential: dict[str, Any], removable: bool) -> dict[str, Any]:
    return {
        "id": _account_id(credential),
        "user_id": str(credential.get("user_id") or ""),
        "removable": removable,
    }


def _file_account_ids(entries: list[dict[str, Any]]) -> set[str]:
    ids: set[str] = set()
    for entry in entries:
        credential = _credential_from_entry(entry)
        if credential:
            ids.add(_account_id(credential))
    return ids


def _is_catalog_entry(entry: dict[str, Any]) -> bool:
    # Same test upstream applies when it loads the token file.
    return entry.get("role") == "catalog" or entry.get("catalog") is True


class PlaybackPool:
    """Upstream's one-request-per-account playback pool, resizable at runtime.

    Upstream builds its pool once at import, so linking or removing an account
    would never reach it.  This pool accepts a new credential set while
    requests are in flight: a leased account goes back into rotation on release
    only if it is still linked, and never occupies two slots.
    """

    def __init__(self, credentials: list[dict[str, Any]]):
        self._active: dict[str, dict[str, Any]] = {}
        self._leased: set[str] = set()
        self._available: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.replace(credentials)

    @property
    def size(self) -> int:
        return len(self._active)

    @property
    def available(self) -> int:
        return self._available.qsize()

    def replace(self, credentials: list[dict[str, Any]]) -> None:
        self._active = {_account_id(credential): credential for credential in credentials}
        while not self._available.empty():
            self._available.get_nowait()
        for account_id, credential in self._active.items():
            if account_id not in self._leased:
                self._available.put_nowait(credential)

    def _require_accounts(self) -> None:
        if not self._active:
            raise HTTPException(
                status_code=500,
                detail="No Tidal playback credentials available; populate token.json",
            )

    def try_acquire(self) -> dict[str, Any] | None:
        self._require_accounts()
        try:
            credential = self._available.get_nowait()
        except asyncio.QueueEmpty:
            return None
        self._leased.add(_account_id(credential))
        return credential

    def release(self, credential: dict[str, Any]) -> None:
        account_id = _account_id(credential)
        self._leased.discard(account_id)
        current = self._active.get(account_id)
        if current is not None:
            self._available.put_nowait(current)

    @asynccontextmanager
    async def lease(self) -> AsyncIterator[dict[str, Any]]:
        self._require_accounts()
        credential = await self._available.get()
        self._leased.add(_account_id(credential))
        try:
            yield credential
        finally:
            self.release(credential)


# Upstream resolves _playback_pool on every use, so swapping it here, before
# the app serves anything, routes all playback through the resizable pool.
hifi._playback_pool = PlaybackPool(hifi._creds)


# Preserve credentials supplied exclusively through environment variables when
# the token file changes.  File-backed credentials are rebuilt on every write.
try:
    _initial_entries = _read_token_entries()
except (OSError, ValueError, json.JSONDecodeError):
    _initial_entries = []
_initial_file_ids = _file_account_ids(_initial_entries)
_environment_credentials = [
    dict(credential)
    for credential in hifi._creds
    if _account_id(credential) not in _initial_file_ids
]
_environment_catalog_credential = (
    dict(hifi._catalog_cred)
    if hifi._catalog_cred is not None and _account_id(hifi._catalog_cred) not in _initial_file_ids
    else None
)


def _write_token_entries(entries: list[dict[str, Any]]) -> None:
    path = _token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _reload_runtime_credentials(entries: list[dict[str, Any]]) -> None:
    # Keep the live dicts of accounts that stay linked, so their cached access
    # tokens and refresh locks survive the reload.
    live = {_account_id(credential): credential for credential in hifi._creds}
    if hifi._catalog_cred is not None:
        live[_account_id(hifi._catalog_cred)] = hifi._catalog_cred

    credentials: list[dict[str, Any]] = []
    catalog: dict[str, Any] | None = None
    seen: set[str] = set()
    for entry in entries:
        credential = _credential_from_entry(entry)
        if not credential:
            continue
        account_id = _account_id(credential)
        credential = live.get(account_id, credential)
        if _is_catalog_entry(entry):
            # Upstream uses the first catalog entry and ignores the rest.
            if catalog is None:
                catalog = credential
        elif account_id not in seen:
            credentials.append(credential)
            seen.add(account_id)
    for environment_credential in _environment_credentials:
        account_id = _account_id(environment_credential)
        if account_id not in seen:
            credentials.append(live.get(account_id) or dict(environment_credential))
            seen.add(account_id)
    if catalog is None and _environment_catalog_credential is not None:
        account_id = _account_id(_environment_catalog_credential)
        catalog = live.get(account_id) or dict(_environment_catalog_credential)
    if catalog is not None:
        # As upstream does: the catalog account never doubles as a playback slot.
        credentials = [
            credential
            for credential in credentials
            if credential["refresh_token"] != catalog["refresh_token"]
        ]

    # Assignment is atomic in CPython, so in-flight request selection sees
    # either the old complete list or the new complete list.
    hifi._creds = credentials
    hifi._catalog_cred = catalog
    hifi._playback_pool.replace(credentials)
    kept_locks = {
        f"{credential['client_id']}:{credential['refresh_token']}"
        for credential in [*credentials, *([catalog] if catalog else [])]
    }
    for key in list(hifi._refresh_locks):
        if key not in kept_locks:
            hifi._refresh_locks.pop(key, None)
    if credentials:
        hifi.CLIENT_ID = credentials[0]["client_id"]
        hifi.CLIENT_SECRET = credentials[0]["client_secret"]
        hifi.REFRESH_TOKEN = credentials[0]["refresh_token"]
        hifi.USER_ID = credentials[0]["user_id"]
    else:
        hifi.CLIENT_ID = ""
        hifi.CLIENT_SECRET = ""
        hifi.REFRESH_TOKEN = None
        hifi.USER_ID = None


def _iso_timestamp(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def _auth_headers() -> dict[str, str]:
    return {
        "User-Agent": hifi.USER_AGENT,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Platform": "android",
    }


async def _tidal_client() -> httpx.AsyncClient:
    return await hifi.get_http_client()


async def _cleanup_flows(now: float) -> None:
    expired = [flow_id for flow_id, flow in _flows.items() if flow.expires_at <= now]
    for flow_id in expired:
        _flows.pop(flow_id, None)


def _normalize_verification_url(value: Any) -> str:
    raw_url = str(value or "").strip()
    if not raw_url:
        return ""
    candidate = raw_url if "://" in raw_url else f"https://{raw_url.lstrip('/')}"
    parsed = urlsplit(candidate)
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (
        hostname == "tidal.com" or hostname.endswith(".tidal.com")
    ):
        return ""
    return candidate


@app.get("/lumen/accounts")
async def list_lumen_accounts() -> dict[str, Any]:
    try:
        entries = _read_token_entries()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.exception(
            "Lumen TIDAL account list failed token_file=%s",
            _token_path(),
        )
        raise HTTPException(status_code=500, detail="Could not read the TIDAL token file") from exc
    removable_ids = _file_account_ids(entries)
    # A catalog account (token.json "role": "catalog") is kept out of playback
    # rotation but is still linked, so it is listed and removable too.
    credentials = [*hifi._creds, *([hifi._catalog_cred] if hifi._catalog_cred else [])]
    return {
        "accounts": [
            _account(credential, _account_id(credential) in removable_ids)
            for credential in credentials
        ]
    }


@app.post("/lumen/auth/device")
async def start_lumen_device_auth() -> dict[str, Any]:
    now = time.time()
    async with _flows_lock:
        await _cleanup_flows(now)
        if len(_flows) >= _MAX_PENDING_FLOWS:
            raise HTTPException(status_code=429, detail="Too many pending TIDAL sign-ins")

    try:
        client = await _tidal_client()
        response = await client.post(
            _DEVICE_AUTH_URL,
            data={"client_id": tidal_auth.AUTH_CLIENT_ID, "scope": _SCOPE},
            headers=_auth_headers(),
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.exception("Lumen TIDAL device authorization request failed")
        raise HTTPException(status_code=502, detail="TIDAL did not start device authorization") from exc

    device_code = str(payload.get("deviceCode") or "")
    verification_url = _normalize_verification_url(
        payload.get("verificationUriComplete") or payload.get("verificationUri") or ""
    )
    user_code = str(payload.get("userCode") or "")
    if not device_code or not verification_url:
        logger.error(
            "Lumen TIDAL device authorization response incomplete device_code=%s verification_url=%s",
            bool(device_code),
            bool(verification_url),
        )
        raise HTTPException(status_code=502, detail="TIDAL returned an incomplete authorization response")

    try:
        expires_in = min(max(float(payload.get("expiresIn", 300)), 30), 1800)
        interval = min(max(float(payload.get("interval", 5)), 1), 30)
    except (TypeError, ValueError):
        expires_in, interval = 300, 5
    flow_id = secrets.token_urlsafe(24)
    flow = DeviceFlow(
        device_code=device_code,
        verification_url=verification_url,
        user_code=user_code,
        expires_at=now + expires_in,
        interval=interval,
    )
    async with _flows_lock:
        await _cleanup_flows(time.time())
        if len(_flows) >= _MAX_PENDING_FLOWS:
            raise HTTPException(status_code=429, detail="Too many pending TIDAL sign-ins")
        _flows[flow_id] = flow

    logger.info(
        "Lumen TIDAL device authorization started flow=%s expires_in=%ds interval=%ds",
        _flow_ref(flow_id),
        int(expires_in),
        int(interval),
    )

    return {
        "flow_id": flow_id,
        "verification_url": verification_url,
        "user_code": user_code,
        "expires_at": _iso_timestamp(flow.expires_at),
    }


@app.get("/lumen/auth/device/{flow_id}")
async def poll_lumen_device_auth(flow_id: str) -> dict[str, Any]:
    now = time.time()
    async with _flows_lock:
        flow = _flows.get(flow_id)
        if not flow:
            logger.warning(
                "Lumen TIDAL authorization poll missing flow=%s",
                _flow_ref(flow_id),
            )
            raise HTTPException(status_code=404, detail="TIDAL sign-in was not found")
        if flow.expires_at <= now:
            _flows.pop(flow_id, None)
            logger.info(
                "Lumen TIDAL authorization expired flow=%s",
                _flow_ref(flow_id),
            )
            return {"state": "expired", "message": "The TIDAL sign-in expired"}
        if flow.next_poll_at > now:
            return {"state": "pending"}
        flow.next_poll_at = now + flow.interval

    try:
        client = await _tidal_client()
        response = await client.post(
            _TOKEN_URL,
            data={
                "client_id": tidal_auth.AUTH_CLIENT_ID,
                "scope": _SCOPE,
                "device_code": flow.device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            auth=(tidal_auth.AUTH_CLIENT_ID, tidal_auth.AUTH_CLIENT_SECRET),
            headers=_auth_headers(),
        )
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.exception(
            "Lumen TIDAL token poll request failed flow=%s",
            _flow_ref(flow_id),
        )
        raise HTTPException(status_code=502, detail="TIDAL sign-in could not be checked") from exc

    if response.status_code != 200:
        error = str(payload.get("error") or "")
        if error == "authorization_pending":
            return {"state": "pending"}
        if error == "slow_down":
            logger.warning(
                "Lumen TIDAL requested slower polling flow=%s",
                _flow_ref(flow_id),
            )
            async with _flows_lock:
                current = _flows.get(flow_id)
                if current:
                    current.interval = min(current.interval + 5, 30)
            return {"state": "pending"}
        if error in {"access_denied", "authorization_declined"}:
            async with _flows_lock:
                _flows.pop(flow_id, None)
            logger.info(
                "Lumen TIDAL authorization denied flow=%s error=%s",
                _flow_ref(flow_id),
                error,
            )
            return {"state": "denied", "message": "TIDAL sign-in was declined"}
        if error in {"expired_token", "invalid_grant"}:
            async with _flows_lock:
                _flows.pop(flow_id, None)
            logger.info(
                "Lumen TIDAL authorization expired flow=%s error=%s",
                _flow_ref(flow_id),
                error,
            )
            return {"state": "expired", "message": "The TIDAL sign-in expired"}
        logger.error(
            "Lumen TIDAL token poll rejected flow=%s status=%d error=%s",
            _flow_ref(flow_id),
            response.status_code,
            error or "unknown",
        )
        raise HTTPException(status_code=502, detail="TIDAL rejected the sign-in check")

    refresh_token = str(payload.get("refresh_token") or "")
    access_token = str(payload.get("access_token") or "")
    user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    user_id = str(user.get("userId") or payload.get("user_id") or "")
    if not refresh_token or not user_id:
        logger.error(
            "Lumen TIDAL token response incomplete flow=%s refresh_token=%s user_id=%s",
            _flow_ref(flow_id),
            bool(refresh_token),
            bool(user_id),
        )
        raise HTTPException(status_code=502, detail="TIDAL returned incomplete account credentials")

    logger.info(
        "Lumen TIDAL authorization approved flow=%s user_id=%s; saving credentials",
        _flow_ref(flow_id),
        user_id,
    )

    entry = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "userID": user_id,
        "client_ID": tidal_auth.REQUEST_CLIENT_ID,
        "client_secret": tidal_auth.REQUEST_CLIENT_SECRET,
    }
    async with _credentials_lock:
        try:
            entries = _read_token_entries()
            # Relinking a user replaces that user's old refresh token while
            # preserving every other linked account and the user's role.
            replaced = [item for item in entries if str(item.get("userID") or "") == user_id]
            if any(_is_catalog_entry(item) for item in replaced):
                entry["role"] = "catalog"
            entries = [item for item in entries if str(item.get("userID") or "") != user_id]
            entries.append(entry)
            _write_token_entries(entries)
            _reload_runtime_credentials(entries)
        except Exception as exc:
            logger.exception(
                "Lumen TIDAL credential save failed flow=%s user_id=%s token_file=%s",
                _flow_ref(flow_id),
                user_id,
                _token_path(),
            )
            raise HTTPException(status_code=500, detail="Could not save the TIDAL account") from exc

    credential = _credential_from_entry(entry)
    async with _flows_lock:
        _flows.pop(flow_id, None)
    account = _account(credential, True)
    logger.info(
        "Lumen TIDAL account linked flow=%s user_id=%s account_id=%s",
        _flow_ref(flow_id),
        user_id,
        account["id"],
    )
    return {"state": "linked", "account": account}


@app.delete("/lumen/accounts/{account_id}")
async def remove_lumen_account(account_id: str) -> dict[str, Any]:
    async with _credentials_lock:
        try:
            entries = _read_token_entries()
            kept: list[dict[str, Any]] = []
            found = False
            for entry in entries:
                credential = _credential_from_entry(entry)
                if credential and _account_id(credential) == account_id:
                    found = True
                    continue
                kept.append(entry)
            if not found:
                environment_ids = {_account_id(credential) for credential in _environment_credentials}
                if _environment_catalog_credential is not None:
                    environment_ids.add(_account_id(_environment_catalog_credential))
                if account_id in environment_ids:
                    raise HTTPException(
                        status_code=409,
                        detail="This TIDAL account is configured through the environment",
                    )
                raise HTTPException(status_code=404, detail="TIDAL account was not found")
            _write_token_entries(kept)
            _reload_runtime_credentials(kept)
        except HTTPException:
            raise
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            logger.exception(
                "Lumen TIDAL account removal failed account_id=%s token_file=%s",
                account_id,
                _token_path(),
            )
            raise HTTPException(status_code=500, detail="Could not update the TIDAL token file") from exc
    logger.info("Lumen TIDAL account removed account_id=%s", account_id)
    return {"removed": True}


@app.get("/lumen/search/{kind}")
async def search_lumen_catalog(kind: str, q: str, limit: int = 25, offset: int = 0):
    """Search a full entity collection instead of the capped, mixed top hits."""
    if kind not in {"albums", "artists"}:
        raise HTTPException(status_code=400, detail="Unsupported search type")
    if not 1 <= limit <= 50 or offset < 0:
        raise HTTPException(status_code=400, detail="Invalid search pagination")
    return await hifi.make_request(
        f"https://api.tidal.com/v1/search/{kind}",
        params={"query": q, "limit": limit, "offset": offset, "countryCode": hifi.COUNTRY_CODE},
    )


@app.get("/lumen/artist")
async def get_lumen_artist(id: int):
    """Bounded artist results with explicit failures for each upstream section.

    The pinned upstream /artist handler hides failures as empty lists. Keep
    successful sections here, report failed_sections on partial success, and
    return 502 if none of the three requests succeeded.

    The profile (name and picture) is decoration for the release sections, so
    a failed profile lookup becomes ``artist: null`` instead of a failed
    section; backends that reject unknown section names keep working.
    """
    if id <= 0:
        raise HTTPException(status_code=400, detail="Invalid artist ID")
    try:
        token, cred = await hifi.get_catalog_token_for_cred()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="TIDAL artist unavailable") from exc

    async def fetch_section(endpoint: str, **params):
        data, _, _ = await hifi.authed_get_json(
            f"https://api.tidal.com/v1/artists/{id}/{endpoint}",
            params={"countryCode": hifi.COUNTRY_CODE, **params},
            token=token,
            cred=cred,
        )
        items = data.get("items") if isinstance(data, dict) else data
        if not isinstance(items, list) or any(
            not isinstance(item, dict)
            or not isinstance(item.get("id"), (int, str))
            or not item.get("id")
            or not isinstance(item.get("title"), str)
            or not item.get("title")
            for item in items
        ):
            raise ValueError("Invalid TIDAL artist section")
        return items

    async def fetch_profile():
        data, _, _ = await hifi.authed_get_json(
            f"https://api.tidal.com/v1/artists/{id}",
            params={"countryCode": hifi.COUNTRY_CODE},
            token=token,
            cred=cred,
        )
        if not isinstance(data, dict):
            raise ValueError("Invalid TIDAL artist profile")
        name, picture = data.get("name"), data.get("picture")
        if not isinstance(name, str) or not name or not (picture is None or isinstance(picture, str)):
            raise ValueError("Invalid TIDAL artist profile")
        return {"name": name, "picture": picture}

    sections = ("albums", "singles", "tracks")
    *results, profile = await asyncio.gather(
        fetch_section("albums", limit=100),
        fetch_section("albums", limit=100, filter="EPSANDSINGLES"),
        fetch_section("toptracks", limit=15),
        fetch_profile(),
        return_exceptions=True,
    )
    if isinstance(profile, BaseException):
        if isinstance(profile, asyncio.CancelledError):
            raise profile
        logger.warning("Lumen TIDAL artist profile unavailable artist=%s", id)
        profile = None
    failed_sections = []
    releases = []
    tracks = []
    seen_ids = set()
    for section, result in zip(sections, results):
        if isinstance(result, BaseException):
            if isinstance(result, asyncio.CancelledError):
                raise result
            logger.warning("Lumen TIDAL artist section unavailable artist=%s section=%s", id, section)
            failed_sections.append(section)
            continue
        if section == "tracks":
            tracks = result
        else:
            for item in result:
                release_id = str(item["id"])
                if release_id not in seen_ids:
                    releases.append(item)
                    seen_ids.add(release_id)
    if len(failed_sections) == len(sections):
        raise HTTPException(status_code=502, detail="TIDAL artist unavailable")
    return {
        "artist": profile,
        "albums": {"items": releases},
        "tracks": tracks,
        "failed_sections": failed_sections,
    }


@app.get("/lumen/track")
async def get_lumen_track(id: int):
    """One track's catalog details for Lumen's track info view.

    The upstream /info/ route returns only the track, whose album stub has no
    release date, and nothing upstream exposes credits. This fetches the
    track, its credits and its album with one catalog token. The track is
    required (502 without it). A failed credits or album lookup is listed in
    failed_sections, so an empty credit list still means TIDAL has none.
    """
    if id <= 0:
        raise HTTPException(status_code=400, detail="Invalid track ID")
    try:
        token, cred = await hifi.get_catalog_token_for_cred()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="TIDAL track unavailable") from exc

    async def fetch(path: str):
        data, _, _ = await hifi.authed_get_json(
            f"https://api.tidal.com/v1/{path}",
            params={"countryCode": hifi.COUNTRY_CODE},
            token=token,
            cred=cred,
        )
        return data

    async def fetch_credits():
        data = await fetch(f"tracks/{id}/credits")
        if not isinstance(data, list):
            raise ValueError("Invalid TIDAL track credits")
        credits = []
        for credit in data:
            if not isinstance(credit, dict):
                raise ValueError("Invalid TIDAL track credits")
            role, contributors = credit.get("type"), credit.get("contributors")
            if not isinstance(role, str) or not isinstance(contributors, list):
                raise ValueError("Invalid TIDAL track credits")
            names = [c.get("name") if isinstance(c, dict) else None for c in contributors]
            if not all(isinstance(name, str) for name in names):
                raise ValueError("Invalid TIDAL track credits")
            names = [name.strip() for name in names if name.strip()]
            if role.strip() and names:
                credits.append({"type": role.strip(), "names": names})
        return credits

    async def fetch_album(album_id):
        data = await fetch(f"albums/{album_id}")
        release_date = data.get("releaseDate") if isinstance(data, dict) else None
        if not isinstance(data, dict) or not (release_date is None or isinstance(release_date, str)):
            raise ValueError("Invalid TIDAL album")
        return {"releaseDate": release_date}

    async def no_album():
        return None

    credits_task = asyncio.ensure_future(fetch_credits())
    try:
        track = await fetch(f"tracks/{id}")
        title = track.get("title") if isinstance(track, dict) else None
        if not isinstance(track, dict) or not track.get("id") or not isinstance(title, str) or not title:
            raise ValueError("Invalid TIDAL track")
    except asyncio.CancelledError:
        credits_task.cancel()
        raise
    except Exception as exc:
        credits_task.cancel()
        logger.warning("Lumen TIDAL track unavailable track=%s", id)
        raise HTTPException(status_code=502, detail="TIDAL track unavailable") from exc

    album = track.get("album")
    album_id = album.get("id") if isinstance(album, dict) else None
    has_album = isinstance(album_id, (int, str)) and not isinstance(album_id, bool) and str(album_id).isdigit()
    album, credits = await asyncio.gather(
        fetch_album(album_id) if has_album else no_album(),
        credits_task,
        return_exceptions=True,
    )
    failed_sections = []
    for section, result in (("album", album), ("credits", credits)):
        if isinstance(result, BaseException):
            if isinstance(result, asyncio.CancelledError):
                raise result
            logger.warning("Lumen TIDAL track section unavailable track=%s section=%s", id, section)
            failed_sections.append(section)
    return {
        "track": track,
        "album": None if isinstance(album, BaseException) else album,
        "credits": [] if isinstance(credits, BaseException) else credits,
        "failed_sections": failed_sections,
    }
