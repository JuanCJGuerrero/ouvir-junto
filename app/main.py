import json
import time
from typing import Dict, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Ouvir Junto")


def clean_name(raw: Optional[str]) -> str:
    if not raw:
        return "Usuário"
    name = raw.strip()[:24]
    return name or "Usuário"


class Room:
    def __init__(self):
        self.clients: Set[WebSocket] = set()
        self.names: Dict[WebSocket, str] = {}

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

    def name_for(self, websocket: WebSocket) -> str:
        return self.names.get(websocket, "Usuário")


rooms: Dict[str, Room] = {}


async def broadcast(room: Room, message: dict, skip: Optional[WebSocket] = None):
    payload = json.dumps(message)
    disconnected = []

    for client in room.clients:
        if client is skip:
            continue
        try:
            await client.send_text(payload)
        except Exception:
            disconnected.append(client)

    for client in disconnected:
        room.clients.discard(client)
        room.names.pop(client, None)


async def sync_room(room: Room):
    await broadcast(room, room.state_message())
    await broadcast(room, room.playlist_message())


def system_message(text: str) -> dict:
    return {"type": "system", "text": text}


@app.websocket("/ws/{room_code}")
async def room_socket(websocket: WebSocket, room_code: str):
    room_code = room_code.upper()
    name = clean_name(websocket.query_params.get("name"))

    await websocket.accept()

    room = rooms.setdefault(room_code, Room())
    room.clients.add(websocket)
    room.names[websocket] = name

    try:
        # envia estado atual só para quem entrou
        await websocket.send_text(json.dumps(room.state_message()))
        await websocket.send_text(json.dumps(room.playlist_message()))

        await broadcast(room, {"type": "userCount", "count": len(room.clients)})
        await broadcast(room, system_message(f"{name} entrou na sala"), skip=websocket)

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
                text = (msg.get("text") or "").strip()[:500]
                if not text:
                    continue

                await broadcast(
                    room,
                    {
                        "type": "chat",
                        "name": room.name_for(websocket),
                        "text": text,
                        "clientId": msg.get("clientId"),
                    },
                )
                continue

            # ==================================================
            # MUDAR NOME
            # ==================================================

            if msg_type == "setName":
                new_name = clean_name(msg.get("name"))
                old_name = room.name_for(websocket)

                if new_name != old_name:
                    room.names[websocket] = new_name
                    await broadcast(room, system_message(f"{old_name} agora é {new_name}"))

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
                    was_current = index == room.current_index
                    room.playlist.pop(index)

                    if not room.playlist:
                        room.current_index = -1
                        room.video_id = None
                        room.position = 0
                        room.is_playing = False

                    elif index < room.current_index:
                        # removeu algo antes do item atual: só desloca o índice
                        room.current_index -= 1

                    elif was_current:
                        # removeu o vídeo que estava tocando: avança para o próximo
                        if room.current_index >= len(room.playlist):
                            room.current_index = len(room.playlist) - 1

                        room.video_id = room.playlist[room.current_index]
                        room.position = 0
                        room.is_playing = True
                        room.last_update = time.time()

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
                    room.current_index = (room.current_index + 1) % len(room.playlist)
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
                    room.current_index = (room.current_index - 1) % len(room.playlist)
                    room.video_id = room.playlist[room.current_index]
                    room.position = 0
                    room.is_playing = True
                    room.last_update = time.time()

                await sync_room(room)
                continue

            # ==================================================
            # PLAY / PAUSE / SEEK / HEARTBEAT
            # ==================================================

            if msg_type in ("play", "pause", "seek", "heartbeat"):
                position = msg.get("position")

                if position is not None:
                    try:
                        room.position = float(position)
                    except (TypeError, ValueError):
                        pass

                room.last_update = time.time()

                if msg_type == "play":
                    room.is_playing = True
                elif msg_type == "pause":
                    room.is_playing = False

                # quem disparou o evento já está com o estado correto localmente
                await broadcast(room, room.state_message(), skip=websocket)
                continue

    except WebSocketDisconnect:
        pass
    except Exception:
        # nunca deixa uma falha inesperada deixar a sala em estado inconsistente
        pass
    finally:
        room.clients.discard(websocket)
        leaving_name = room.names.pop(websocket, name)

        if room.clients:
            await broadcast(room, {"type": "userCount", "count": len(room.clients)})
            await broadcast(room, system_message(f"{leaving_name} saiu da sala"))
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