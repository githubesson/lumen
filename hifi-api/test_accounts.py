"""Account reloads and the playback pool, with the pinned hifi dependency stubbed."""

import asyncio
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException


def entry(user_id, refresh_token, **extra):
    return {
        "access_token": "",
        "refresh_token": refresh_token,
        "userID": user_id,
        "client_ID": "client",
        "client_secret": "secret",
        **extra,
    }


def credential(user_id, refresh_token):
    return {
        "client_id": "client",
        "client_secret": "secret",
        "refresh_token": refresh_token,
        "user_id": user_id,
        "access_token": None,
        "expires_at": 0,
    }


_directory = tempfile.TemporaryDirectory()
TOKEN_FILE = Path(_directory.name) / "token.json"
INITIAL_ENTRIES = [entry("1", "playback-1"), entry("9", "catalog-9", role="catalog")]
TOKEN_FILE.write_text(json.dumps(INITIAL_ENTRIES))

hifi = types.ModuleType("main")
hifi.app = FastAPI()
hifi.TOKEN_FILE = str(TOKEN_FILE)
hifi.COUNTRY_CODE = "US"
hifi.USER_AGENT = "test"
hifi.CLIENT_ID = hifi.CLIENT_SECRET = ""
hifi.REFRESH_TOKEN = hifi.USER_ID = None
# What upstream loads from the file above plus one environment credential.
hifi._creds = [credential("1", "playback-1"), credential("5", "environment-5")]
hifi._catalog_cred = credential("9", "catalog-9")
hifi._refresh_locks = {}
hifi.make_request = AsyncMock()
hifi.authed_get_json = AsyncMock()
auth = types.ModuleType("tidal_auth")
auth.tidal_auth = types.SimpleNamespace(
    AUTH_CLIENT_ID="auth-client",
    AUTH_CLIENT_SECRET="auth-secret",
    REQUEST_CLIENT_ID="client",
    REQUEST_CLIENT_SECRET="secret",
)
with patch.dict(sys.modules, {"main": hifi, "tidal_auth": auth}):
    extension = importlib.import_module("lumen_hifi")


def refresh_tokens(credentials):
    return [c["refresh_token"] for c in credentials]


class PlaybackPoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_extension_replaces_upstream_pool(self):
        self.assertIsInstance(hifi._playback_pool, extension.PlaybackPool)

    async def test_each_account_serves_one_request_at_a_time(self):
        a, b = credential("1", "a"), credential("2", "b")
        pool = extension.PlaybackPool([a, b])
        first, second = pool.try_acquire(), pool.try_acquire()
        self.assertEqual({first["refresh_token"], second["refresh_token"]}, {"a", "b"})
        self.assertIsNone(pool.try_acquire())
        pool.release(first)
        self.assertIs(pool.try_acquire(), first)

    async def test_removed_account_is_dropped_on_release(self):
        a, b = credential("1", "a"), credential("2", "b")
        pool = extension.PlaybackPool([a, b])
        leased = pool.try_acquire()
        kept = b if leased is a else a
        pool.replace([kept])
        self.assertEqual(pool.size, 1)
        pool.release(leased)
        self.assertEqual(pool.available, 1)
        self.assertIs(pool.try_acquire(), kept)
        self.assertIsNone(pool.try_acquire())

    async def test_leased_account_that_stays_is_not_doubled(self):
        a = credential("1", "a")
        pool = extension.PlaybackPool([a])
        leased = pool.try_acquire()
        pool.replace([a, credential("2", "b")])
        self.assertEqual(refresh_tokens([pool.try_acquire()]), ["b"])
        self.assertIsNone(pool.try_acquire())
        pool.release(leased)
        self.assertIs(pool.try_acquire(), a)
        self.assertIsNone(pool.try_acquire())

    async def test_new_account_wakes_a_waiting_lease(self):
        a = credential("1", "a")
        pool = extension.PlaybackPool([a])
        leased = pool.try_acquire()

        async def wait_for_slot():
            async with pool.lease() as cred:
                return cred["refresh_token"]

        waiter = asyncio.create_task(wait_for_slot())
        await asyncio.sleep(0)
        self.assertFalse(waiter.done())
        pool.replace([a, credential("2", "b")])
        self.assertEqual(await asyncio.wait_for(waiter, 1), "b")
        pool.release(leased)
        self.assertEqual(pool.available, 2)

    async def test_empty_pool_is_an_error(self):
        pool = extension.PlaybackPool([])
        with self.assertRaises(HTTPException):
            pool.try_acquire()
        with self.assertRaises(HTTPException):
            async with pool.lease():
                pass


class ReloadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        TOKEN_FILE.write_text(json.dumps(INITIAL_ENTRIES))
        extension._reload_runtime_credentials(INITIAL_ENTRIES)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=extension.app), base_url="http://test"
        )

    async def asyncTearDown(self):
        await self.client.aclose()

    def pool_tokens(self):
        pool = hifi._playback_pool
        leased = [pool.try_acquire() for _ in range(pool.available)]
        for cred in leased:
            pool.release(cred)
        return sorted(refresh_tokens(leased))

    async def test_catalog_entry_stays_out_of_playback(self):
        self.assertEqual(refresh_tokens(hifi._creds), ["playback-1", "environment-5"])
        self.assertEqual(hifi._catalog_cred["refresh_token"], "catalog-9")
        self.assertEqual(self.pool_tokens(), ["environment-5", "playback-1"])

    async def test_linked_accounts_keep_their_cached_tokens(self):
        hifi._creds[0]["access_token"] = "cached"
        hifi._refresh_locks["client:playback-1"] = kept = asyncio.Lock()
        hifi._refresh_locks["client:gone"] = asyncio.Lock()
        entries = [*INITIAL_ENTRIES, entry("2", "playback-2")]
        extension._reload_runtime_credentials(entries)
        self.assertEqual(hifi._creds[0]["access_token"], "cached")
        self.assertIs(hifi._refresh_locks["client:playback-1"], kept)
        self.assertNotIn("client:gone", hifi._refresh_locks)
        self.assertEqual(self.pool_tokens(), ["environment-5", "playback-1", "playback-2"])

    async def test_catalog_account_is_listed_and_removable(self):
        response = await self.client.get("/lumen/accounts")
        accounts = {a["user_id"]: a for a in response.json()["accounts"]}
        self.assertEqual(set(accounts), {"1", "5", "9"})
        self.assertTrue(accounts["9"]["removable"])
        self.assertFalse(accounts["5"]["removable"])

        response = await self.client.delete(f"/lumen/accounts/{accounts['9']['id']}")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(hifi._catalog_cred)
        self.assertEqual(json.loads(TOKEN_FILE.read_text()), [INITIAL_ENTRIES[0]])

    async def test_environment_catalog_survives_reload_and_removal(self):
        environment_catalog = credential("7", "environment-catalog")
        with patch.object(extension, "_environment_catalog_credential", environment_catalog):
            extension._reload_runtime_credentials([INITIAL_ENTRIES[0]])
            self.assertEqual(hifi._catalog_cred["refresh_token"], "environment-catalog")
            account_id = extension._account_id(environment_catalog)
            response = await self.client.delete(f"/lumen/accounts/{account_id}")
            self.assertEqual(response.status_code, 409)

    async def test_relinking_the_catalog_account_keeps_its_role(self):
        extension._flows["flow"] = extension.DeviceFlow(
            device_code="device",
            verification_url="https://link.tidal.com/ABCDE",
            user_code="ABCDE",
            expires_at=float("inf"),
            interval=5,
        )
        tidal = types.SimpleNamespace(
            post=AsyncMock(
                return_value=httpx.Response(
                    200,
                    json={"refresh_token": "catalog-9-new", "user": {"userId": 9}},
                )
            )
        )
        with patch.object(hifi, "get_http_client", AsyncMock(return_value=tidal), create=True):
            response = await self.client.get("/lumen/auth/device/flow")
        self.assertEqual(response.json()["state"], "linked")
        saved = json.loads(TOKEN_FILE.read_text())
        self.assertEqual([(e["userID"], e.get("role")) for e in saved], [("1", None), ("9", "catalog")])
        self.assertEqual(hifi._catalog_cred["refresh_token"], "catalog-9-new")
        self.assertEqual(self.pool_tokens(), ["environment-5", "playback-1"])


if __name__ == "__main__":
    unittest.main()
