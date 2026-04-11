"""Singleton lazy-loading manager for the citation-parser NER model.

Loads a bundled fine-tuned INT8 ONNX model when available (much faster on
CPU and ~4x smaller on disk), falling back to the upstream HF Hub model if
the bundled path is empty or missing.
"""

import asyncio
import logging
import os
from pathlib import Path
from typing import Any

from config import settings

logger = logging.getLogger(__name__)

_pipeline: Any | None = None
_pipeline_lock = asyncio.Lock()
_loading = False
_load_error: str | None = None


def is_model_ready() -> bool:
    return _pipeline is not None


def is_loading() -> bool:
    return _loading


def get_load_error() -> str | None:
    return _load_error


def get_pipeline_sync() -> Any | None:
    """Return the pipeline if already loaded, None otherwise. Non-blocking."""
    return _pipeline


def _load_local_ort_pipeline(local_path: str) -> Any:
    """Load a local ONNX NER model via optimum + transformers pipeline."""
    from optimum.onnxruntime import ORTModelForTokenClassification
    from transformers import AutoTokenizer, pipeline as hf_pipeline

    path = Path(local_path)
    onnx_files = sorted(path.glob("*.onnx"))
    if not onnx_files:
        raise RuntimeError(f"no .onnx files found in {path}")
    file_name = onnx_files[0].name

    logger.info("Loading local ONNX NER model: %s (file=%s)", path, file_name)
    model = ORTModelForTokenClassification.from_pretrained(str(path), file_name=file_name)
    tokenizer = AutoTokenizer.from_pretrained(str(path))
    ner_pipeline = hf_pipeline(
        "ner",
        model=model,
        tokenizer=tokenizer,
        aggregation_strategy="simple",
    )
    logger.info("Local ONNX NER pipeline loaded")
    return ner_pipeline


def _load_hub_pipeline() -> Any:
    """Fallback: load the upstream HF Hub SIRIS model."""
    from transformers import pipeline as hf_pipeline

    models_dir = str(settings.get_models_dir())
    os.environ.setdefault("HF_HOME", models_dir)

    model_name = settings.ner_model_name
    logger.info("Loading HF Hub NER pipeline: %s (cache: %s)", model_name, models_dir)
    ner_pipeline = hf_pipeline(
        "ner",
        model=model_name,
        aggregation_strategy="simple",
    )
    logger.info("HF Hub NER pipeline loaded successfully")
    return ner_pipeline


def _load_pipeline_sync() -> Any:
    """Load the NER pipeline (blocking, call from executor).

    Prefers a bundled local ONNX model if one is configured and present,
    otherwise falls back to the HF Hub model.
    """
    local_path = settings.ner_local_model_path
    if local_path and Path(local_path).exists():
        try:
            return _load_local_ort_pipeline(local_path)
        except Exception as exc:
            logger.warning(
                "Failed to load local ONNX model at %s (%s); falling back to HF Hub",
                local_path,
                exc,
            )
    return _load_hub_pipeline()


async def get_pipeline() -> Any | None:
    """Get the loaded NER pipeline, loading it on first call.

    Returns None if NER is disabled or the pipeline fails to load.
    """
    global _pipeline, _loading, _load_error

    if not settings.ner_enabled:
        return None

    if _pipeline is not None:
        return _pipeline

    async with _pipeline_lock:
        # Double-check after acquiring lock
        if _pipeline is not None:
            return _pipeline

        _loading = True
        _load_error = None
        try:
            loop = asyncio.get_event_loop()
            _pipeline = await loop.run_in_executor(None, _load_pipeline_sync)
            return _pipeline
        except Exception as e:
            _load_error = str(e)
            logger.error("Failed to load NER pipeline: %s", e)
            return None
        finally:
            _loading = False
