"""
Formal schema and validation for the Kino config document (FR-91, FR-92).

The schema is the contract. The admin panel, when it arrives, is only an
editor over exactly this document (FR-94), so validation lives here rather
than in the Home Assistant layer and carries no HA imports.

Every error names the offending activity, device and field so a typo fails
loudly and specifically instead of silently falling back (A17).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .model import (
    ActivityDef,
    ControlClass,
    DeviceRequirement,
    DeviceSpec,
    KinoConfig,
    PowerTarget,
)

SCHEMA_VERSION = 1

KNOWN_DRIVERS = frozenset({"barco", "trinnov", "zidoo", "madvr", "generic"})

_DEVICE_KEYS = frozenset(
    {
        "driver",
        "name",
        "entities",
        "unverifiable_settings",
        "depends_on",
        "startup_timeout",
        "shutdown_timeout",
        "reconfigure_timeout",
        "default_startup_seconds",
        "default_shutdown_seconds",
        "required",
        "is_media",
        "options",
    }
)

_ACTIVITY_KEYS = frozenset(
    {
        "name",
        "devices",
        "control_class",
        "media",
        "light_scene",
        "icon",
        "handoff_text",
    }
)

_REQUIREMENT_KEYS = frozenset({"power", "required", "settings"})


class ConfigError(Exception):
    """A validation failure, located precisely in the document."""

    def __init__(self, path: str, message: str) -> None:
        self.path = path
        self.message = message
        super().__init__(f"{path}: {message}")


class ConfigErrors(Exception):
    """Every validation failure found in one pass."""

    def __init__(self, errors: Sequence[ConfigError]) -> None:
        self.errors = list(errors)
        detail = "\n".join(f"  - {e}" for e in self.errors)
        super().__init__(
            f"Kino-Konfiguration ungültig ({len(self.errors)} Fehler):\n{detail}"
        )


def _as_bool(value: Any, path: str, errors: list[ConfigError]) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {
        "on",
        "off",
        "true",
        "false",
        "yes",
        "no",
    }:
        return value.lower() in {"on", "true", "yes"}
    errors.append(ConfigError(path, f"erwartet ja/nein, gefunden {value!r}"))
    return None


def _as_float(
    value: Any, path: str, errors: list[ConfigError], *, minimum: float | None = None
) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        errors.append(ConfigError(path, f"erwartet eine Zahl, gefunden {value!r}"))
        return None
    if minimum is not None and out < minimum:
        errors.append(ConfigError(path, f"muss >= {minimum} sein, ist {out}"))
        return None
    return out


def _as_str_list(value: Any, path: str, errors: list[ConfigError]) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if not isinstance(value, (list, tuple)):
        errors.append(ConfigError(path, "erwartet eine Liste von Texten"))
        return ()
    out = []
    for index, item in enumerate(value):
        if isinstance(item, str):
            out.append(item)
        else:
            errors.append(
                ConfigError(f"{path}[{index}]", f"erwartet Text, gefunden {item!r}")
            )
    return tuple(out)


def _unknown_keys(
    mapping: Mapping[str, Any],
    allowed: frozenset[str],
    path: str,
    errors: list[ConfigError],
) -> None:
    allowed_text = ", ".join(sorted(allowed))
    errors.extend(
        ConfigError(f"{path}.{key}", f"unbekanntes Feld (erlaubt: {allowed_text})")
        for key in mapping
        if key not in allowed
    )


def _scene_or_none(value: Any, path: str, errors: list[ConfigError]) -> str | None:
    """Accept a `scene.*` entity, or nothing at all."""
    if value is None:
        return None
    if not isinstance(value, str) or not value.startswith("scene."):
        errors.append(ConfigError(path, f"{value!r} ist keine scene.*-Entity"))
        return None
    return value


def _check_path_map(value: Any, path: str, errors: list[ConfigError]) -> None:
    """Check the prefix rewrites that turn catalogue paths into player paths.

    Both sides see the same share through different mounts, so getting this
    wrong means "nothing plays" — worth naming precisely (FR-46).
    """
    if value is None:
        return
    if not isinstance(value, Mapping):
        errors.append(
            ConfigError(path, "erwartet ein Objekt {Bibliothekspfad: Player-Pfad}")
        )
        return
    for source, target in value.items():
        if not isinstance(source, str) or not source:
            errors.append(ConfigError(path, f"ungültiger Pfad-Präfix {source!r}"))
        if not isinstance(target, str) or not target:
            errors.append(
                ConfigError(f"{path}.{source}", f"erwartet einen Pfad, ist {target!r}")
            )


def _parse_device(key: str, raw: Any, errors: list[ConfigError]) -> DeviceSpec | None:
    path = f"devices.{key}"
    if not isinstance(raw, Mapping):
        errors.append(ConfigError(path, "erwartet ein Objekt"))
        return None
    _unknown_keys(raw, _DEVICE_KEYS, path, errors)

    driver = raw.get("driver", "generic")
    if not isinstance(driver, str) or driver not in KNOWN_DRIVERS:
        errors.append(
            ConfigError(
                f"{path}.driver",
                f"unbekannter Treiber {driver!r} "
                f"(bekannt: {', '.join(sorted(KNOWN_DRIVERS))})",
            )
        )
        return None

    entities = raw.get("entities") or {}
    if not isinstance(entities, Mapping):
        errors.append(ConfigError(f"{path}.entities", "erwartet ein Objekt"))
        entities = {}
    else:
        for role, entity_id in entities.items():
            if not isinstance(entity_id, str) or "." not in entity_id:
                errors.append(
                    ConfigError(
                        f"{path}.entities.{role}",
                        f"{entity_id!r} ist keine gültige Entity-ID",
                    )
                )

    options = raw.get("options") or {}
    if not isinstance(options, Mapping):
        errors.append(ConfigError(f"{path}.options", "erwartet ein Objekt"))
        options = {}
    else:
        _check_path_map(options.get("path_map"), f"{path}.options.path_map", errors)

    required = raw.get("required", True)
    required_value = _as_bool(required, f"{path}.required", errors)
    is_media = raw.get("is_media", False)
    is_media_value = _as_bool(is_media, f"{path}.is_media", errors)

    numeric: dict[str, float] = {}
    for field_name, default, minimum in (
        ("startup_timeout", 180.0, 1.0),
        ("shutdown_timeout", 120.0, 1.0),
        ("reconfigure_timeout", 30.0, 1.0),
        ("default_startup_seconds", 30.0, 0.0),
        ("default_shutdown_seconds", 20.0, 0.0),
    ):
        value = raw.get(field_name, default)
        parsed = _as_float(value, f"{path}.{field_name}", errors, minimum=minimum)
        numeric[field_name] = default if parsed is None else parsed

    return DeviceSpec(
        key=key,
        driver=driver,
        name=str(raw.get("name") or key),
        entities=dict(entities),
        unverifiable_settings=frozenset(
            _as_str_list(
                raw.get("unverifiable_settings"),
                f"{path}.unverifiable_settings",
                errors,
            )
        ),
        depends_on=_as_str_list(raw.get("depends_on"), f"{path}.depends_on", errors),
        required=True if required_value is None else required_value,
        is_media=False if is_media_value is None else is_media_value,
        options=dict(options),
        **numeric,
    )


def _parse_requirement(
    activity_key: str,
    device_key: str,
    raw: Any,
    known_devices: Mapping[str, DeviceSpec],
    errors: list[ConfigError],
) -> DeviceRequirement | None:
    path = f"activities.{activity_key}.devices.{device_key}"
    if device_key not in known_devices:
        errors.append(
            ConfigError(
                path,
                f"unbekanntes Gerät {device_key!r} "
                f"(definiert: {', '.join(sorted(known_devices))})",
            )
        )
        return None
    if not isinstance(raw, Mapping):
        errors.append(ConfigError(path, "erwartet ein Objekt"))
        return None
    if "settings" in raw:
        # Explicit nesting means everything else must be a reserved key, so a
        # setting written at the wrong level is caught rather than ignored.
        _unknown_keys(raw, _REQUIREMENT_KEYS, path, errors)

    power_raw = raw.get("power", True)
    power_bool = _as_bool(power_raw, f"{path}.power", errors)
    power = PowerTarget.ON if power_bool else PowerTarget.OFF

    required_raw = raw.get("required")
    required = (
        None
        if required_raw is None
        else _as_bool(required_raw, f"{path}.required", errors)
    )

    settings = raw.get("settings")
    if settings is None:
        # Anything that is not a reserved key is a per-activity setting, so
        # `{ power: on, profile: "HDR 260 HDMI" }` works without nesting.
        settings = {k: v for k, v in raw.items() if k not in _REQUIREMENT_KEYS}
    elif not isinstance(settings, Mapping):
        errors.append(ConfigError(f"{path}.settings", "erwartet ein Objekt"))
        settings = {}

    return DeviceRequirement(
        device=device_key,
        power=power,
        settings=dict(settings),
        required=required,
    )


def _parse_activity(
    key: str,
    raw: Any,
    known_devices: Mapping[str, DeviceSpec],
    errors: list[ConfigError],
) -> ActivityDef | None:
    path = f"activities.{key}"
    if not isinstance(raw, Mapping):
        errors.append(ConfigError(path, "erwartet ein Objekt"))
        return None
    _unknown_keys(raw, _ACTIVITY_KEYS, path, errors)

    control_raw = raw.get("control_class", "room")
    try:
        control = ControlClass(str(control_raw))
    except ValueError:
        errors.append(
            ConfigError(
                f"{path}.control_class",
                f"unbekannte Steuerungsklasse {control_raw!r} (erlaubt: "
                + ", ".join(c.value for c in ControlClass)
                + ")",
            )
        )
        control = ControlClass.ROOM

    devices_raw = raw.get("devices") or {}
    if not isinstance(devices_raw, Mapping):
        errors.append(ConfigError(f"{path}.devices", "erwartet ein Objekt"))
        devices_raw = {}

    requirements: dict[str, DeviceRequirement] = {}
    for device_key, device_raw in devices_raw.items():
        parsed = _parse_requirement(
            key, str(device_key), device_raw, known_devices, errors
        )
        if parsed is not None:
            requirements[str(device_key)] = parsed

    light_scene = raw.get("light_scene")
    if light_scene is not None and (
        not isinstance(light_scene, str) or not light_scene.startswith("scene.")
    ):
        errors.append(
            ConfigError(
                f"{path}.light_scene",
                f"{light_scene!r} ist keine scene.*-Entity",
            )
        )

    return ActivityDef(
        key=key,
        name=str(raw.get("name") or key),
        devices=requirements,
        control_class=control,
        media=raw.get("media"),
        light_scene=light_scene if isinstance(light_scene, str) else None,
        icon=raw.get("icon"),
        handoff_text=raw.get("handoff_text"),
    )


def validate(document: Any) -> KinoConfig:  # noqa: C901, PLR0912, PLR0915
    """
    Validate a raw config document and return the typed configuration.

    Raises :class:`ConfigErrors` listing every problem found, so a broken file
    reports all of its faults at once instead of one per reload.
    """
    errors: list[ConfigError] = []

    if not isinstance(document, Mapping):
        raise ConfigErrors(
            [ConfigError("<root>", "erwartet ein Objekt auf oberster Ebene")]
        )

    version = document.get("version", SCHEMA_VERSION)
    if version != SCHEMA_VERSION:
        errors.append(
            ConfigError(
                "version",
                f"nicht unterstützte Schema-Version {version!r} "
                f"(erwartet {SCHEMA_VERSION})",
            )
        )

    devices_raw = document.get("devices")
    if not isinstance(devices_raw, Mapping) or not devices_raw:
        errors.append(ConfigError("devices", "mindestens ein Gerät erforderlich"))
        devices_raw = {}

    devices: dict[str, DeviceSpec] = {}
    for key, raw in devices_raw.items():
        spec = _parse_device(str(key), raw, errors)
        if spec is not None:
            devices[str(key)] = spec

    for key, spec in devices.items():
        for dependency in spec.depends_on:
            if dependency not in devices:
                errors.append(
                    ConfigError(
                        f"devices.{key}.depends_on",
                        f"unbekanntes Gerät {dependency!r}",
                    )
                )
            elif dependency == key:
                errors.append(
                    ConfigError(
                        f"devices.{key}.depends_on",
                        "ein Gerät kann nicht von sich selbst abhängen",
                    )
                )
    _detect_cycles(devices, errors)

    activities_raw = document.get("activities")
    if not isinstance(activities_raw, Mapping) or not activities_raw:
        errors.append(
            ConfigError("activities", "mindestens eine Aktivität erforderlich")
        )
        activities_raw = {}

    activities: dict[str, ActivityDef] = {}
    for key, raw in activities_raw.items():
        activity = _parse_activity(str(key), raw, devices, errors)
        if activity is not None:
            activities[str(key)] = activity

    settings = document.get("settings") or {}
    if not isinstance(settings, Mapping):
        errors.append(ConfigError("settings", "erwartet ein Objekt"))
        settings = {}

    off_activity = str(settings.get("off_activity", "aus"))
    if off_activity not in activities:
        errors.append(
            ConfigError(
                "settings.off_activity",
                f"Aktivität {off_activity!r} ist nicht definiert",
            )
        )
    elif activities[off_activity].devices:
        powered = [
            d
            for d, r in activities[off_activity].devices.items()
            if r.power is PowerTarget.ON
        ]
        if powered:
            errors.append(
                ConfigError(
                    f"activities.{off_activity}.devices",
                    "die Aus-Aktivität darf kein Gerät einschalten: "
                    + ", ".join(sorted(powered)),
                )
            )

    volume = settings.get("volume") or {}
    if not isinstance(volume, Mapping):
        errors.append(ConfigError("settings.volume", "erwartet ein Objekt"))
        volume = {}

    volume_device = volume.get("device")
    if volume_device is not None and volume_device not in devices:
        errors.append(
            ConfigError(
                "settings.volume.device",
                f"unbekanntes Gerät {volume_device!r}",
            )
        )

    min_db = _as_float(volume.get("min_db", -60.0), "settings.volume.min_db", errors)
    max_db = _as_float(volume.get("max_db", -20.0), "settings.volume.max_db", errors)
    step_db = _as_float(
        volume.get("step_db", 2.0), "settings.volume.step_db", errors, minimum=0.1
    )
    if min_db is not None and max_db is not None and min_db >= max_db:
        errors.append(
            ConfigError(
                "settings.volume",
                f"min_db ({min_db}) muss kleiner als max_db ({max_db}) sein",
            )
        )

    debounce = _as_float(
        settings.get("drift_debounce_seconds", 20.0),
        "settings.drift_debounce_seconds",
        errors,
        minimum=0.0,
    )

    shutdown_scene = _scene_or_none(
        settings.get("shutdown_light_scene"), "settings.shutdown_light_scene", errors
    )
    dim_scene = _scene_or_none(
        settings.get("dim_light_scene"), "settings.dim_light_scene", errors
    )

    # A device no activity ever mentions is dead weight and almost certainly a
    # typo; flag it rather than let it sit there doing nothing (FR-115).
    mentioned = {d for a in activities.values() for d in a.devices}
    errors.extend(
        ConfigError(f"devices.{key}", "wird von keiner Aktivität verwendet")
        for key in sorted(set(devices) - mentioned)
    )

    if errors:
        raise ConfigErrors(errors)

    return KinoConfig(
        devices=devices,
        activities=activities,
        off_activity=off_activity,
        volume_device=volume_device,
        volume_min_db=-60.0 if min_db is None else min_db,
        volume_max_db=-20.0 if max_db is None else max_db,
        volume_step_db=2.0 if step_db is None else step_db,
        shutdown_light_scene=shutdown_scene,
        dim_light_scene=dim_scene,
        drift_debounce_seconds=20.0 if debounce is None else debounce,
        preferred_audio_language=settings.get("preferred_audio_language"),
        preferred_subtitle_language=settings.get("preferred_subtitle_language"),
    )


def _detect_cycles(
    devices: Mapping[str, DeviceSpec], errors: list[ConfigError]
) -> None:
    """Reject dependency cycles — the executor would deadlock on them."""
    state: dict[str, int] = {}
    reported: set[str] = set()

    def visit(key: str, stack: list[str]) -> None:
        if state.get(key) == 2:
            return
        if state.get(key) == 1:
            cycle = " -> ".join([*stack[stack.index(key) :], key])
            if cycle not in reported:
                reported.add(cycle)
                errors.append(
                    ConfigError(
                        f"devices.{key}.depends_on",
                        f"zyklische Abhängigkeit: {cycle}",
                    )
                )
            return
        state[key] = 1
        for dependency in devices[key].depends_on:
            if dependency in devices:
                visit(dependency, [*stack, key])
        state[key] = 2

    for key in devices:
        visit(key, [])
