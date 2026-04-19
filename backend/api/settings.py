import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

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
    # If the user cleared or rotated the OpenAIRE refresh token via the
    # generic settings path, drop our cached access token so the next
    # verifier request re-exchanges against the new value.
    try:
        from services.openaire_token_manager import invalidate_cache
        previous = get_current_settings()
        if previous.api_keys.get("openaire", "") != new_settings.api_keys.get(
            "openaire", ""
        ):
            invalidate_cache()
    except Exception:
        pass

    _save_settings(new_settings)
    return new_settings.model_dump()


class OpenaireValidateRequest(BaseModel):
    refresh_token: str


@router.post("/settings/openaire/validate")
async def validate_openaire_token(payload: OpenaireValidateRequest):
    """Exchange the pasted refresh token against OpenAIRE and persist on success.

    This is the primary entry point for the "Connect" button. Keeping the
    refresh-token exchange on the server side means the renderer never has
    to deal with OpenAIRE's CORS stance, and validation + persistence are
    one atomic step: if the exchange fails, nothing is saved.
    """
    from services.openaire_token_manager import (
        exchange_refresh_token,
        invalidate_cache,
    )

    token = (payload.refresh_token or "").strip()
    if not token:
        return {"valid": False, "error": "Token is empty."}

    try:
        await exchange_refresh_token(token)
    except RuntimeError as exc:
        return {"valid": False, "error": str(exc)}

    current = get_current_settings()
    updated_keys = dict(current.api_keys)
    updated_keys["openaire"] = token
    updated = current.model_copy(update={
        "api_keys": updated_keys,
        "openaire_token_saved_at": datetime.now(timezone.utc).date().isoformat(),
    })
    _save_settings(updated)
    invalidate_cache()

    return {"valid": True, "settings": updated.model_dump()}


@router.post("/settings/openaire/disconnect")
async def disconnect_openaire():
    """Clear the stored OpenAIRE refresh token and reset its saved-at date."""
    from services.openaire_token_manager import invalidate_cache

    current = get_current_settings()
    updated_keys = {k: v for k, v in current.api_keys.items() if k != "openaire"}
    updated = current.model_copy(update={
        "api_keys": updated_keys,
        "openaire_token_saved_at": "",
    })
    _save_settings(updated)
    invalidate_cache()
    return updated.model_dump()
