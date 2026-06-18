let player = null;
let ws = null;
let roomCode = null;
let applyingRemoteUpdate = false;
let heartbeatTimer = null;
let playerReady = false;
let ytApiReady = false;
let pendingState = null; // estado recebido antes do player do YouTube estar pronto

const homeScreen = document.getElementById("home-screen");
const roomScreen = document.getElementById("room-screen");
const homeError = document.getElementById("homeError");
const roomError = document.getElementById("roomError");
const placeholder = document.getElementById("player-placeholder");

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function extractVideoId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/);
  if (match) return match[1];
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

function enterRoom(code) {
  if (!/^[A-Za-z0-9]{4,8}$/.test(code)) {
    homeError.textContent = "Use um código de 4 a 8 letras/números.";
    return;
  }
  roomCode = code.toUpperCase();
  homeScreen.classList.add("hidden");
  roomScreen.classList.remove("hidden");
  document.getElementById("roomCodeDisplay").textContent = roomCode;
  history.replaceState(null, "", `?code=${roomCode}`);
  ensurePlayerCreated();
  connectSocket();
}

document.getElementById("createRoomBtn").addEventListener("click", () => {
  enterRoom(generateRoomCode());
});

document.getElementById("joinRoomBtn").addEventListener("click", () => {
  enterRoom(document.getElementById("joinCodeInput").value.trim());
});

document.getElementById("joinCodeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("joinRoomBtn").click();
});

document.getElementById("copyLinkBtn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(window.location.href);
  const btn = document.getElementById("copyLinkBtn");
  const original = btn.textContent;
  btn.textContent = "Copiado";
  setTimeout(() => (btn.textContent = original), 1500);
});

document.getElementById("videoForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("videoInput");
  const videoId = extractVideoId(input.value);
  if (!videoId) {
    roomError.textContent = "Não reconheci esse link. Cole a URL completa do YouTube.";
    return;
  }
  roomError.textContent = "";
  input.value = "";
  send({ type: "changeVideo", videoId });
});

window.addEventListener("DOMContentLoaded", () => {
  const code = new URLSearchParams(window.location.search).get("code");
  if (code) enterRoom(code);
});

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${window.location.host}/ws/${roomCode}`);
  ws.addEventListener("message", (event) => handleMessage(JSON.parse(event.data)));
  ws.addEventListener("close", () => {
    roomError.textContent = "Conexão perdida. Recarregue a página para voltar à sala.";
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  if (msg.type === "userCount") {
    document.getElementById("userCount").textContent =
      msg.count === 1 ? "1 na sala" : `${msg.count} na sala`;
    return;
  }
  if (msg.type !== "sync") return;

  if (!msg.videoId) return; // sala ainda sem vídeo

  if (!playerReady) {
    pendingState = msg;
    return;
  }
  applySync(msg);
}

function applySync(msg) {
  applyingRemoteUpdate = true;
  placeholder.classList.add("hidden");

  const loadedId = player.getVideoData ? player.getVideoData().video_id : null;

  if (loadedId !== msg.videoId) {
    player.loadVideoById(msg.videoId, msg.position);
    if (!msg.isPlaying) player.pauseVideo();
  } else {
    const drift = Math.abs(player.getCurrentTime() - msg.position);
    if (drift > 1.5) player.seekTo(msg.position, true);

    const state = player.getPlayerState();
    if (msg.isPlaying && state !== YT.PlayerState.PLAYING) player.playVideo();
    if (!msg.isPlaying && state === YT.PlayerState.PLAYING) player.pauseVideo();
  }

  setTimeout(() => (applyingRemoteUpdate = false), 400);
}

// Chamado automaticamente pela API do YouTube quando ela carrega
function onYouTubeIframeAPIReady() {
  ytApiReady = true;
  ensurePlayerCreated();
}

function ensurePlayerCreated() {
  if (player || !ytApiReady || !document.getElementById("player")) return;
  player = new YT.Player("player", {
    height: "360",
    width: "640",
    playerVars: { playsinline: 1 },
    events: {
      onReady: () => {
        playerReady = true;
        if (pendingState) {
          applySync(pendingState);
          pendingState = null;
        }
      },
      onStateChange: onPlayerStateChange,
    },
  });
}

function onPlayerStateChange(event) {
  if (applyingRemoteUpdate) return;

  if (event.data === YT.PlayerState.PLAYING) {
    send({ type: "play", position: player.getCurrentTime() });
    startHeartbeat();
  } else if (event.data === YT.PlayerState.PAUSED) {
    send({ type: "pause", position: player.getCurrentTime() });
    stopHeartbeat();
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (player && !applyingRemoteUpdate) {
      send({ type: "heartbeat", position: player.getCurrentTime() });
    }
  }, 4000);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}
