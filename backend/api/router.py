from fastapi import APIRouter

from api.parsing import router as parsing_router
from api.verification import router as verification_router
from api.settings import router as settings_router
from api.websocket import router as ws_router

api_router = APIRouter()


@api_router.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


@api_router.post("/shutdown")
async def do_shutdown():
    """Graceful shutdown endpoint called by Electron before process termination."""
    import server_state
    if server_state.uvicorn_server:
        server_state.uvicorn_server.should_exit = True
    return {"status": "shutting_down"}


api_router.include_router(parsing_router)
api_router.include_router(verification_router)
api_router.include_router(settings_router)
api_router.include_router(ws_router)
