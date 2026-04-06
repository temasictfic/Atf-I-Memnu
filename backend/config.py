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


class Settings(BaseSettings):
    port: int = 0
    host: str = "0.0.0.0"
    output_dir: str = _default_output_dir()
    kaynaklar_dir: str = ""

    # Search
    search_timeout: int = 10
    max_concurrent_apis: int = 5
    max_concurrent_sources_per_pdf: int = 3

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

    def get_settings_path(self) -> Path:
        return Path(self.output_dir) / "settings.json"


settings = Settings()
