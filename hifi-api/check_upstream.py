"""Check lumen_hifi against a checkout of the pinned upstream hifi-api.

The unit tests stub upstream, so they can't notice when a pin bump renames
an internal the extension reads or patches. Assigning to a missing module
attribute doesn't fail either, so this asserts the names exist before
importing the extension.

    python check_upstream.py /path/to/hifi-api-checkout
"""

import sys
from pathlib import Path

MAIN_NAMES = [
    "app",
    "authed_get_json",
    "make_request",
    "get_catalog_token_for_cred",
    "get_http_client",
    "_playback_pool",
    "_creds",
    "_catalog_cred",
    "_refresh_locks",
    "CLIENT_ID",
    "CLIENT_SECRET",
    "REFRESH_TOKEN",
    "USER_ID",
    "COUNTRY_CODE",
    "TOKEN_FILE",
    "USER_AGENT",
]

TIDAL_AUTH_NAMES = [
    "AUTH_CLIENT_ID",
    "AUTH_CLIENT_SECRET",
    "REQUEST_CLIENT_ID",
    "REQUEST_CLIENT_SECRET",
]


def main() -> int:
    upstream = Path(sys.argv[1]).resolve()
    sys.path[:0] = [str(upstream), str(Path(__file__).resolve().parent)]

    import main as hifi
    from tidal_auth import tidal_auth

    missing = [f"main.{name}" for name in MAIN_NAMES if not hasattr(hifi, name)]
    missing += [f"tidal_auth.{name}" for name in TIDAL_AUTH_NAMES if not hasattr(tidal_auth, name)]
    if missing:
        print("upstream no longer has: " + ", ".join(missing), file=sys.stderr)
        return 1

    import lumen_hifi

    if not isinstance(hifi._playback_pool, lumen_hifi.PlaybackPool):
        print("lumen_hifi did not install its playback pool", file=sys.stderr)
        return 1
    if lumen_hifi.app is not hifi.app:
        print("lumen_hifi.app is not upstream's app", file=sys.stderr)
        return 1
    print("lumen_hifi matches the pinned upstream")
    return 0


if __name__ == "__main__":
    sys.exit(main())
