// ---------- Estado global ----------

let player = null;
let ws = null;
let roomCode = null;
let applyingRemoteUpdate = false;
let heartbeatTimer = null;
let playerReady = false;
let ytApiReady = false;
let pendingState = null; // estado recebido antes do player do YouTube estar pronto
let currentPlaylistIndex = -1;
let syncCheckTimer = null;

let intentionalClose = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

const playlist = [];
const videoTitles = {};

// identifica esta aba/sessão para reconhecer o eco do próprio chat sem duplicar
const clientId =
  window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

let currentUsername = localStorage.getItem("ouvirJuntoName") || "Usuário";

// ---------- Elementos ----------

const queueList = document.getElementById("queueList");
const chatLog = document.getElementById("chatLog");
const userCountEl = document.getElementById("userCount");
const nowPlaying = document.getElementById("nowPlaying");

const homeScreen = document.getElementById("home-screen");
const roomScreen = document.getElementById("room-screen");
const homeError = document.getElementById("homeError");
const roomError = document.getElementById("roomError");
const placeholder = document.getElementById("player-placeholder");
const syncOverlay = document.getElementById("sync-overlay");

const userNameDisplay = document.getElementById("userNameDisplay");
const nameEditForm = document.getElementById("nameEditForm");
const nameEditInput = document.getElementById("nameEditInput");

// ---------- Util ----------

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

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function setUsername(name) {
  currentUsername = name && name.trim() ? name.trim().slice(0, 24) : "Usuário";
  localStorage.setItem("ouvirJuntoName", currentUsername);
  if (userNameDisplay) userNameDisplay.textContent = currentUsername;
}

function resetPlayerSlot() {
  // a API do YouTube substitui a div original pelo iframe e a remove ao
  // destruir o player, então é preciso recriar a div antes de criar outro
  const slot = document.getElementById("player-slot");
  if (slot) slot.innerHTML = '<div id="player"></div>';
}

// ---------- Navegação entre telas ----------

function enterRoom(code) {
  if (!/^[A-Za-z0-9]{4,8}$/.test(code)) {
    homeError.textContent = "Use um código de 4 a 8 letras/números.";
    return;
  }

  homeError.textContent = "";
  roomCode = code.toUpperCase();

  homeScreen.classList.add("hidden");
  roomScreen.classList.remove("hidden");
  document.getElementById("roomCodeDisplay").textContent = roomCode;
  history.replaceState(null, "", `?code=${roomCode}`);

  setUsername(currentUsername);

  resetPlayerSlot();
  player = null;
  playerReady = false;
  pendingState = null;

  ensurePlayerCreated();
  connectSocket();
}

function leaveRoom() {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  stopHeartbeat();

  if (ws) {
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
    ws = null;
  }

  if (player && player.destroy) {
    try {
      player.destroy();
    } catch (e) {
      /* ignore */
    }
  }
  player = null;
  playerReady = false;
  pendingState = null;
  resetPlayerSlot();

  playlist.length = 0;
  Object.keys(videoTitles).forEach((key) => delete videoTitles[key]);
  currentPlaylistIndex = -1;

  if (queueList) queueList.innerHTML = "";
  if (chatLog) chatLog.innerHTML = "";
  if (nowPlaying) nowPlaying.textContent = "";

  placeholder.classList.remove("hidden");
  syncOverlay.classList.add("hidden");
  roomError.textContent = "";

  roomCode = null;
  history.replaceState(null, "", window.location.pathname);

  roomScreen.classList.add("hidden");
  homeScreen.classList.remove("hidden");
}

document.getElementById("createRoomBtn").addEventListener("click", () => {
  applyNameFromHome();
  enterRoom(generateRoomCode());
});

document.getElementById("joinRoomBtn").addEventListener("click", () => {
  applyNameFromHome();
  enterRoom(document.getElementById("joinCodeInput").value.trim());
});

document.getElementById("joinCodeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("joinRoomBtn").click();
});

document.getElementById("backBtn").addEventListener("click", leaveRoom);

function applyNameFromHome() {
  const input = document.getElementById("nameInput");
  const val = input ? input.value.trim() : "";
  if (val) setUsername(val);
}

document.getElementById("copyLinkBtn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(window.location.href);
  const btn = document.getElementById("copyLinkBtn");
  const original = btn.textContent;
  btn.textContent = "Copiado";
  setTimeout(() => (btn.textContent = original), 1500);
});

window.addEventListener("DOMContentLoaded", () => {
  const nameInput = document.getElementById("nameInput");
  if (nameInput && currentUsername !== "Usuário") nameInput.value = currentUsername;

  const code = new URLSearchParams(window.location.search).get("code");
  if (code) enterRoom(code);
});

// ---------- Edição de nome dentro da sala ----------

document.getElementById("editNameBtn").addEventListener("click", () => {
  nameEditInput.value = currentUsername;
  nameEditForm.classList.remove("hidden");
  nameEditInput.focus();
});

document.getElementById("cancelNameEdit").addEventListener("click", () => {
  nameEditForm.classList.add("hidden");
});

nameEditForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const newName = nameEditInput.value.trim();
  if (!newName) return;

  setUsername(newName);
  send({ type: "setName", name: currentUsername });
  nameEditForm.classList.add("hidden");
});

// ---------- WebSocket ----------

function connectSocket() {
  intentionalClose = false;

  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsProtocol}//${location.host}/ws/${roomCode}?name=${encodeURIComponent(currentUsername)}`;

  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    roomError.textContent = "";
  });

  ws.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    if (intentionalClose) return;

    stopHeartbeat();

    if (reconnectAttempts < 5) {
      reconnectAttempts += 1;
      roomError.textContent = "Conexão perdida. Tentando reconectar...";
      reconnectTimer = setTimeout(connectSocket, 1200 * reconnectAttempts);
    } else {
      roomError.textContent = "Não foi possível reconectar. Recarregue a página.";
    }
  });

  ws.addEventListener("error", () => {});
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- Mensagens recebidas ----------

function handleMessage(msg) {
  switch (msg.type) {
    case "sync":
      if (!playerReady) {
        pendingState = msg;
      } else {
        applySync(msg);
      }
      break;

    case "playlistSync":
      handlePlaylistSync(msg);
      break;

    case "userCount":
      userCountEl.textContent = msg.count === 1 ? "1 na sala" : `${msg.count} na sala`;
      break;

    case "chat":
      addChatMessage(msg.name || "Usuário", msg.text || "", msg.clientId === clientId);
      break;

    case "system":
      addSystemMessage(msg.text || "");
      break;
  }
}

function applySync(msg) {
  applyingRemoteUpdate = true;

  if (!msg.videoId) {
    // sala sem vídeo: volta para o estado de "vazio" em vez de travar no último frame
    if (player && player.stopVideo) {
      try {
        player.stopVideo();
      } catch (e) {
        /* ignore */
      }
    }
    placeholder.classList.remove("hidden");
    syncOverlay.classList.add("hidden");
    applyingRemoteUpdate = false;
    return;
  }

  placeholder.classList.add("hidden");

  const loadedId = player && player.getVideoData ? player.getVideoData().video_id : null;

  if (loadedId !== msg.videoId) {
    player.loadVideoById(msg.videoId, msg.position);
    if (!msg.isPlaying) player.pauseVideo();
  } else {
    const drift = Math.abs(player.getCurrentTime() - msg.position);
    if (drift > 1.5) player.seekTo(msg.position, true);

    const state = player.getPlayerState();
    if (msg.isPlaying && state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
      player.playVideo();
    }
    if (!msg.isPlaying && state === YT.PlayerState.PLAYING) {
      player.pauseVideo();
    }
  }

  // se o navegador bloquear o autoplay, avisa e deixa o usuário liberar com um clique
  clearTimeout(syncCheckTimer);
  if (msg.isPlaying) {
    syncCheckTimer = setTimeout(() => {
      if (!player) return;
      const state = player.getPlayerState();
      if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
        syncOverlay.classList.remove("hidden");
      }
    }, 1200);
  } else {
    syncOverlay.classList.add("hidden");
  }

  setTimeout(() => (applyingRemoteUpdate = false), 400);
}

document.getElementById("syncPlayBtn").addEventListener("click", () => {
  syncOverlay.classList.add("hidden");
  if (player && player.playVideo) player.playVideo();
});

// ---------- YouTube player ----------

// chamado automaticamente pela API do YouTube quando ela carrega
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
  if (event.data === YT.PlayerState.PLAYING) {
    syncOverlay.classList.add("hidden");
  }

  if (applyingRemoteUpdate) return;

  if (event.data === YT.PlayerState.PLAYING) {
    send({ type: "play", position: player.getCurrentTime() });
    startHeartbeat();
  } else if (event.data === YT.PlayerState.PAUSED) {
    send({ type: "pause", position: player.getCurrentTime() });
    stopHeartbeat();
  }
}

// ---------- Heartbeat / detecção de avanço manual (seek) ----------

let lastHeartbeatTime = null;
let lastHeartbeatPos = null;

function startHeartbeat() {
  stopHeartbeat();
  lastHeartbeatTime = Date.now();
  lastHeartbeatPos = player.getCurrentTime();

  heartbeatTimer = setInterval(() => {
    if (!player || applyingRemoteUpdate) return;

    const now = Date.now();
    const pos = player.getCurrentTime();
    const expectedPos = lastHeartbeatPos + (now - lastHeartbeatTime) / 1000;
    const jumped = Math.abs(pos - expectedPos) > 1.5;

    lastHeartbeatTime = now;
    lastHeartbeatPos = pos;

    // se detectar um salto (usuário arrastou a barra), avisa os outros mais rápido
    send({ type: jumped ? "seek" : "heartbeat", position: pos });
  }, 2000);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// ---------- Playlist ----------

async function handlePlaylistSync(msg) {
  playlist.length = 0;

  for (const videoId of msg.playlist) {
    playlist.push(videoId);
    if (!videoTitles[videoId]) {
      fetchTitle(videoId); // não bloqueia a renderização da fila
    }
  }

  currentPlaylistIndex = msg.currentIndex;
  renderPlaylist();
}

async function fetchTitle(videoId) {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    const data = await response.json();
    videoTitles[videoId] = data.title;
  } catch {
    videoTitles[videoId] = videoId;
  }
  renderPlaylist();
}

function renderPlaylist() {
  if (!queueList) return;

  queueList.innerHTML = "";

  playlist.forEach((videoId, index) => {
    const li = document.createElement("li");
    li.className = "queue-item" + (index === currentPlaylistIndex ? " playing" : "");

    li.innerHTML = `
      <img src="https://img.youtube.com/vi/${videoId}/mqdefault.jpg">
      <div class="queue-item-info">
        <div class="queue-item-title">${escapeHtml(videoTitles[videoId] || `Vídeo ${index + 1}`)}</div>
        <div class="queue-item-meta">${index === currentPlaylistIndex ? "▶ Tocando agora" : `#${index + 1}`}</div>
      </div>
      <button class="queue-item-remove" type="button" title="Remover">✕</button>
    `;

    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("queue-item-remove")) return;
      playPlaylistVideo(index);
    });

    li.querySelector(".queue-item-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "playlistRemove", index });
    });

    queueList.appendChild(li);
  });

  updateNowPlaying();
}

function updateNowPlaying() {
  if (!nowPlaying) return;

  if (currentPlaylistIndex >= 0 && playlist[currentPlaylistIndex]) {
    const vid = playlist[currentPlaylistIndex];
    nowPlaying.innerHTML = `Tocando agora: <strong>${escapeHtml(videoTitles[vid] || vid)}</strong>`;
  } else {
    nowPlaying.textContent = "";
  }
}

function playPlaylistVideo(index) {
  send({ type: "playlistPlay", index });
}

document.getElementById("videoForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const input = document.getElementById("videoInput");
  const videoId = extractVideoId(input.value);

  if (!videoId) {
    roomError.textContent = "Não reconheci esse link. Cole a URL completa do YouTube.";
    return;
  }

  roomError.textContent = "";
  send({ type: "playlistAdd", videoId });
  input.value = "";
});

document.getElementById("nextBtn").addEventListener("click", () => {
  if (playlist.length === 0) return;
  send({ type: "playlistNext" });
});

document.getElementById("prevBtn").addEventListener("click", () => {
  if (playlist.length === 0) return;
  send({ type: "playlistPrev" });
});

// ---------- Chat ----------

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

function addSystemMessage(text) {
  if (!chatLog) return;

  const li = document.createElement("li");
  li.className = "chat-system";
  li.textContent = text;

  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

document.getElementById("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;

  // o nome é definido pelo servidor (autoritativo); só mandamos o clientId
  // para reconhecer o eco da própria mensagem sem duplicar no chat
  send({ type: "chat", text, clientId });
  input.value = "";
});

const translations = {
    pt: {
        createRoom: "Criar sala",
        joinRoom: "Entrar",
        addQueue: "Adicionar à fila",
        send: "Enviar",
        chat: "Chat",
        queue: "Fila",
        copyLink: "Copiar link",
        placeholderName: "Seu nome",
        placeholderVideo: "Cole um link do YouTube",
        placeholderChat: "Mandar mensagem"
    },

    en: {
        createRoom: "Create Room",
        joinRoom: "Join",
        addQueue: "Add to Queue",
        send: "Send",
        chat: "Chat",
        queue: "Queue",
        copyLink: "Copy Link",
        placeholderName: "Your name",
        placeholderVideo: "Paste a YouTube link",
        placeholderChat: "Send message"
    },

    nl: {
        createRoom: "Kamer maken",
        joinRoom: "Deelnemen",
        addQueue: "Toevoegen",
        send: "Verzenden",
        chat: "Chat",
        queue: "Wachtrij",
        copyLink: "Link kopiëren",
        placeholderName: "Jouw naam",
        placeholderVideo: "Plak een YouTube-link",
        placeholderChat: "Bericht sturen"
    },

    es: {
        createRoom: "Crear sala",
        joinRoom: "Entrar",
        addQueue: "Agregar a la cola",
        send: "Enviar",
        chat: "Chat",
        queue: "Cola",
        copyLink: "Copiar enlace",
        placeholderName: "Tu nombre",
        placeholderVideo: "Pega un enlace de YouTube",
        placeholderChat: "Enviar mensaje"
    }
};


function setLanguage(lang) {

    localStorage.setItem("language", lang);

    const t = translations[lang];

    document.getElementById("createRoomBtn").textContent = t.createRoom;
    document.getElementById("joinRoomBtn").textContent = t.joinRoom;

    document.querySelector("#videoForm button").textContent = t.addQueue;

    document.querySelector("#chatForm button").textContent = t.send;

    document.querySelector(".queue-panel h2").textContent = t.queue;
    document.querySelector(".chat-col h2").textContent = t.chat;

    document.getElementById("copyLinkBtn").textContent = t.copyLink;

    document.getElementById("nameInput").placeholder = t.placeholderName;
    document.getElementById("nameEditInput").placeholder = t.placeholderName;

    document.getElementById("videoInput").placeholder = t.placeholderVideo;
    document.getElementById("chatInput").placeholder = t.placeholderChat;

    document.querySelectorAll(".lang-btn").forEach(btn => {
        btn.classList.remove("active");
    });

    document
        .querySelector(`[data-lang="${lang}"]`)
        .classList.add("active");
}


document.querySelectorAll(".lang-btn").forEach(btn => {

    btn.addEventListener("click", () => {

        setLanguage(btn.dataset.lang);

    });

});


const savedLanguage =
    localStorage.getItem("language") || "pt";

setLanguage(savedLanguage);

const sidebar = document.querySelector(".sidebar");
const toggle = document.getElementById("sidebarToggle");

toggle.addEventListener("click", () => {
    sidebar.classList.toggle("open");
});