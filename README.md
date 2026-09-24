# starboarder

A starboard bot for [Fluxer](https://fluxer.app): when someone reacts to a
message with a star, the bot archives it to a **Starboard** channel with an
embed and a jump link. Built for self-hosted instances and friends servers.

```
⭐ 3 | #general
Jump to message          <- clickable link
┌──────────────────────────────────────┐
│ avatar  Aria                          │
│ "you guys won't believe what the     │
│  gateway said"                        │
│                            Message ID …│
└──────────────────────────────────────┘
```

## What it does

- Connects to your instance's Gateway as a bot and listens for
  `MESSAGE_REACTION_ADD` with the configured emoji (default ⭐).
- Counts the reaction from the message's reaction summary (authoritative, so
  restarts and race conditions don't cause double posts or missed counts).
- When the count reaches `THRESHOLD` (default 1), posts an embed with the
  author, content, first image attachment, and a jump link into the channel
  named `starboard` (case-insensitive; or set an exact channel ID).
- Remembers what it already posted in `data/starred.json`, so restarts never
  duplicate entries. Removing stars never deletes an entry — the archive is
  write-once.
- Never stars messages inside the starboard channel itself.

## One-time setup on your instance

### 1. Create a bot application

With a **user session token** (log in via the web app and grab the token from
your authenticated client, or use `POST /v1/auth/login`):

```bash
curl -X POST https://chat.example.com/v1/oauth2/applications \
  -H "Authorization: flx_YOUR_USER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "starboarder"}'
```

The response contains `bot.token` — the **bot token** (`<application_id>.<secret>`).
It is shown **once**; if you lose it, rotate with
`POST /v1/oauth2/applications/{id}/bot/reset-token`.

### 2. Install the bot into your guild

Open this URL in a browser where you are logged in to Fluxer:

```
https://chat.example.com/v1/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=84992
```

`permissions=84992` is `VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | READ_MESSAGE_HISTORY`.
Select your guild and confirm. Make sure the bot can see the Starboard channel
(no permission overwrites blocking it).

### 3. Configure

```bash
cp .env.example .env
# edit .env: set INSTANCE_URL and BOT_TOKEN
```

All settings live in `.env` and are read at startup. See `.env.example` for
the full reference. The bot resolves the Starboard channel **per guild** by
name, so it works in every guild it is installed in.

## Running

### Docker (recommended)

```bash
docker compose up -d --build
docker logs -f starboarder-starboarder-1   # or: docker compose logs -f
```

The image is built locally; no registry involved. The dedup store lives in the
`starboarder-data` volume. The container healthcheck watches a heartbeat file
the bot touches whenever the gateway connection is alive, so a wedged
connection ends in a container restart (`restart: unless-stopped`).

Updating:

```bash
git pull && docker compose up -d --build
```

### Same-server internal routing (optional optimization)

If Fluxer runs in Docker on the same host, the bot can talk to the `api` and
`gateway` containers directly instead of hairpinning through the public
origin:

1. Find the network name (the self-hosting stack with `name: fluxer` creates
   `fluxer_fluxer`):

   ```bash
   docker network ls | grep fluxer
   ```

2. In `docker-compose.yml`, uncomment the `networks: [fluxer_fluxer]` line and
   the matching `networks:` section at the bottom.
3. In `.env`, set:

   ```bash
   API_URL=http://api:8080
   GATEWAY_URL=ws://gateway:8080
   ```

   When both are set, instance discovery (`/.well-known/fluxer`) is skipped.
   Keep `INSTANCE_URL` (or set `WEB_APP_BASE_URL`) — jump links must still use
   the public URL humans open.

### Without Docker

```bash
npm install
npm run build
npm start          # or: npm run dev for hot-reload during development
```

## Development

- `npm run typecheck` — type-check without emitting
- `npm run smoke` — end-to-end test against a mock Fluxer instance (discovery,
  gateway identify, reaction handling, threshold, embed shape, dedup store,
  disconnect/resume). Runs the built output, so `npm run build` first.

## Behavior notes

- **Threshold**: `THRESHOLD=1` posts on the first star. With a higher value,
  the bot re-checks on every new star and posts once, when the count crosses
  the threshold.
- **Debounce**: reaction bursts on one message are coalesced for ~1s before
  the count is checked.
- **Persistence**: `data/starred.json` maps message ID → starboard post ID.
  Delete the file (or a single entry) to allow re-posting.
- **Rate limits**: the HTTP client honors `Retry-After` on 429s; the gateway
  client heartbeats on the advertised interval, resumes sessions within the
  60s retention window, and reconnects with backoff.

## License

MIT
