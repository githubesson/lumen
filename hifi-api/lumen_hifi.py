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
import os
import secrets
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

import main as hifi
from tidal_auth import tidal_auth


app = hifi.app

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
    credentials: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        credential = _credential_from_entry(entry)
        if not credential:
            continue
        account_id = _account_id(credential)
        if account_id not in seen:
            credentials.append(credential)
            seen.add(account_id)
    for environment_credential in _environment_credentials:
        account_id = _account_id(environment_credential)
        if account_id not in seen:
            credentials.append(dict(environment_credential))
            seen.add(account_id)

    # Assignment is atomic in CPython, so in-flight request selection sees
    # either the old complete list or the new complete list.
    hifi._creds = credentials
    hifi._refresh_locks.clear()
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
        raise HTTPException(status_code=500, detail="Could not read the TIDAL token file") from exc
    removable_ids = _file_account_ids(entries)
    return {
        "accounts": [
            _account(credential, _account_id(credential) in removable_ids)
            for credential in hifi._creds
        ]
    }


@app.post("/lumen/auth/device")
async def start_lumen_device_auth() -> dict[str, Any]:
    now = time.time()
    async with _flows_lock:
        await _cleanup_flows(now)
        if len(_flows) >= _MAX_PENDING_FLOWS:
            raise HTTPException(status_code=429, detail="Too many pending TIDAL sign-ins")

    client = await _tidal_client()
    try:
        response = await client.post(
            _DEVICE_AUTH_URL,
            data={"client_id": tidal_auth.AUTH_CLIENT_ID, "scope": _SCOPE},
            headers=_auth_headers(),
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="TIDAL did not start device authorization") from exc

    device_code = str(payload.get("deviceCode") or "")
    verification_url = _normalize_verification_url(
        payload.get("verificationUriComplete") or payload.get("verificationUri") or ""
    )
    user_code = str(payload.get("userCode") or "")
    if not device_code or not verification_url:
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
            raise HTTPException(status_code=404, detail="TIDAL sign-in was not found")
        if flow.expires_at <= now:
            _flows.pop(flow_id, None)
            return {"state": "expired", "message": "The TIDAL sign-in expired"}
        if flow.next_poll_at > now:
            return {"state": "pending"}
        flow.next_poll_at = now + flow.interval

    client = await _tidal_client()
    try:
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
        raise HTTPException(status_code=502, detail="TIDAL sign-in could not be checked") from exc

    if response.status_code != 200:
        error = str(payload.get("error") or "")
        if error == "authorization_pending":
            return {"state": "pending"}
        if error == "slow_down":
            async with _flows_lock:
                current = _flows.get(flow_id)
                if current:
                    current.interval = min(current.interval + 5, 30)
            return {"state": "pending"}
        if error in {"access_denied", "authorization_declined"}:
            async with _flows_lock:
                _flows.pop(flow_id, None)
            return {"state": "denied", "message": "TIDAL sign-in was declined"}
        if error in {"expired_token", "invalid_grant"}:
            async with _flows_lock:
                _flows.pop(flow_id, None)
            return {"state": "expired", "message": "The TIDAL sign-in expired"}
        raise HTTPException(status_code=502, detail="TIDAL rejected the sign-in check")

    refresh_token = str(payload.get("refresh_token") or "")
    access_token = str(payload.get("access_token") or "")
    user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    user_id = str(user.get("userId") or payload.get("user_id") or "")
    if not refresh_token or not user_id:
        raise HTTPException(status_code=502, detail="TIDAL returned incomplete account credentials")

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
            # preserving every other linked account.
            entries = [item for item in entries if str(item.get("userID") or "") != user_id]
            entries.append(entry)
            _write_token_entries(entries)
            _reload_runtime_credentials(entries)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=500, detail="Could not save the TIDAL account") from exc

    credential = _credential_from_entry(entry)
    async with _flows_lock:
        _flows.pop(flow_id, None)
    return {"state": "linked", "account": _account(credential, True)}


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
                if any(_account_id(credential) == account_id for credential in _environment_credentials):
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
            raise HTTPException(status_code=500, detail="Could not update the TIDAL token file") from exc
    return {"removed": True}
