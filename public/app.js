// MeshCall client
// Everything here talks to the Worker only for signaling + text. All audio,
// video and screen share media flows directly between browsers over WebRTC,
// using Google's public STUN servers to discover each peer's reachable
// address. There is no TURN server configured, so calls between peers stuck
// behind symmetric NATs / strict corporate firewalls may fail to connect —
// add a TURN server to ICE_SERVERS below if you need that coverage.

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

// ---------------------------------------------------------------- state ---
const state = {
  ws: null,
  selfId: null,
  username: null,
  room: null,
  users: new Map(),      // id -> { id, username, inCall: 'audio'|'video'|null }
  activeThread: "room",
  dmThreads: new Set(),  // peer ids with an open DM tab
  dmByUsername: new Map(), // username -> peer id, for matching dm-history replies
  unread: new Map(),     // thread id -> count

  call: {
    active: false,
    kind: null,          // 'audio' | 'video'
    localStream: null,
    screenStream: null,
    screenSharing: false,
  },
  peers: new Map(),      // id -> { pc, polite, makingOffer, ignoreOffer, username }
};

// ------------------------------------------------------------ DOM refs ----
const $ = (id) => document.getElementById(id);

const gate = $("gate"), app = $("app");
const nameInput = $("nameInput"), roomInput = $("roomInput"), joinBtn = $("joinBtn"), gateError = $("gateError");
const roomLabel = $("roomLabel"), selfName = $("selfName");
const rosterList = $("rosterList"), rosterCount = $("rosterCount");
const chatTabs = $("chatTabs"), chatPanes = $("chatPanes");
const composerForm = $("composerForm"), composerInput = $("composerInput");
const videoGrid = $("videoGrid");
const joinAudioBtn = $("joinAudioBtn"), joinVideoBtn = $("joinVideoBtn");
const screenBtn = $("screenBtn"), screenBtnLabel = $("screenBtnLabel");
const muteBtn = $("muteBtn"), camBtn = $("camBtn"), leaveCallBtn = $("leaveCallBtn");
const rosterItemTpl = $("rosterItemTemplate"), videoTileTpl = $("videoTileTemplate");
const meshCanvas = $("meshCanvas"), gateMeshCanvas = $("gateMesh");

// ==========================================================================
// Login gate
// ==========================================================================
joinBtn.addEventListener("click", () => {
  const username = nameInput.value.trim();
  const room = roomInput.value.trim() || "lobby";
  if (!username) {
    gateError.textContent = "Pick a callsign first.";
    gateError.hidden = false;
    return;
  }
  gateError.hidden = true;
  connect(username, room);
});
[nameInput, roomInput].forEach((el) =>
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") joinBtn.click(); })
);

function connect(username, room) {
  state.username = username;
  state.room = room;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(room)}`);
  state.ws = ws;

  ws.addEventListener("open", () => {
    send({ type: "join", username });
  });

  ws.addEventListener("message", (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    addSystemMessage("Disconnected from server.", "room");
  });

  ws.addEventListener("error", () => {
    gateError.textContent = "Couldn't reach the room. Try again.";
    gateError.hidden = false;
  });
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

// ==========================================================================
// Server message handling
// ==========================================================================
function handleServerMessage(msg) {
  switch (msg.type) {
    case "joined": {
      state.selfId = msg.id;
      for (const u of msg.users) state.users.set(u.id, u);
      enterApp();
      renderRoster();
      break;
    }
    case "user-joined": {
      state.users.set(msg.id, { id: msg.id, username: msg.username, inCall: null });
      renderRoster();
      addSystemMessage(`${msg.username} joined the room.`, "room");
      break;
    }
    case "user-left": {
      const u = state.users.get(msg.id);
      state.users.delete(msg.id);
      teardownPeer(msg.id);
      removeVideoTile(msg.id);
      renderRoster();
      if (u) addSystemMessage(`${u.username} left the room.`, "room");
      break;
    }
    case "history": {
      for (const m of msg.messages) {
        renderMessage(msg.thread, { username: m.from, text: m.text, ts: m.ts, self: m.from === state.username });
      }
      break;
    }
    case "dm-history": {
      const threadId = state.dmByUsername.get(msg.with);
      if (!threadId) break;
      for (const m of msg.messages) {
        renderMessage(threadId, { username: m.from, text: m.text, ts: m.ts, self: m.from === state.username });
      }
      break;
    }
    case "chat": {
      renderMessage("room", { username: msg.username, text: msg.text, ts: msg.ts, self: false });
      bumpUnread("room");
      break;
    }
    case "dm": {
      ensureDMTab(msg.from, msg.username);
      renderMessage(msg.from, { username: msg.username, text: msg.text, ts: msg.ts, self: false });
      bumpUnread(msg.from);
      break;
    }
    case "signal": {
      handleSignal(msg.from, msg.data);
      break;
    }
    case "call-roster": {
      // We just joined the call — initiate to everyone already in it.
      for (const peer of msg.roster) {
        const u = state.users.get(peer.id);
        if (u) u.inCall = peer.kind;
        initiatePeerConnection(peer.id, peer.username);
      }
      renderRoster();
      break;
    }
    case "call-joined": {
      const u = state.users.get(msg.id);
      if (u) { u.inCall = msg.kind; renderRoster(); }
      break;
    }
    case "call-left": {
      const u = state.users.get(msg.id);
      if (u) { u.inCall = null; renderRoster(); }
      teardownPeer(msg.id);
      removeVideoTile(msg.id);
      break;
    }
    case "screen-state": {
      const tile = videoGrid.querySelector(`.video-tile[data-id="${msg.id}"]`);
      if (tile) tile.classList.toggle("screen", msg.sharing);
      break;
    }
  }
}

// ==========================================================================
// App shell / roster
// ==========================================================================
function enterApp() {
  gate.hidden = true;
  app.hidden = false;
  roomLabel.textContent = state.room;
  selfName.textContent = state.username;
  addSystemMessage(`Connected as ${state.username} in #${state.room}.`, "room");
  startMeshViz();
}

function renderRoster() {
  rosterCount.textContent = String(state.users.size);
  rosterList.innerHTML = "";
  for (const u of state.users.values()) {
    const node = rosterItemTpl.content.cloneNode(true);
    const item = node.querySelector(".roster-item");
    item.dataset.id = u.id;
    const dot = node.querySelector(".status-dot");
    dot.classList.add(u.inCall ? "in-call" : "online");
    node.querySelector(".roster-name").textContent = u.username;
    const badge = node.querySelector(".roster-call-badge");
    if (u.inCall) { badge.hidden = false; badge.textContent = u.inCall === "video" ? "VIDEO" : "VOICE"; }
    node.querySelector(".roster-dm-btn").addEventListener("click", () => {
      ensureDMTab(u.id, u.username);
      switchTab(u.id);
    });
    rosterList.appendChild(node);
  }
}

// ==========================================================================
// Chat: room + DM tabs
// ==========================================================================
function ensureDMTab(peerId, username) {
  state.dmByUsername.set(username, peerId);
  if (state.dmThreads.has(peerId)) return;
  state.dmThreads.add(peerId);
  send({ type: "dm-history", with: username });

  const tab = document.createElement("button");
  tab.className = "chat-tab";
  tab.dataset.thread = peerId;
  tab.innerHTML = `${escapeHtml(username)} <span class="unread" hidden></span> <span class="chat-tab-close" title="Close">×</span>`;
  tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("chat-tab-close")) {
      closeDMTab(peerId);
      return;
    }
    switchTab(peerId);
  });
  chatTabs.appendChild(tab);

  const pane = document.createElement("div");
  pane.className = "chat-pane";
  pane.dataset.thread = peerId;
  const log = document.createElement("div");
  log.className = "chat-log";
  log.id = `log-${peerId}`;
  pane.appendChild(log);
  chatPanes.appendChild(pane);
}

function closeDMTab(peerId) {
  state.dmThreads.delete(peerId);
  chatTabs.querySelector(`.chat-tab[data-thread="${peerId}"]`)?.remove();
  chatPanes.querySelector(`.chat-pane[data-thread="${peerId}"]`)?.remove();
  if (state.activeThread === peerId) switchTab("room");
}

function switchTab(threadId) {
  state.activeThread = threadId;
  for (const tab of chatTabs.querySelectorAll(".chat-tab")) {
    tab.classList.toggle("active", tab.dataset.thread === threadId);
    if (tab.dataset.thread === threadId) tab.querySelector(".unread")?.setAttribute("hidden", "");
  }
  for (const pane of chatPanes.querySelectorAll(".chat-pane")) {
    pane.classList.toggle("active", pane.dataset.thread === threadId);
  }
  state.unread.set(threadId, 0);
  composerInput.placeholder = threadId === "room" ? `Message #${state.room}` : `Message ${userLabel(threadId)}`;
  composerInput.focus();
}

function bumpUnread(threadId) {
  if (state.activeThread === threadId) return;
  const n = (state.unread.get(threadId) || 0) + 1;
  state.unread.set(threadId, n);
  const tab = chatTabs.querySelector(`.chat-tab[data-thread="${threadId}"]`);
  const badge = tab?.querySelector(".unread");
  if (badge) { badge.hidden = false; badge.textContent = String(n); }
}

function userLabel(id) {
  return state.users.get(id)?.username || "unknown";
}

function getLog(threadId) {
  return threadId === "room" ? $("roomLog") : document.getElementById(`log-${threadId}`);
}

function renderMessage(threadId, { username, text, ts, self }) {
  const log = getLog(threadId);
  if (!log) return;
  const el = document.createElement("div");
  el.className = "msg" + (self ? " self" : "");
  const time = new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `
    <div class="msg-head"><span class="msg-name">${escapeHtml(username)}</span><span class="msg-time">${time}</span></div>
    <div class="msg-body"></div>`;
  el.querySelector(".msg-body").textContent = text; // textContent → safe against HTML injection
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function addSystemMessage(text, threadId) {
  const log = getLog(threadId);
  if (!log) return;
  const el = document.createElement("div");
  el.className = "msg-system";
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

composerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = composerInput.value.trim();
  if (!text) return;
  composerInput.value = "";

  if (state.activeThread === "room") {
    send({ type: "chat", text });
    renderMessage("room", { username: state.username, text, ts: Date.now(), self: true });
  } else {
    send({ type: "dm", to: state.activeThread, text });
    renderMessage(state.activeThread, { username: state.username, text, ts: Date.now(), self: true });
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ==========================================================================
// Calls: join / leave, local media
// ==========================================================================
joinAudioBtn.addEventListener("click", () => startCall("audio"));
joinVideoBtn.addEventListener("click", () => startCall("video"));
leaveCallBtn.addEventListener("click", leaveCall);
screenBtn.addEventListener("click", toggleScreenShare);
muteBtn.addEventListener("click", toggleMute);
camBtn.addEventListener("click", toggleCamera);

async function startCall(kind) {
  if (state.call.active) return;
  try {
    const constraints = kind === "video" ? { audio: true, video: { width: 640, height: 480 } } : { audio: true, video: false };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.call.active = true;
    state.call.kind = kind;
    state.call.localStream = stream;

    if (kind === "video") {
      addVideoTile(state.selfId, stream, "You", true);
      videoGrid.hidden = false;
    }

    joinAudioBtn.hidden = true;
    joinVideoBtn.hidden = true;
    screenBtn.hidden = false;
    muteBtn.hidden = false;
    camBtn.hidden = kind !== "video";
    leaveCallBtn.hidden = false;

    send({ type: "call-join", kind });
    addSystemMessage(`You joined the ${kind} call.`, "room");
  } catch (err) {
    addSystemMessage(`Couldn't access ${kind === "video" ? "camera/mic" : "mic"}: ${err.message}`, "room");
  }
}

function leaveCall() {
  if (!state.call.active) return;
  send({ type: "call-leave" });

  for (const id of Array.from(state.peers.keys())) teardownPeer(id);
  for (const track of state.call.localStream?.getTracks() || []) track.stop();
  if (state.call.screenStream) {
    for (const track of state.call.screenStream.getTracks()) track.stop();
  }

  removeVideoTile(state.selfId);
  videoGrid.hidden = videoGrid.children.length === 0;

  state.call.active = false;
  state.call.kind = null;
  state.call.localStream = null;
  state.call.screenStream = null;
  state.call.screenSharing = false;

  joinAudioBtn.hidden = false;
  joinVideoBtn.hidden = false;
  screenBtn.hidden = true;
  muteBtn.hidden = true;
  camBtn.hidden = true;
  leaveCallBtn.hidden = true;
  muteBtn.classList.remove("active");
  camBtn.classList.remove("active");
  screenBtn.classList.remove("active");
  screenBtnLabel.textContent = "Share screen";

  addSystemMessage("You left the call.", "room");
}

function toggleMute() {
  const track = state.call.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  muteBtn.classList.toggle("active", !track.enabled);
  muteBtn.querySelector("span")?.remove();
}

function toggleCamera() {
  const track = state.call.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.classList.toggle("active", !track.enabled);
}

async function toggleScreenShare() {
  if (!state.call.active) return;

  if (!state.call.screenSharing) {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      state.call.screenStream = screenStream;
      state.call.screenSharing = true;

      await replaceOrAddVideoTrack(screenTrack);
      const selfTile = videoGrid.querySelector(`.video-tile[data-id="${state.selfId}"] video`);
      if (selfTile) selfTile.srcObject = screenStream;
      videoGrid.hidden = false;

      screenTrack.addEventListener("ended", () => stopScreenShare());
      screenBtn.classList.add("active");
      screenBtnLabel.textContent = "Stop sharing";
      send({ type: "screen-state", sharing: true });
    } catch (err) {
      // user cancelled the picker — no-op
    }
  } else {
    stopScreenShare();
  }
}

async function stopScreenShare() {
  if (!state.call.screenSharing) return;
  for (const track of state.call.screenStream.getTracks()) track.stop();
  state.call.screenStream = null;
  state.call.screenSharing = false;

  const camTrack = state.call.localStream?.getVideoTracks()[0];
  if (camTrack) {
    await replaceOrAddVideoTrack(camTrack);
    const selfTile = videoGrid.querySelector(`.video-tile[data-id="${state.selfId}"] video`);
    if (selfTile) selfTile.srcObject = state.call.localStream;
  }
  screenBtn.classList.remove("active");
  screenBtnLabel.textContent = "Share screen";
  send({ type: "screen-state", sharing: false });
}

// Swap the outgoing video track across every open peer connection. If a
// connection has no video sender yet (audio-only call sharing a screen for
// the first time), add the track instead — this fires onnegotiationneeded,
// which the perfect-negotiation setup below handles automatically.
async function replaceOrAddVideoTrack(track) {
  for (const peer of state.peers.values()) {
    const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) {
      await sender.replaceTrack(track);
    } else {
      peer.pc.addTrack(track, state.call.localStream || new MediaStream([track]));
    }
  }
}

// ==========================================================================
// WebRTC mesh: perfect negotiation per peer connection
// ==========================================================================
function getOrCreatePeer(peerId, isInitiator, username) {
  let peer = state.peers.get(peerId);
  if (peer) return peer;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peer = { pc, polite: !isInitiator, makingOffer: false, ignoreOffer: false, username };
  state.peers.set(peerId, peer);

  for (const track of state.call.localStream?.getTracks() || []) {
    pc.addTrack(track, state.call.localStream);
  }

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: "signal", to: peerId, data: { kind: "offer", sdp: pc.localDescription } });
    } catch (err) {
      console.error("negotiation error", err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "signal", to: peerId, data: { kind: "candidate", candidate } });
  };

  pc.ontrack = (evt) => {
    const stream = evt.streams[0] || new MediaStream([evt.track]);
    addVideoTile(peerId, stream, username || userLabel(peerId), false);
    videoGrid.hidden = false;
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      // leave the tile up on transient "disconnected" — only tear down on
      // a hard failure/close so brief network hiccups don't flash the UI
      if (pc.connectionState === "failed") teardownPeer(peerId);
    }
  };

  return peer;
}

function initiatePeerConnection(peerId, username) {
  getOrCreatePeer(peerId, true, username);
}

async function handleSignal(from, data) {
  const peer = getOrCreatePeer(from, false, userLabel(from));
  const pc = peer.pc;

  if (data.kind === "offer" || data.kind === "answer") {
    const desc = data.sdp;
    const offerCollision = data.kind === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    if (offerCollision) {
      await Promise.all([
        pc.setLocalDescription({ type: "rollback" }),
        pc.setRemoteDescription(desc),
      ]);
    } else {
      await pc.setRemoteDescription(desc);
    }

    if (data.kind === "offer") {
      await pc.setLocalDescription();
      send({ type: "signal", to: from, data: { kind: "answer", sdp: pc.localDescription } });
    }
  } else if (data.kind === "candidate") {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!peer.ignoreOffer) console.error("ICE candidate error", err);
    }
  }
}

function teardownPeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  state.peers.delete(peerId);
}

// ==========================================================================
// Video tiles
// ==========================================================================
function addVideoTile(id, stream, label, isSelf) {
  let tile = videoGrid.querySelector(`.video-tile[data-id="${id}"]`);
  if (!tile) {
    const node = videoTileTpl.content.cloneNode(true);
    tile = node.querySelector(".video-tile");
    tile.dataset.id = id;
    videoGrid.appendChild(node);
    tile = videoGrid.querySelector(`.video-tile[data-id="${id}"]`);
  }
  const video = tile.querySelector("video");
  video.srcObject = stream;
  video.muted = !!isSelf;
  tile.querySelector(".video-tile-label").textContent = label;
}

function removeVideoTile(id) {
  videoGrid.querySelector(`.video-tile[data-id="${id}"]`)?.remove();
  if (videoGrid.children.length === 0) videoGrid.hidden = true;
}

// ==========================================================================
// Mesh visualization — the signature element. Nodes = participants, lines =
// live RTCPeerConnections, colored by their actual connectionState.
// ==========================================================================
function startMeshViz() {
  const ctx = meshCanvas.getContext("2d");
  const w = meshCanvas.width, h = meshCanvas.height;

  function draw() {
    ctx.clearRect(0, 0, w, h);
    const ids = [state.selfId, ...state.peers.keys()];
    const n = ids.length;
    if (n === 0) { requestAnimationFrame(draw); return; }

    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6;
    const pts = ids.map((id, i) => {
      const angle = n === 1 ? 0 : (i / n) * Math.PI * 2 - Math.PI / 2;
      return { id, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
    });

    // connection lines
    for (let i = 1; i < pts.length; i++) {
      const peer = state.peers.get(pts[i].id);
      const cs = peer?.pc.connectionState;
      ctx.strokeStyle = cs === "connected" ? "#35d399" : cs === "connecting" || cs === "new" ? "#f2a93b" : "#2a323a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }

    // nodes
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 0 ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? "#5b8def" : "#e7ecef";
      ctx.fill();
    });

    requestAnimationFrame(draw);
  }
  draw();
}

// Small ambient mesh animation on the login card — purely decorative.
(function gateMeshAnim() {
  if (!gateMeshCanvas) return;
  const ctx = gateMeshCanvas.getContext("2d");
  const w = gateMeshCanvas.width, h = gateMeshCanvas.height;
  const nodes = Array.from({ length: 6 }, (_, i) => ({
    angle: (i / 6) * Math.PI * 2,
    speed: 0.15 + Math.random() * 0.1,
    r: 60 + Math.random() * 20,
  }));
  let t = 0;
  function frame() {
    t += 0.01;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const pts = nodes.map((n) => ({
      x: cx + Math.cos(n.angle + t * n.speed) * n.r,
      y: cy + Math.sin(n.angle + t * n.speed) * n.r,
    }));
    ctx.strokeStyle = "rgba(53,211,153,0.25)";
    ctx.lineWidth = 1;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
    ctx.fillStyle = "#35d399";
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.fillStyle = "#5b8def";
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    requestAnimationFrame(frame);
  }
  frame();
})();
