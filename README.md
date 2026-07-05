# MeshCall

A small chat app that runs entirely on a Cloudflare Worker: text chat, private
DMs, 1:1 voice calls, group video calls, and screen share — all peer-to-peer
over WebRTC, using Google's public STUN servers for NAT traversal. The Worker
only ever relays JSON signaling messages and text; no audio/video ever
touches it.

## How it works

- **`src/worker.js`** — the Worker entry point routes `/ws/{room}` requests
  to a Durable Object (`ChatRoom`), one instance per room name. Everything
  else falls through to the static asset binding (`public/`).
- **`ChatRoom` (Durable Object)** — holds the live WebSocket connections for
  a room in memory and relays:
  - room-wide chat messages
  - private DMs (routed to one recipient by session id)
  - WebRTC signaling (offer/answer/ICE candidates), routed peer-to-peer
  - a "call roster": when you join the shared voice/video call, the room
    tells you who's already in it so *you* initiate the offers — this
    avoids both sides racing to offer each other at once.
- **Chat history** — persisted in a KV namespace bound as `CHAT_KV`. Room
  chat is stored under `room:{room}`; DMs are stored under
  `dm:{room}:{userA}|{userB}` (usernames sorted, case-insensitive) so either
  side of a DM can load the same thread again later. Each thread keeps its
  most recent 200 messages. Room history is sent automatically when you
  join; DM history is fetched the first time you open a DM tab with someone.
- **`public/app.js`** — the client. Opens one `RTCPeerConnection` per other
  call participant (a full mesh), using
  [perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
  so screen share (which renegotiates the connection) doesn't glare with
  concurrent offers. STUN servers:
  ```
  stun:stun.l.google.com:19302
  stun:stun1.l.google.com:19302
  stun:stun2.l.google.com:19302
  stun:stun3.l.google.com:19302
  stun:stun4.l.google.com:19302
  ```

### Mesh, not an SFU

Group calls connect every participant directly to every other participant
(an N² mesh). That's the right shape for a Worker-only backend — Workers
don't run media servers — and it works well for small groups (a handful of
people). If you need calls with dozens of participants, you'd want to route
media through a real SFU (e.g. Cloudflare Calls, LiveKit, mediasoup) instead
of a mesh; that's a bigger, separate piece of infrastructure.

### No TURN server

STUN alone gets peers past most home routers, but it can't help two peers
that are both behind symmetric NATs or strict corporate firewalls — that
needs a TURN relay. This build doesn't include one. If calls fail to connect
for some users, add a TURN server (e.g. Cloudflare Calls TURN, Twilio, or
your own coturn) to `ICE_SERVERS` in `public/app.js`.

## Set up the KV namespace

Chat history needs a KV namespace called `CHAT_KV`. Create it once, then
paste the ids it prints into `wrangler.toml`:

```bash
npx wrangler kv namespace create CHAT_KV
npx wrangler kv namespace create CHAT_KV --preview
```

Each command prints an id — put them into the `[[kv_namespaces]]` block in
`wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CHAT_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"          # from the first command
preview_id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"  # from the --preview command
```

The app still runs fine without this — chat, DMs, and calls all work — it
just won't remember message history between reconnects.

## Run it locally

```bash
npm install
npm run dev
```

Wrangler will print a local URL (typically `http://localhost:8787`). Open it
in two browser tabs (or two devices) with the same room name to test chat
and calls.

## Deploy to Cloudflare

```bash
npm install
npx wrangler login   # once, to authenticate with your Cloudflare account
npm run deploy
```

Wrangler will provision the Durable Object namespace and static assets
automatically from `wrangler.toml`, then print your `*.workers.dev` URL.

## Notes / limits

- Usernames aren't authenticated — anyone who knows a room name can join it.
  Treat room names like a shared secret / party line, the way a Jitsi or
  Google Meet link works.
- Chat history is stored in `CHAT_KV` per room/DM thread (last 200 messages
  each). KV is eventually consistent, so a message can take a moment to
  show up if read from a different Cloudflare location right away — fine
  for chat history, just not instant-strong-consistency.
- Camera/mic/screen-share all require HTTPS in production (Workers gives you
  this automatically) — `getUserMedia`/`getDisplayMedia` won't work over
  plain `http://` except on `localhost`.
