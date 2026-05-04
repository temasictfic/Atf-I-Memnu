from datetime import datetime, timezone

from fastapi import APIRouter
from pydantic import BaseModel

from models.settings import AppSettings
from services.openaire_token_manager import (
    exchange_refresh_token,
    get_runtime_status,
    invalidate_cache,
)
from services.settings_store import get_current_settings, save_settings

router = APIRouter()

# Re-export the public accessor for any external caller still importing
# `get_current_settings` from `api.settings`. The canonical home is now
# `services.settings_store` — this module is just the FastAPI router.
__all__ = ["router", "get_current_settings"]


@router.get("/settings")
async def get_settings():
    s = get_current_settings()
    return s.model_dump()


@router.put("/settings")
async def update_settings(new_settings: AppSettings):
    previous = get_current_settings()

    # Merge api_keys: never wipe an existing key with an empty incoming
    # value. A renderer that hasn't yet received the initial GET response
    # would otherwise autosave seed defaults (empty api_keys) and overwrite
    # the on-disk file. Explicit removals are routed through dedicated
    # endpoints (e.g. /settings/openaire/disconnect) which bypass this
    # merge by calling save_settings directly.
    merged_api_keys = dict(previous.api_keys)
    for key, value in (new_settings.api_keys or {}).items():
        if value:
            merged_api_keys[key] = value

    # Preserve non-empty string fields when incoming is empty — the same
    # renderer race that empties api_keys also empties these.
    overrides: dict = {"api_keys": merged_api_keys}
    for field in ("annotated_pdf_dir", "polite_pool_email", "openaire_token_saved_at"):
        incoming = getattr(new_settings, field)
        existing = getattr(previous, field)
        if not incoming and existing:
            overrides[field] = existing

    new_settings = new_settings.model_copy(update=overrides)

    # OpenAIRE cache invalidation: compare AFTER the merge so a no-op save
    # (incoming empty, existing preserved) doesn't trigger a refresh.
    try:
        if previous.api_keys.get("openaire", "") != new_settings.api_keys.get(
            "openaire", ""
        ):
            invalidate_cache()
    except Exception:
        pass

    save_settings(new_settings)
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
    save_settings(updated)
    invalidate_cache()

    return {"valid": True, "settings": updated.model_dump()}


@router.get("/settings/openaire/status")
async def get_openaire_status():
    """Expose the most recent refresh-token exchange outcome.

    Lets the Settings page surface silent mid-run auth failures (expired
    token, OpenAIRE brownout, etc.) that would otherwise go unnoticed —
    the verifier falls back to anonymous, so rates quietly tank without a
    visible error anywhere.
    """
    return get_runtime_status()


@router.post("/settings/openaire/disconnect")
async def disconnect_openaire():
    """Clear the stored OpenAIRE refresh token and reset its saved-at date."""
    current = get_current_settings()
    updated_keys = {k: v for k, v in current.api_keys.items() if k != "openaire"}
    updated = current.model_copy(update={
        "api_keys": updated_keys,
        "openaire_token_saved_at": "",
    })
    save_settings(updated)
    invalidate_cache()
    return updated.model_dump()
