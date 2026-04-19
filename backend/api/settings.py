import json
from pathlib import Path

from fastapi import APIRouter

from config import settings as app_config
from models.settings import AppSettings

router = APIRouter()

_current_settings: AppSettings | None = None


def get_current_settings() -> AppSettings:
    """Public accessor for current settings (used by orchestrator/verifiers)."""
    global _current_settings
    if _current_settings is None:
        _load_settings()
    return _current_settings


def _load_settings() -> AppSettings:
    global _current_settings
    settings_path = app_config.get_settings_path()
    if not settings_path.exists():
        _current_settings = AppSettings.default()
        return _current_settings

    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}

    # Per-field load: one invalid/renamed field shouldn't wipe the rest of
    # the file across version upgrades (the UI's auto-save would otherwise
    # overwrite the good file with defaults on the next change).
    valid: dict = {}
    for key, value in data.items():
        if key not in AppSettings.model_fields:
            continue
        try:
            AppSettings.model_validate({key: value})
            valid[key] = value
        except Exception:
            continue

    try:
        _current_settings = AppSettings(**valid)
    except Exception:
        _current_settings = AppSettings.default()
    _current_settings = _migrate_databases(_current_settings)
    return _current_settings


def _migrate_databases(s: AppSettings) -> AppSettings:
    """Reconcile stored databases with current defaults.

    Adds new defaults, removes obsolete entries, preserves user enabled/disabled state.
    """
    defaults = AppSettings.default()
    default_map = {db.id: db for db in defaults.databases}
    stored_map = {db.id: db for db in s.databases}

    merged = []
    for db in defaults.databases:
        if db.id in stored_map:
            merged.append(db.model_copy(update={"enabled": stored_map[db.id].enabled}))
        else:
            merged.append(db)

    changed = s.databases != merged
    s.databases = merged

    # Keep runtime settings in a safe range even if a legacy settings file has bad values.
    timeout = int(s.search_timeout or defaults.search_timeout)
    concurrent = int(s.max_concurrent_apis or defaults.max_concurrent_apis)
    source_concurrent = int(
        s.max_concurrent_sources_per_pdf or defaults.max_concurrent_sources_per_pdf
    )
    sanitized_timeout = max(5, min(timeout, 300))
    sanitized_concurrent = max(1, min(concurrent, 50))
    sanitized_source_concurrent = max(1, min(source_concurrent, 20))

    if s.search_timeout != sanitized_timeout:
        s.search_timeout = sanitized_timeout
        changed = True

    if s.max_concurrent_apis != sanitized_concurrent:
        s.max_concurrent_apis = sanitized_concurrent
        changed = True

    if s.max_concurrent_sources_per_pdf != sanitized_source_concurrent:
        s.max_concurrent_sources_per_pdf = sanitized_source_concurrent
        changed = True

    if changed:
        _save_settings(s)

    return s


def _save_settings(s: AppSettings):
    global _current_settings
    settings_path = app_config.get_settings_path()
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(s.model_dump_json(indent=2), encoding="utf-8")
    _current_settings = s


@router.get("/settings")
async def get_settings():
    s = _current_settings or _load_settings()
    return s.model_dump()


@router.put("/settings")
async def update_settings(new_settings: AppSettings):
    _save_settings(new_settings)
    return new_settings.model_dump()
