let player = null;
let ws = null;
let roomCode = null;
let applyingRemoteUpdate = false;
let heartbeatTimer = null;
let playerReady = false;
let ytApiReady = false;
let pendingState = null; // estado recebido antes do player do YouTube estar pronto
let currentPlaylistIndex = -1;

const playlist = [];
const videoTitles = {};
const queueList = document.getElementById("queueList");
const chatLog = document.getElementById("chatLog");

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
  ws = new WebSocket(`wss://ouvir-junto.onrender.com/ws/${roomCode}`);

  ws.addEventListener("open", () => {
    console.log("WebSocket conectado");
  });

  ws.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    roomError.textContent =
      "Conexão perdida. Recarregue a página para voltar à sala.";
  });

  ws.addEventListener("error", (err) => {
    console.error("Erro WebSocket:", err);
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


// ===============================
// CHAT + PLAYLIST
// ===============================

function getUsername() {
  return (
    document.getElementById("nameInput")?.value?.trim() ||
    localStorage.getItem("ouvirJuntoName") ||
    "Usuário"
  );
}

// -------------------------------
// PLAYLIST
// -------------------------------

function renderPlaylist() {
  if (!queueList) return;

  queueList.innerHTML = "";

 playlist.forEach((videoId, index) => {
  const li = document.createElement("li");

  li.className =
    "queue-item" +
    (index === currentPlaylistIndex ? " playing" : "");

  li.innerHTML = `
    <img src="https://img.youtube.com/vi/${videoId}/mqdefault.jpg">

    <div class="queue-item-info">
      <div class="queue-item-title">
        ${videoTitles[videoId] || `Vídeo ${index + 1}`}
      </div>

      <div class="queue-item-meta">
        ${index === currentPlaylistIndex ? "▶ Tocando agora" : `#${index + 1}`}
      </div>
    </div>

    <button class="queue-item-remove">✕</button>
  `;

  // clicar no vídeo toca ele
  li.addEventListener("click", (e) => {
    if (e.target.classList.contains("queue-item-remove")) return;

    playPlaylistVideo(index);
  });

  li.querySelector(".queue-item-remove").addEventListener("click", (e) => {
    e.stopPropagation();

    playlist.splice(index, 1);

    if (currentPlaylistIndex >= playlist.length) {
      currentPlaylistIndex = playlist.length - 1;
    }

    renderPlaylist();
    if (playlist.length === 1) {
  playPlaylistVideo(0);
}
  });

  queueList.appendChild(li);
});
}
async function addToPlaylist(videoId) {
  if (!playlist.includes(videoId)) {
    playlist.push(videoId);

    // se for o primeiro vídeo da fila
    if (currentPlaylistIndex === -1) {
      currentPlaylistIndex = 0;
    }

    try {
      const response = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
      );

      const data = await response.json();
      videoTitles[videoId] = data.title;
    } catch {
      videoTitles[videoId] = `Vídeo ${playlist.length}`;
    }

    renderPlaylist();
  }
}
// Intercepta envio do formulário de vídeo
document.getElementById("videoForm").addEventListener(
  "submit",
  (e) => {
    const id = extractVideoId(
      document.getElementById("videoInput").value
    );

    if (id) {
      addToPlaylist(id);
    }
  },
  true
);

// Botão Pular
document.getElementById("skipBtn").addEventListener("click", () => {
  if (playlist.length <= 1) return;

  playlist.shift();

  const nextVideo = playlist[0];


  renderPlaylist();

  if (nextVideo) {
    send({
  type: "changeVideo",
  videoId: nextVideo,
});
  }
});

// trocar video da playlist
function playPlaylistVideo(index) {
  if (index < 0 || index >= playlist.length) return;

  currentPlaylistIndex = index;

  const videoId = playlist[index];

  send({
    type: "changeVideo",
    videoId
  });

  renderPlaylist();
}



// -------------------------------
// CHAT
// -------------------------------

function addChatMessage(name, text, own = false) {
  if (!chatLog) return;

  const li = document.createElement("li");
  li.className = own ? "chat-message own" : "chat-message";

  li.innerHTML = `
    <div class="chat-name">${escapeHtml(name)}</div>
    <div class="chat-text">${escapeHtml(text)}</div>
  `;

  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

document.getElementById("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const input = document.getElementById("chatInput");

  const text = input.value.trim();

  if (!text) return;

  addChatMessage(getUsername(), text, true);

  send({
  type: "chat",
  name: getUsername(),
  text,
});

  input.value = "";
});

// -------------------------------
// Intercepta mensagens websocket
// -------------------------------

const originalHandleMessage = handleMessage;

handleMessage = function (msg) {
  if (msg.type === "chat") {
    addChatMessage(msg.name || "Usuário", msg.text || "");
    return;
  }

  originalHandleMessage(msg);
};  
//botão próximo e anterior

const panelHead = document.querySelector(".queue-panel .panel-head");

panelHead.insertAdjacentHTML(
  "beforeend",
  `
    <button id="prevBtn" class="chip-btn">⏮ Anterior</button>
    <button id="nextBtn" class="chip-btn">⏭ Próximo</button>
  `
);

document.addEventListener("click", (e) => {

  if (e.target.id === "nextBtn") {

    if (playlist.length === 0) return;

    currentPlaylistIndex++;

    if (currentPlaylistIndex >= playlist.length) {
      currentPlaylistIndex = 0;
    }

    playPlaylistVideo(currentPlaylistIndex);
  }

  if (e.target.id === "prevBtn") {

    if (playlist.length === 0) return;

    currentPlaylistIndex--;

    if (currentPlaylistIndex < 0) {
      currentPlaylistIndex = playlist.length - 1;
    }

    playPlaylistVideo(currentPlaylistIndex);
  }
});