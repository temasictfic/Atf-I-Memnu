"""Singleton manager for the bundled citation-parser NER model.

Loads the bundled fine-tuned INT8 ONNX model at startup and automatically
detects GPU acceleration when available:
  - DirectML (Windows, any DirectX 12 GPU)
  - CUDA (NVIDIA GPUs)
  - Falls back to CPU otherwise
"""

import asyncio
import logging
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


def _detect_ort_provider() -> str:
    """Detect the best available ONNX Runtime execution provider."""
    try:
        import onnxruntime as ort

        available = ort.get_available_providers()
        logger.info("ONNX Runtime available providers: %s", available)
        if "DmlExecutionProvider" in available:
            logger.info("GPU detected: using DirectML execution provider")
            return "DmlExecutionProvider"
        if "CUDAExecutionProvider" in available:
            logger.info("GPU detected: using CUDA execution provider")
            return "CUDAExecutionProvider"
    except Exception as exc:
        logger.debug("Could not query ONNX Runtime providers: %s", exc)
    logger.info("No GPU provider found; using CPU execution provider")
    return "CPUExecutionProvider"


def _load_pipeline_sync() -> Any:
    """Load the bundled ONNX NER pipeline (blocking, call from executor)."""
    from optimum.onnxruntime import ORTModelForTokenClassification
    from transformers import AutoTokenizer, pipeline as hf_pipeline

    local_path = settings.ner_local_model_path
    if not local_path or not Path(local_path).exists():
        raise RuntimeError(
            f"Bundled NER model not found at {local_path!r}. "
            "Ensure the model is included in the application package."
        )

    path = Path(local_path)
    onnx_files = sorted(path.glob("*.onnx"))
    if not onnx_files:
        raise RuntimeError(f"No .onnx files found in {path}")
    file_name = onnx_files[0].name

    provider = _detect_ort_provider()
    logger.info(
        "Loading ONNX NER model: %s (file=%s, provider=%s)",
        path, file_name, provider,
    )
    model = ORTModelForTokenClassification.from_pretrained(
        str(path), file_name=file_name, provider=provider,
    )
    tokenizer = AutoTokenizer.from_pretrained(str(path))
    ner_pipeline = hf_pipeline(
        "ner",
        model=model,
        tokenizer=tokenizer,
        aggregation_strategy="simple",
    )
    logger.info("ONNX NER pipeline loaded (provider=%s)", provider)
    return ner_pipeline


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


async def preload_pipeline() -> None:
    """Preload the NER model in the background so the first request is fast.

    Called during application startup. Failures are logged but do not
    prevent the app from starting — extraction falls back to regex.
    """
    if not settings.ner_enabled:
        logger.info("NER disabled, skipping model preload")
        return

    logger.info("Preloading NER model in background…")
    result = await get_pipeline()
    if result is not None:
        logger.info("NER model preloaded successfully")
    else:
        logger.warning("NER model preload failed; extraction will fall back to regex")
