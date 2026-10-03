"""Exercise the track details route with the pinned hifi dependency stubbed."""

import asyncio
import importlib
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException


TRACK_URL = "https://api.tidal.com/v1/tracks/123"
CREDITS_URL = TRACK_URL + "/credits"
ALBUM_URL = "https://api.tidal.com/v1/albums/77"

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


class TrackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        hifi.get_catalog_token_for_cred = AsyncMock(return_value=("token", {"test": True}))
        self.calls = []
        self.delays = {}
        self.responses = {
            TRACK_URL: {"id": 123, "title": "Song", "copyright": "(P) 2023 Label", "album": {"id": 77, "title": "Album"}},
            CREDITS_URL: [
                {"type": "Producer", "contributors": [{"id": 1, "name": " Maker "}, {"name": "Other"}]},
                {"type": "Composer", "contributors": []},
            ],
            ALBUM_URL: {"id": 77, "title": "Album", "releaseDate": "2023-03-17"},
        }

        async def upstream(url, *, params, token, cred):
            self.assertEqual(token, "token")
            self.assertEqual(cred, {"test": True})
            self.assertEqual(params, {"countryCode": "US"})
            self.calls.append(url)
            if url in self.delays:
                await asyncio.sleep(self.delays[url])
            result = self.responses[url]
            if isinstance(result, BaseException):
                raise result
            return result, token, cred

        hifi.authed_get_json = AsyncMock(side_effect=upstream)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=extension.app), base_url="http://test"
        )

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_combines_track_album_and_credits(self):
        response = await self.client.get("/lumen/track?id=123")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "track": self.responses[TRACK_URL],
                "album": {"releaseDate": "2023-03-17"},
                # Names are trimmed and roles without anyone are dropped.
                "credits": [{"type": "Producer", "names": ["Maker", "Other"]}],
                "failed_sections": [],
            },
        )
        self.assertEqual(sorted(self.calls), sorted([TRACK_URL, CREDITS_URL, ALBUM_URL]))

    async def test_failed_sections_keep_the_track(self):
        for broken in ("album", "credits", "both"):
            with self.subTest(broken=broken):
                self.calls.clear()
                responses = self.responses.copy()
                if broken in ("album", "both"):
                    self.responses[ALBUM_URL] = RuntimeError("upstream secret must not leak")
                if broken in ("credits", "both"):
                    self.responses[CREDITS_URL] = RuntimeError("upstream secret must not leak")
                response = await self.client.get("/lumen/track?id=123")
                self.responses = responses
                self.assertEqual(response.status_code, 200)
                self.assertNotIn("upstream secret", response.text)
                data = response.json()
                self.assertEqual(data["track"]["title"], "Song")
                want = ["album", "credits"] if broken == "both" else [broken]
                self.assertEqual(data["failed_sections"], want)
                self.assertEqual(data["album"] is None, broken in ("album", "both"))
                self.assertEqual(data["credits"] == [], broken in ("credits", "both"))

    async def test_malformed_sections_are_failures(self):
        malformed = {
            CREDITS_URL: (
                {},
                [None],
                [{"type": "Producer"}],
                [{"type": 5, "contributors": []}],
                [{"type": "Producer", "contributors": [{"name": None}]}],
            ),
            ALBUM_URL: (None, [], {"releaseDate": 2023}),
        }
        for url, payloads in malformed.items():
            section = "credits" if url == CREDITS_URL else "album"
            for payload in payloads:
                with self.subTest(section=section, payload=payload):
                    original = self.responses[url]
                    self.responses[url] = payload
                    response = await self.client.get("/lumen/track?id=123")
                    self.responses[url] = original
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["failed_sections"], [section])

    async def test_empty_credits_are_not_a_failure(self):
        self.responses[CREDITS_URL] = []
        response = await self.client.get("/lumen/track?id=123")
        self.assertEqual(response.json()["credits"], [])
        self.assertEqual(response.json()["failed_sections"], [])

    async def test_track_without_album_skips_the_album_lookup(self):
        for album in (None, {}, {"id": None}, {"id": True}, {"id": "../x"}):
            with self.subTest(album=album):
                self.calls.clear()
                self.responses[TRACK_URL] = {"id": 123, "title": "Song", "album": album}
                response = await self.client.get("/lumen/track?id=123")
                self.assertEqual(response.status_code, 200)
                self.assertIsNone(response.json()["album"])
                self.assertEqual(response.json()["failed_sections"], [])
                self.assertNotIn(ALBUM_URL, self.calls)

    async def test_missing_or_malformed_track_is_gateway_error(self):
        for broken in (RuntimeError("upstream secret must not leak"), None, [], {"id": 123}, {"title": "Song"}):
            with self.subTest(broken=broken):
                self.responses[TRACK_URL] = broken
                response = await self.client.get("/lumen/track?id=123")
                self.assertEqual(response.status_code, 502)
                self.assertEqual(response.json(), {"detail": "TIDAL track unavailable"})

    async def test_refused_track_keeps_tidals_reason(self):
        self.responses[TRACK_URL] = HTTPException(status_code=403, detail="Not available in your region")
        response = await self.client.get("/lumen/track?id=123")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json(), {"detail": "Not available in your region"})

    async def test_credits_failure_before_a_track_failure_is_not_left_unread(self):
        self.responses[CREDITS_URL] = RuntimeError("upstream secret must not leak")
        self.responses[TRACK_URL] = RuntimeError("track failed")
        # The credits task has failed by the time the track lookup does.
        self.delays[TRACK_URL] = 0.05
        started = []
        ensure_future = asyncio.ensure_future

        def record(coro, **kwargs):
            task = ensure_future(coro, **kwargs)
            started.append(task)
            return task

        with patch.object(asyncio, "ensure_future", side_effect=record):
            response = await self.client.get("/lumen/track?id=123")
        self.assertEqual(response.status_code, 502)
        await asyncio.sleep(0)
        credits = [t for t in started if t.get_coro().__name__ == "fetch_credits"]
        self.assertEqual(len(credits), 1)
        self.assertTrue(credits[0].done() and not credits[0].cancelled())
        # asyncio logs an exception it finds unread when the task is freed.
        # Cancelling a finished task marks it read (Future.cancel clears the
        # flag before checking the state), so the error never reaches the log.
        self.assertFalse(credits[0]._log_traceback)

    async def test_token_failure_is_gateway_error(self):
        hifi.get_catalog_token_for_cred.side_effect = RuntimeError("private auth error")
        response = await self.client.get("/lumen/track?id=123")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"detail": "TIDAL track unavailable"})
        hifi.authed_get_json.assert_not_awaited()

    async def test_invalid_id_does_not_call_upstream(self):
        response = await self.client.get("/lumen/track?id=0")
        self.assertEqual(response.status_code, 400)
        hifi.get_catalog_token_for_cred.assert_not_awaited()

    async def test_cancellation_is_not_a_failed_section(self):
        self.responses[CREDITS_URL] = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.client.get("/lumen/track?id=123")


if __name__ == "__main__":
    unittest.main()
