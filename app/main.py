import json
import time
from typing import Dict, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Ouvir Junto")


class Room:
    def __init__(self):
        self.clients: Set[WebSocket] = set()

        self.video_id: Optional[str] = None
        self.is_playing = False
        self.position = 0.0
        self.last_update = time.time()

        self.playlist: list[str] = []
        self.current_index = -1

    def current_position(self) -> float:
        if self.is_playing:
            return self.position + (time.time() - self.last_update)
        return self.position

    def state_message(self) -> dict:
        return {
            "type": "sync",
            "videoId": self.video_id,
            "isPlaying": self.is_playing,
            "position": self.current_position(),
            "playlist": self.playlist,
            "currentIndex": self.current_index,
        }

    def playlist_message(self) -> dict:
        return {
            "type": "playlistSync",
            "playlist": self.playlist,
            "currentIndex": self.current_index,
        }


rooms: Dict[str, Room] = {}


async def broadcast(room: Room, message: dict):
    payload = json.dumps(message)

    disconnected = []

    for client in room.clients:
        try:
            await client.send_text(payload)
        except Exception:
            disconnected.append(client)

    for client in disconnected:
        room.clients.discard(client)


async def sync_room(room: Room):
    await broadcast(room, room.state_message())
    await broadcast(room, room.playlist_message())


@app.websocket("/ws/{room_code}")
async def room_socket(websocket: WebSocket, room_code: str):
    room_code = room_code.upper()

    await websocket.accept()

    room = rooms.setdefault(room_code, Room())
    room.clients.add(websocket)

    try:
        # envia estado atual
        await websocket.send_text(json.dumps(room.state_message()))
        await websocket.send_text(json.dumps(room.playlist_message()))

        await broadcast(
            room,
            {
                "type": "userCount",
                "count": len(room.clients),
            },
        )

        while True:
            raw = await websocket.receive_text()

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            # ==================================================
            # CHAT
            # ==================================================

            if msg_type == "chat":
                await broadcast(
                    room,
                    {
                        "type": "chat",
                        "name": msg.get("name", "Usuário"),
                        "text": msg.get("text", ""),
                    },
                )
                continue

            # ==================================================
            # PLAYLIST ADD
            # ==================================================

            if msg_type == "playlistAdd":
                video_id = msg.get("videoId")

                if video_id and video_id not in room.playlist:
                    room.playlist.append(video_id)

                    if room.current_index == -1:
                        room.current_index = 0
                        room.video_id = video_id
                        room.position = 0
                        room.is_playing = True
                        room.last_update = time.time()

                await sync_room(room)
                continue

            # ==================================================
            # PLAYLIST REMOVE
            # ==================================================

            if msg_type == "playlistRemove":
                index = msg.get("index")

                if isinstance(index, int) and 0 <= index < len(room.playlist):
                    room.playlist.pop(index)

                    if not room.playlist:
                        room.current_index = -1
                        room.video_id = None
                        room.position = 0
                        room.is_playing = False

                    else:
                        if index < room.current_index:
                            room.current_index -= 1

                        if room.current_index >= len(room.playlist):
                            room.current_index = len(room.playlist) - 1

                await sync_room(room)
                continue

            # ==================================================
            # PLAYLIST PLAY
            # ==================================================

            if msg_type == "playlistPlay":
                index = msg.get("index")

                if isinstance(index, int) and 0 <= index < len(room.playlist):
                    room.current_index = index
                    room.video_id = room.playlist[index]
                    room.position = 0
                    room.is_playing = True
                    room.last_update = time.time()

                await sync_room(room)
                continue

            # ==================================================
            # PLAYLIST NEXT
            # ==================================================

            if msg_type == "playlistNext":
                if room.playlist:
                    room.current_index = (
                        room.current_index + 1
                    ) % len(room.playlist)

                    room.video_id = room.playlist[room.current_index]
                    room.position = 0
                    room.is_playing = True
                    room.last_update = time.time()

                await sync_room(room)
                continue

            # ==================================================
            # PLAYLIST PREV
            # ==================================================

            if msg_type == "playlistPrev":
                if room.playlist:
                    room.current_index = (
                        room.current_index - 1
                    ) % len(room.playlist)

                    room.video_id = room.playlist[room.current_index]
                    room.position = 0
                    room.is_playing = True
                    room.last_update = time.time()

                await sync_room(room)
                continue

            # ==================================================
            # CHANGE VIDEO
            # ==================================================

            if msg_type == "changeVideo":
                room.video_id = msg.get("videoId")
                room.position = 0
                room.is_playing = True
                room.last_update = time.time()

                await broadcast(room, room.state_message())
                continue

            # ==================================================
            # PLAY / PAUSE / SEEK / HEARTBEAT
            # ==================================================

            if msg_type in ("play", "pause", "seek", "heartbeat"):
                position = msg.get("position")

                if position is not None:
                    room.position = float(position)

                room.last_update = time.time()

                if msg_type == "play":
                    room.is_playing = True

                elif msg_type == "pause":
                    room.is_playing = False

                await broadcast(room, room.state_message())
                continue

    except WebSocketDisconnect:
        room.clients.discard(websocket)

        if room.clients:
            await broadcast(
                room,
                {
                    "type": "userCount",
                    "count": len(room.clients),
                },
            )
        else:
            rooms.pop(room_code, None)


@app.get("/healthz")
async def health():
    return {
        "status": "ok",
        "rooms": len(rooms),
    }


app.mount(
    "/",
    StaticFiles(directory="static", html=True),
    name="static",
)