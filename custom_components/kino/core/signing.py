"""
The artwork read signature (FR-42a).

The card loads posters through an ``<img>`` tag, and an image request carries
no `Authorization` header — Home Assistant's frontend authenticates with bearer
tokens, not cookies. A `requires_auth` proxy therefore answers every poster with
401 and fills the log with failed-login warnings.

So the card is handed one short-lived signature with its state payload and
appends it to every image URL. It grants nothing but "may read artwork",
expires, and is thrown away on restart; the Jellyfin credential still never
leaves the server.

No Home Assistant import, so the whole thing is unit-testable (NFR-6).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time

SIGNATURE_TTL_SECONDS = 12 * 3600


class ArtworkSigner:
    """Issues and verifies the artwork read signature."""

    def __init__(self, ttl_seconds: int = SIGNATURE_TTL_SECONDS) -> None:
        self._secret = secrets.token_bytes(32)
        self._ttl = ttl_seconds
        self._current: str | None = None
        self._expires_at = 0.0

    def _sign(self, expiry: int) -> str:
        digest = hmac.new(
            self._secret, str(expiry).encode("ascii"), hashlib.sha256
        ).hexdigest()
        return f"{expiry}.{digest}"

    def signature(self) -> str:
        """Return the current signature, reissuing it past its half-life.

        Keeping one string stable for hours matters: the URL is the browser's
        cache key, so a signature that changed on every state poll would
        re-download every poster in the grid.
        """
        now = time.time()
        if self._current is None or now > self._expires_at - self._ttl / 2:
            expiry = int(now + self._ttl)
            self._current = self._sign(expiry)
            self._expires_at = float(expiry)
        return self._current

    def verify(self, signature: str | None) -> bool:
        """Return True for a signature this signer issued and that still holds."""
        if not signature or "." not in signature:
            return False
        raw_expiry, _, _digest = signature.partition(".")
        try:
            expiry = int(raw_expiry)
        except ValueError:
            return False
        if expiry < time.time():
            return False
        return hmac.compare_digest(self._sign(expiry), signature)
