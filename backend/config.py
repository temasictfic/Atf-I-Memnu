import os
import sys
from pathlib import Path
from pydantic_settings import BaseSettings


def _default_output_dir() -> str:
    env_output = os.getenv("ATFI_OUTPUT_DIR")
    if env_output:
        return env_output

    if getattr(sys, "frozen", False):
        fallback = Path.home() / "AppData" / "Roaming" / "AtfiMemnu" / "output"
        return str(fallback)

    return str(Path(__file__).resolve().parent.parent / "output")


def _default_ner_local_model_path() -> str:
    """Path to the bundled fine-tuned INT8 ONNX NER model, or "" if not bundled.

    Resolves `backend/models/citation-ner-int8` both in dev (source checkout)
    and in a packaged Electron/PyInstaller build (via _MEIPASS).
    """
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidates.append(Path(meipass) / "models" / "citation-ner-int8")
            candidates.append(Path(meipass) / "backend" / "models" / "citation-ner-int8")
    candidates.append(Path(__file__).resolve().parent / "models" / "citation-ner-int8")
    for c in candidates:
        if c.exists() and any(c.glob("*.onnx")):
            return str(c)
    return ""


class Settings(BaseSettings):
    port: int = 0
    host: str = "0.0.0.0"
    output_dir: str = _default_output_dir()
    kaynaklar_dir: str = ""

    # Search
    search_timeout: int = 20
    max_concurrent_apis: int = 5
    max_concurrent_sources_per_pdf: int = 3

    # NER
    ner_model_name: str = "SIRIS-Lab/citation-parser-ENTITY"
    ner_local_model_path: str = _default_ner_local_model_path()
    ner_enabled: bool = True

    class Config:
        env_prefix = "ATFI_"

    def get_reports_dir(self) -> Path:
        p = Path(self.output_dir) / "reports"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def get_cache_dir(self) -> Path:
        p = Path(self.output_dir) / "cache"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def get_models_dir(self) -> Path:
        p = Path(self.output_dir) / "models"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def get_settings_path(self) -> Path:
        return Path(self.output_dir) / "settings.json"


settings = Settings()
