"""Exercise the real extension route with the pinned hifi dependency stubbed."""

import asyncio
import importlib
import itertools
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException


PROFILE_URL = "https://api.tidal.com/v1/artists/123"

hifi = types.ModuleType("main")
hifi.app = FastAPI()
hifi.TOKEN_FILE = "/nonexistent/lumen-test-token.json"
hifi._creds = []
hifi._catalog_cred = None
hifi._refresh_locks = {}
hifi.COUNTRY_CODE = "US"
hifi.make_request = AsyncMock()
hifi.authed_get_json = AsyncMock()
auth = types.ModuleType("tidal_auth")
auth.tidal_auth = types.SimpleNamespace()
with patch.dict(sys.modules, {"main": hifi, "tidal_auth": auth}):
    extension = importlib.import_module("lumen_hifi")


class ArtistTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        hifi.get_catalog_token_for_cred = AsyncMock(return_value=("token", {"test": True}))
        self.calls = []
        self.responses = {
            "albums": {"items": [{"id": 1, "title": "Album"}]},
            "singles": {"items": [{"id": 2, "title": "Single"}]},
            "tracks": {"items": [{"id": 3, "title": "Song"}]},
        }
        self.profile = {"id": 123, "name": "Artist", "picture": "a-b-c", "popularity": 9}

        async def upstream(url, *, params, token, cred):
            self.assertEqual(token, "token")
            self.assertEqual(cred, {"test": True})
            self.assertEqual(params["countryCode"], "US")
            self.calls.append((url, params))
            if url == PROFILE_URL:
                self.assertNotIn("limit", params)
                result = self.profile
            else:
                section = "tracks" if url.endswith("/toptracks") else "singles" if params.get("filter") else "albums"
                self.assertEqual(params["limit"], 15 if section == "tracks" else 100)
                result = self.responses[section]
            if isinstance(result, BaseException):
                raise result
            return result, token, cred

        hifi.authed_get_json = AsyncMock(side_effect=upstream)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=extension.app), base_url="http://test"
        )

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_every_combination_of_upstream_failures(self):
        originals = self.responses.copy()
        for failed in itertools.product((False, True), repeat=3):
            with self.subTest(failed=failed):
                self.responses = {
                    section: RuntimeError("upstream secret must not leak") if failure else originals[section]
                    for section, failure in zip(originals, failed)
                }
                response = await self.client.get("/lumen/artist?id=123")
                self.assertNotIn("upstream secret", response.text)
                if all(failed):
                    self.assertEqual(response.status_code, 502)
                    continue
                self.assertEqual(response.status_code, 200)
                data = response.json()
                self.assertEqual(data["failed_sections"], [s for s, f in zip(originals, failed) if f])
                self.assertEqual(len(data["albums"]["items"]), sum(not f for f in failed[:2]))
                self.assertEqual(len(data["tracks"]), int(not failed[2]))
        self.assertEqual(len(self.calls), 32)
        self.assertTrue(all(url == PROFILE_URL or url.startswith(PROFILE_URL + "/") for url, _ in self.calls))

    async def test_successful_empty_is_distinct_from_incomplete_empty(self):
        self.responses = {s: {"items": []} for s in self.responses}
        response = await self.client.get("/lumen/artist?id=123")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "artist": {"name": "Artist", "picture": "a-b-c"},
                "albums": {"items": []},
                "tracks": [],
                "failed_sections": [],
            },
        )
        self.responses["albums"] = RuntimeError("failed")
        response = await self.client.get("/lumen/artist?id=123")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["failed_sections"], ["albums"])

    async def test_malformed_sections_are_failures(self):
        for malformed in ({}, {"items": None}, {"error": "failed"}, {"items": [None]}, {"items": [{"id": 1}]}):
            with self.subTest(malformed=malformed):
                self.responses["albums"] = malformed
                response = await self.client.get("/lumen/artist?id=123")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["failed_sections"], ["albums"])

    async def test_profile_is_trimmed_to_name_and_picture(self):
        response = await self.client.get("/lumen/artist?id=123")
        self.assertEqual(response.json()["artist"], {"name": "Artist", "picture": "a-b-c"})
        self.profile = {"name": "No picture", "picture": None}
        response = await self.client.get("/lumen/artist?id=123")
        self.assertEqual(response.json()["artist"], {"name": "No picture", "picture": None})

    async def test_profile_failure_is_not_a_failed_section(self):
        broken_profiles = (
            RuntimeError("upstream secret must not leak"),
            None,
            [],
            {"name": ""},
            {"picture": "a-b-c"},
            {"name": "Artist", "picture": 5},
        )
        for broken in broken_profiles:
            with self.subTest(broken=broken):
                self.profile = broken
                response = await self.client.get("/lumen/artist?id=123")
                self.assertEqual(response.status_code, 200)
                self.assertNotIn("upstream secret", response.text)
                data = response.json()
                self.assertIsNone(data["artist"])
                self.assertEqual(data["failed_sections"], [])
                self.assertEqual(len(data["tracks"]), 1)

    async def test_profile_alone_does_not_rescue_total_failure(self):
        self.responses = {section: RuntimeError("failed") for section in self.responses}
        response = await self.client.get("/lumen/artist?id=123")
        self.assertEqual(response.status_code, 502)

    async def test_total_refusal_keeps_tidals_reason(self):
        self.responses = {section: RuntimeError("failed") for section in self.responses}
        self.responses["singles"] = HTTPException(status_code=403, detail="Not available in your region")
        response = await self.client.get("/lumen/artist?id=123")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"detail": "Not available in your region"})

    async def test_deduplicates_releases_and_accepts_list_payloads(self):
        self.responses["singles"] = [{"id": "1", "title": "Album"}, {"id": 2, "title": "Single"}]
        response = await self.client.get("/lumen/artist?id=123")
        self.assertEqual([i["id"] for i in response.json()["albums"]["items"]], [1, 2])

    async def test_token_failure_is_gateway_error(self):
        hifi.get_catalog_token_for_cred.side_effect = RuntimeError("private auth error")
        response = await self.client.get("/lumen/artist?id=123")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "TIDAL artist unavailable"})
        hifi.authed_get_json.assert_not_awaited()

    async def test_invalid_id_does_not_call_upstream(self):
        response = await self.client.get("/lumen/artist?id=0")
        self.assertEqual(response.status_code, 400)
        hifi.get_catalog_token_for_cred.assert_not_awaited()

    async def test_cancellation_is_not_an_empty_success(self):
        self.responses["albums"] = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.client.get("/lumen/artist?id=123")

    async def test_profile_cancellation_is_not_a_missing_profile(self):
        self.profile = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.client.get("/lumen/artist?id=123")


if __name__ == "__main__":
    unittest.main()
