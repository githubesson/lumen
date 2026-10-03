"""TIDAL's own error explanations replace upstream's fixed detail."""

import importlib
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException


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


def upstream_failure(status, **body):
    """A helper that fails the way upstream's make_request does."""
    request = httpx.Request("GET", "https://api.tidal.com/v1/tracks/1/playbackinfo")
    response = httpx.Response(status, request=request, **body)

    async def request_helper(*args, **kwargs):
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail="Upstream API error")

    return extension._with_tidal_reason(request_helper)


class TidalReasonTests(unittest.IsolatedAsyncioTestCase):
    async def assert_detail(self, helper, status, detail):
        with self.assertRaises(HTTPException) as caught:
            await helper()
        self.assertEqual(caught.exception.status_code, status)
        self.assertEqual(caught.exception.detail, detail)

    async def test_v1_user_message(self):
        helper = upstream_failure(
            403, json={"status": 403, "subStatus": 4035, "userMessage": "  Not available\n in your region "}
        )
        await self.assert_detail(helper, 403, "Not available in your region")

    async def test_v2_error_detail(self):
        helper = upstream_failure(
            403, json={"errors": [{"code": "FORBIDDEN", "detail": "Track is not streamable"}]}
        )
        await self.assert_detail(helper, 403, "Track is not streamable")

    async def test_unexplained_errors_keep_upstream_detail(self):
        for body in ({"text": "<html>Forbidden</html>"}, {"json": ["denied"]}, {"json": {"userMessage": " "}},
                     {"json": {"errors": []}}, {"json": {"userMessage": 5}}):
            with self.subTest(body=body):
                await self.assert_detail(upstream_failure(403, **body), 403, "Upstream API error")

    async def test_long_reasons_are_capped(self):
        helper = upstream_failure(403, json={"userMessage": "x" * 500})
        with self.assertRaises(HTTPException) as caught:
            await helper()
        self.assertEqual(len(caught.exception.detail), 200)

    async def test_other_failures_pass_through(self):
        async def own_failure():
            raise HTTPException(status_code=503, detail="Connection error to Tidal")

        await self.assert_detail(extension._with_tidal_reason(own_failure), 503, "Connection error to Tidal")

    async def test_success_passes_through(self):
        async def ok(value):
            return value

        self.assertEqual(await extension._with_tidal_reason(ok)("payload"), "payload")

    def test_upstream_helpers_are_wrapped(self):
        self.assertTrue(hasattr(hifi.make_request, "__wrapped__"))
        self.assertTrue(hasattr(hifi.authed_get_json, "__wrapped__"))


if __name__ == "__main__":
    unittest.main()
