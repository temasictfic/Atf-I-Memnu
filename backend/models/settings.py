from pydantic import BaseModel

from config import settings as app_config


class DatabaseConfig(BaseModel):
    id: str
    name: str
    enabled: bool = True
    tier: int = 1  # 1 = API, 2 = meta-search fallback
    type: str = "api"


class AppSettings(BaseModel):
    last_directory: str = ""
    databases: list[DatabaseConfig] = []
    api_keys: dict[str, str] = {}
    search_timeout: int = app_config.search_timeout
    max_concurrent_apis: int = app_config.max_concurrent_apis
    max_concurrent_sources_per_pdf: int = app_config.max_concurrent_sources_per_pdf

    @classmethod
    def default(cls) -> "AppSettings":
        return cls(
            databases=[
                DatabaseConfig(id="crossref", name="Crossref", tier=1, type="api"),
                DatabaseConfig(id="openalex", name="OpenAlex", tier=1, type="api"),
                DatabaseConfig(id="arxiv", name="arXiv", tier=1, type="api"),
                DatabaseConfig(id="semantic_scholar", name="Semantic Scholar", tier=1, type="api"),
                DatabaseConfig(id="europe_pmc", name="Europe PMC", tier=1, type="api"),
                DatabaseConfig(id="trdizin", name="TRDizin", tier=1, type="api"),
                DatabaseConfig(id="duckduckgo", name="DuckDuckGo", tier=2, type="api"),
            ],
            search_timeout=app_config.search_timeout,
            max_concurrent_apis=app_config.max_concurrent_apis,
            max_concurrent_sources_per_pdf=app_config.max_concurrent_sources_per_pdf,
        )
