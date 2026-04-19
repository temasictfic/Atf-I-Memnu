from pydantic import BaseModel

from config import settings as app_config


class DatabaseConfig(BaseModel):
    id: str
    name: str
    enabled: bool = True


class AppSettings(BaseModel):
    annotated_pdf_dir: str = ""
    databases: list[DatabaseConfig] = []
    api_keys: dict[str, str] = {}
    # Contact email advertised to Crossref / arXiv / OpenAlex polite pools.
    # Blank = stay in the anonymous public pool (stricter rate limits).
    polite_pool_email: str = ""
    # ISO-8601 date (UTC) when the user's OpenAIRE refresh token in
    # `api_keys["openaire"]` was last written. Refresh tokens expire 1 month
    # after issuance, so the UI uses this to warn the user before it dies.
    openaire_token_saved_at: str = ""
    language: str = "tr"
    search_timeout: int = app_config.search_timeout
    max_concurrent_apis: int = app_config.max_concurrent_apis
    max_concurrent_sources_per_pdf: int = app_config.max_concurrent_sources_per_pdf
    auto_scholar_after_verify: bool = True

    @classmethod
    def default(cls) -> "AppSettings":
        return cls(
            databases=[
                DatabaseConfig(id="crossref", name="Crossref"),
                DatabaseConfig(id="openalex", name="OpenAlex"),
                DatabaseConfig(id="openaire", name="OpenAIRE"),
                DatabaseConfig(id="europe_pmc", name="Europe PMC"),
                DatabaseConfig(id="arxiv", name="arXiv"),
                DatabaseConfig(id="pubmed", name="PubMed"),
                DatabaseConfig(id="semantic_scholar", name="Semantic Scholar"),
                DatabaseConfig(id="trdizin", name="TRDizin"),
                DatabaseConfig(id="open_library", name="Open Library"),
            ],
            search_timeout=app_config.search_timeout,
            max_concurrent_apis=app_config.max_concurrent_apis,
            max_concurrent_sources_per_pdf=app_config.max_concurrent_sources_per_pdf,
        )
