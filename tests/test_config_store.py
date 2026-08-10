"""Config document round-trip: the panel writes what the loader reads.

FR-94 says the panel edits *this same schema* — no second format, no
migration. These tests are what keeps that true.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
import yaml

from custom_components.kino.config_store import (
    DEFAULT_DOCUMENT,
    ConfigNotFoundError,
    ConfigStore,
)
from custom_components.kino.core.schema import ConfigErrors


class FakeHassConfig:
    def __init__(self, directory: Path) -> None:
        self._directory = directory

    def path(self, filename: str) -> str:
        return str(self._directory / filename)


class FakeHass:
    """Just enough Home Assistant for the store."""

    def __init__(self, directory: Path) -> None:
        self.config = FakeHassConfig(directory)

    async def async_add_executor_job(self, func, *args):
        return await asyncio.get_running_loop().run_in_executor(None, func, *args)


@pytest.fixture
def store(tmp_path: Path) -> ConfigStore:
    return ConfigStore(FakeHass(tmp_path))


async def test_missing_file_raises_a_named_error(store):
    with pytest.raises(ConfigNotFoundError):
        await store.async_load()


async def test_default_document_is_written_and_loads(store):
    await store.async_write_default()
    config = await store.async_load()

    assert store.path.exists()
    assert config.off_activity == "aus"
    assert "film" in config.activities


async def test_writing_the_default_twice_does_not_clobber_edits(store):
    await store.async_write_default()
    store.path.write_text("version: 1\n# meins\n", encoding="utf-8")

    await store.async_write_default()

    assert "# meins" in store.path.read_text(encoding="utf-8")


async def test_save_round_trips_through_yaml(store):
    document = yaml.safe_load(DEFAULT_DOCUMENT)
    await store.async_save(document)

    reloaded = await store.async_load()

    assert set(reloaded.activities) == set(document["activities"])
    assert reloaded.activities["film"].devices["barco"].settings == {
        "profile": "HDR 260 HDMI"
    }
    assert reloaded.devices["shield"].required is False


async def test_a_panel_edit_survives_the_round_trip(store):
    """The exact path a matrix-editor change takes."""
    document = yaml.safe_load(DEFAULT_DOCUMENT)
    document["activities"]["netflix"]["devices"]["madvr"] = {
        "power": True,
        "profile": 2,
    }
    document["activities"]["film"]["devices"]["madvr"] = {"power": True, "profile": 1}

    await store.async_save(document)
    reloaded = await store.async_load()

    assert reloaded.activities["netflix"].devices["madvr"].settings == {"profile": 2}
    assert reloaded.activities["film"].devices["madvr"].settings == {"profile": 1}


async def test_invalid_document_is_rejected_before_anything_is_written(store):
    """FR-115: a rejected edit leaves the working configuration alone."""
    await store.async_write_default()
    original = store.path.read_text(encoding="utf-8")

    broken: dict[str, Any] = yaml.safe_load(DEFAULT_DOCUMENT)
    broken["activities"]["film"]["devices"]["beamer"] = {"power": True}

    with pytest.raises(ConfigErrors):
        await store.async_save(broken)

    assert store.path.read_text(encoding="utf-8") == original


async def test_save_keeps_a_backup_of_the_previous_file(store):
    await store.async_write_default()
    original = store.path.read_text(encoding="utf-8")

    document = yaml.safe_load(DEFAULT_DOCUMENT)
    document["activities"]["film"]["name"] = "Filme"
    await store.async_save(document)

    backup = store.path.with_suffix(store.path.suffix + ".bak")
    assert backup.exists()
    assert backup.read_text(encoding="utf-8") == original
    assert "Filme" in store.path.read_text(encoding="utf-8")


async def test_saved_file_carries_a_header_explaining_itself(store):
    await store.async_save(yaml.safe_load(DEFAULT_DOCUMENT))

    text = store.path.read_text(encoding="utf-8")
    assert text.startswith("# Kino")
    assert "kino.yaml.bak" in text


async def test_umlauts_survive_the_save(store):
    document = yaml.safe_load(DEFAULT_DOCUMENT)
    document["activities"]["film"]["name"] = "Bibliothek für später"
    await store.async_save(document)

    text = store.path.read_text(encoding="utf-8")
    assert "Bibliothek für später" in text
    reloaded = await store.async_load()
    assert reloaded.activities["film"].name == "Bibliothek für später"


async def test_read_raw_returns_an_unvalidated_document(store):
    """A broken file must still be openable in the editor (FR-110)."""
    store.path.write_text("version: 1\ndevices: {}\nactivities: {}\n", encoding="utf-8")

    document = await store.async_read_raw()

    assert document == {"version": 1, "devices": {}, "activities": {}}
    with pytest.raises(ConfigErrors):
        await store.async_load()


async def test_broken_yaml_is_reported_with_the_file_named(store):
    store.path.write_text("version: 1\n  devices: [oops\n", encoding="utf-8")

    with pytest.raises(ConfigErrors) as excinfo:
        await store.async_read_raw()

    assert "YAML" in str(excinfo.value)
