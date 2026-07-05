// MeshCall — signaling + chat backend
//
// One Durable Object instance per room name. It holds the live WebSocket
// connections for everyone in that room and relays three kinds of traffic:
//   1. Room-wide text chat
//   2. Private DMs (routed to a single session id)
//   3. WebRTC signaling (offer/answer/ICE) + call roster, also routed
//      point-to-point so every client can build its own mesh of
//      RTCPeerConnections. The Worker never touches media — it only ever
//      sees JSON signaling blobs, so this stays cheap to run.

const MAX_MSG_LEN = 4000;
const MAX_NAME_LEN = 32;
const HISTORY_CAP = 200; // messages kept per thread in KV

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.roomName = null;
    /** @type {Map<WebSocket, {id: string, username: string|null, inCall: string|null}>} */
    this.sessions = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    this.roomName = decodeURIComponent(url.pathname.slice("/ws/".length)) || "lobby";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- KV-backed history -------------------------------------------------
  // Room chat: key "room:{room}"
  // DMs: key "dm:{room}:{usernameA}|{usernameB}" (sorted, case-insensitive)
  // so either participant can load the same thread across reconnects.

  roomHistoryKey() {
    return `room:${this.roomName}`;
  }

  dmHistoryKey(usernameA, usernameB) {
    const pair = [usernameA, usernameB].map((u) => u.toLowerCase()).sort();
    return `dm:${this.roomName}:${pair[0]}|${pair[1]}`;
  }

  async loadHistory(key) {
    if (!this.env.CHAT_KV) return [];
    const list = await this.env.CHAT_KV.get(key, "json");
    return Array.isArray(list) ? list : [];
  }

  async appendHistory(key, entry) {
    if (!this.env.CHAT_KV) return;
    const list = await this.loadHistory(key);
    list.push(entry);
    if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP);
    await this.env.CHAT_KV.put(key, JSON.stringify(list));
  }


  handleSession(ws) {
    ws.accept();

    const session = { id: crypto.randomUUID(), username: null, inCall: null, ws };
    this.sessions.set(ws, session);

    ws.addEventListener("message", (evt) => {
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }
      this.handleMessage(session, data).catch((err) => console.error("handleMessage error", err));
    });

    const onClose = () => {
      if (!this.sessions.has(ws)) return;
      this.sessions.delete(ws);
      this.broadcast({ type: "user-left", id: session.id });
      if (session.inCall) {
        this.broadcast({ type: "call-left", id: session.id });
      }
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onClose);
  }

  async handleMessage(session, data) {
    switch (data.type) {
      case "join": {
        session.username = String(data.username || "Anonymous").slice(0, MAX_NAME_LEN);

        const users = [];
        for (const s of this.sessions.values()) {
          if (s !== session && s.username) {
            users.push({ id: s.id, username: s.username, inCall: s.inCall });
          }
        }

        this.send(session.ws, { type: "joined", id: session.id, users });

        const history = await this.loadHistory(this.roomHistoryKey());
        if (history.length) {
          this.send(session.ws, { type: "history", thread: "room", messages: history });
        }

        this.broadcast(
          { type: "user-joined", id: session.id, username: session.username },
          session.ws
        );
        break;
      }

      case "chat": {
        if (!session.username) return;
        const entry = {
          from: session.username,
          text: String(data.text || "").slice(0, MAX_MSG_LEN),
          ts: Date.now(),
        };
        await this.appendHistory(this.roomHistoryKey(), entry);
        this.broadcast(
          { type: "chat", from: session.id, username: session.username, text: entry.text, ts: entry.ts },
          session.ws
        );
        break;
      }

      case "dm": {
        if (!session.username) return;
        const target = this.findSession(data.to);
        if (!target || !target.username) return;
        const entry = {
          from: session.username,
          text: String(data.text || "").slice(0, MAX_MSG_LEN),
          ts: Date.now(),
        };
        await this.appendHistory(this.dmHistoryKey(session.username, target.username), entry);
        this.send(target.ws, {
          type: "dm",
          from: session.id,
          username: session.username,
          text: entry.text,
          ts: entry.ts,
        });
        break;
      }

      case "dm-history": {
        if (!session.username || !data.with) return;
        const messages = await this.loadHistory(this.dmHistoryKey(session.username, String(data.with)));
        this.send(session.ws, { type: "dm-history", with: data.with, messages });
        break;
      }

      // WebRTC signaling relay: offer / answer / ICE candidate, always
      // addressed to exactly one peer id.
      case "signal": {
        const target = this.findSession(data.to);
        if (!target) return;
        this.send(target.ws, {
          type: "signal",
          from: session.id,
          data: data.data,
        });
        break;
      }

      // Call roster management. "join" replies with the current roster so
      // the *joiner* is always the one who initiates offers — this avoids
      // both sides racing to offer each other (glare).
      case "call-join": {
        const kind = data.kind === "video" ? "video" : "audio";
        const roster = [];
        for (const s of this.sessions.values()) {
          if (s !== session && s.inCall) {
            roster.push({ id: s.id, username: s.username, kind: s.inCall });
          }
        }
        session.inCall = kind;
        this.send(session.ws, { type: "call-roster", roster });
        this.broadcast(
          { type: "call-joined", id: session.id, kind },
          session.ws
        );
        break;
      }

      case "call-leave": {
        session.inCall = null;
        this.broadcast({ type: "call-left", id: session.id }, session.ws);
        break;
      }

      case "screen-state": {
        this.broadcast(
          { type: "screen-state", id: session.id, sharing: !!data.sharing },
          session.ws
        );
        break;
      }

      default:
        break;
    }
  }

  findSession(id) {
    for (const s of this.sessions.values()) {
      if (s.id === id) return s;
    }
    return null;
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // socket already gone; the close handler will clean it up
    }
  }

  broadcast(obj, excludeWs) {
    const msg = JSON.stringify(obj);
    for (const s of this.sessions.values()) {
      if (s.ws === excludeWs) continue;
      try {
        s.ws.send(msg);
      } catch {
        // ignore; will be cleaned up on its own close event
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/ws/")) {
      const room = decodeURIComponent(url.pathname.slice("/ws/".length)) || "lobby";
      const id = env.ROOMS.idFromName(room);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // Everything else is static frontend, served from ./public
    return env.ASSETS.fetch(request);
  },
};
