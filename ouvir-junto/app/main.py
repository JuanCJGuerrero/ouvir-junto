import json
import time
from typing import Dict, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Ouvir Junto")


class Room:
    """Estado de uma sala: qual vídeo está tocando, em que segundo, e quem está conectado."""

    def __init__(self) -> None:
        self.clients: Set[WebSocket] = set()
        self.video_id: Optional[str] = None
        self.is_playing: bool = False
        self.position: float = 0.0
        self.last_update: float = time.time()

    def current_position(self) -> float:
        if self.is_playing:
            return self.position + (time.time() - self.last_update)
        return self.position

    def apply(self, msg: dict) -> None:
        msg_type = msg.get("type")

        if msg_type == "changeVideo":
            self.video_id = msg.get("videoId")
            self.position = 0.0
            self.is_playing = True
            self.last_update = time.time()
            return

        if msg_type in ("play", "pause", "seek", "heartbeat"):
            position = msg.get("position")
            self.position = float(position) if position is not None else self.current_position()
            self.last_update = time.time()
            if msg_type == "play":
                self.is_playing = True
            elif msg_type == "pause":
                self.is_playing = False

    def state_message(self) -> dict:
        return {
            "type": "sync",
            "videoId": self.video_id,
            "isPlaying": self.is_playing,
            "position": self.current_position(),
            "userCount": len(self.clients),
        }


rooms: Dict[str, Room] = {}


async def broadcast(room: Room, message: dict) -> None:
    payload = json.dumps(message)
    dead = []
    for client in room.clients:
        try:
            await client.send_text(payload)
        except Exception:
            dead.append(client)
    for client in dead:
        room.clients.discard(client)


@app.websocket("/ws/{room_code}")
async def room_socket(websocket: WebSocket, room_code: str) -> None:
    room_code = room_code.upper()
    await websocket.accept()

    room = rooms.setdefault(room_code, Room())
    room.clients.add(websocket)

    # Manda o estado atual só para quem chegou agora
    await websocket.send_text(json.dumps(room.state_message()))
    # Avisa todo mundo que alguém entrou
    await broadcast(room, {"type": "userCount", "count": len(room.clients)})

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            room.apply(msg)
            await broadcast(room, room.state_message())
    except WebSocketDisconnect:
        room.clients.discard(websocket)
        if room.clients:
            await broadcast(room, {"type": "userCount", "count": len(room.clients)})
        else:
            rooms.pop(room_code, None)


@app.get("/healthz")
async def health() -> dict:
    return {"status": "ok", "rooms": len(rooms)}


# Serve o frontend estático (precisa vir depois das rotas acima)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
