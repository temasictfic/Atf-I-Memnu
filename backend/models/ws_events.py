from pydantic import BaseModel
from typing import Any


class WsEvent(BaseModel):
    type: str
    data: dict[str, Any] = {}
