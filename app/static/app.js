let player = null;
let ws = null;
let roomCode = null;
let applyingRemoteUpdate = false;
let heartbeatTimer = null;
let playerReady = false;
let ytApiReady = false;
let pendingState = null;

// Backend Render
const BACKEND_URL = "https://ouvir-junto.onrender.com";

const homeScreen = document.getElementById("home-screen");
const roomScreen = document.getElementById("room-screen");
const homeError = document.getElementById("homeError");
const roomError = document.getElementById("roomError");
const placeholder = document.getElementById("player-placeholder");

function getWebSocketUrl(roomCode) {
  const url = new URL(BACKEND_URL);
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}/ws/${roomCode}`;
}

function connectSocket() {
  if (!roomCode) return;

  const socketUrl = getWebSocketUrl(roomCode);

  console.log("Conectando:", socketUrl);

  ws = new WebSocket(socketUrl);

  ws.addEventListener("open", () => {
    console.log("WebSocket conectado");
    roomError.textContent = "";
  });

  ws.addEventListener("message", (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (err) {
      console.error("Erro ao processar mensagem:", err);
    }
  });

  ws.addEventListener("close", () => {
    console.warn("WebSocket desconectado");

    roomError.textContent =
      "Conexão perdida. Tentando reconectar...";

    setTimeout(() => {
      if (
        !ws ||
        ws.readyState === WebSocket.CLOSED
      ) {
        connectSocket();
      }
    }, 3000);
  });

  ws.addEventListener("error", (err) => {
    console.error("Erro WebSocket:", err);
  });
}

function send(msg) {
  if (!ws) return;

  if (ws.readyState !== WebSocket.OPEN) {
    console.warn("WebSocket ainda não está conectado");
    return;
  }

  ws.send(JSON.stringify(msg));
}