"""
The artwork signature (FR-42a).

An `<img>` request carries no Authorization header, so the proxy cannot be a
plain authenticated view — the browser answered every poster with 401 and Home
Assistant logged three hundred failed logins for one screen of the library.
The signature is what makes the images loadable without handing the Jellyfin
credential to the browser.
"""

from __future__ import annotations

import time

import pytest

from custom_components.kino.core.signing import ArtworkSigner


@pytest.fixture
def signer() -> ArtworkSigner:
    return ArtworkSigner(ttl_seconds=3600)


def test_a_fresh_signature_verifies(signer):
    assert signer.verify(signer.signature()) is True


def test_the_signature_is_stable_so_the_browser_can_cache(signer):
    assert signer.signature() == signer.signature()


def test_a_tampered_signature_is_rejected(signer):
    expiry, _, digest = signer.signature().partition(".")
    forged = f"{int(expiry) + 86400}.{digest}"

    assert signer.verify(forged) is False


def test_an_expired_signature_is_rejected():
    signer = ArtworkSigner(ttl_seconds=1)
    signature = signer.signature()
    expiry = int(signature.split(".")[0])
    # Re-sign the moment it lapses rather than sleeping through it.
    lapsed = signer._sign(int(time.time()) - 1)

    assert expiry > time.time()
    assert signer.verify(lapsed) is False


@pytest.mark.parametrize("value", [None, "", "nonsense", "abc.def", ".", "123."])
def test_malformed_signatures_are_rejected(signer, value):
    assert signer.verify(value) is False


def test_another_signer_cannot_sign_for_this_one(signer):
    assert signer.verify(ArtworkSigner().signature()) is False
