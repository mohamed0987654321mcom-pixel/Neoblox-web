# Neoblox server — real online multiplayer, party & voice chat

This is what makes Neoblox *actually* online: a small Node.js server that the game
connects to automatically once you deploy it. It gives you:

- **Real multiplayer** — everyone who opens your domain sees each other, in the lobby
  and inside any world, not just people viewing the same claude.ai tab.
- **Party system** — create a party, share the 5-letter code (or invite from the
  player list), see who's in it.
- **Chat that persists across the site** — a "Party & chat" bubble in the bottom-right
  corner, on every screen (name entry, lobby, a course, NeoStudio) — not just inside
  the 3D view. Party-only or site-wide ("Global") tabs.
- **Voice chat** — a mic button in the party panel opens a peer-to-peer voice call
  between everyone in your party (WebRTC), no phone numbers or third-party app needed.
- **World publishing** — "Publish to Neoblox" in NeoStudio saves to this server (a
  `data/worlds.json` file) instead of needing claude.ai at all.
- **Touch controls on phone/tablet** — a virtual joystick (bottom-left) drives movement, a
  jump button (bottom-right) handles jumping, and dragging anywhere else on the scene looks
  around — the touch equivalent of mouse-look. These only appear once you're actually inside
  a world or NeoStudio (not in the lobby hub, to leave room for the world-select card), and
  only on touch devices — desktop mouse/keyboard is untouched.
- **PWA install on iPhone/iPad** — the site detects iOS/iPadOS itself and shows its own
  "Add to Home Screen" instructions overlay (Safari has no install-prompt API, so this is a
  custom in-page card, not the browser's UI). Until it's installed, the page stays a normal,
  network-light tab. Once it's opened from the actual Home Screen icon (standalone mode), a
  service worker (`public/sw.js`) precaches the full game — three.js, icons, everything —
  into real on-device storage, so from that point on it behaves like a proper offline-capable
  app instead of just a bookmark. Nothing extra to configure — this all just works once the
  server is deployed.

The game client (`public/index.html`) already knows how to find this server: it looks
for a WebSocket at `wss://yourdomain.com/ws` (same domain, automatically — no config).
If it can't connect (e.g. viewed on claude.ai, or before you've deployed this), it just
falls back to solo/offline mode. Nothing breaks either way.

## What you need

Any place that can run a **persistent Node.js process** and keep a **WebSocket
connection open**. That rules out old-school shared/cPanel hosting (it only serves
static files/PHP) — but covers almost everything else:

- A VPS (DigitalOcean, Linode, Hetzner, a cheap AWS/GCP box, etc.) — full control, cheap.
- A PaaS (Railway, Render, Fly.io, Heroku-style) — push your code, it just runs.

If what you already have is shared/static hosting only, the easiest fix is: keep your
static hosting for anything else you use it for, and run **this folder** on a small
free/cheap VPS or PaaS instance, then point a subdomain (e.g. `play.yourdomain.com`)
at it. Either way you end up with one URL that serves the whole game.

## Option A — a VPS (DigitalOcean/Linode/Hetzner/etc., full SSH access)

1. **Get Node onto the server** (Ubuntu example):
   ```
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. **Upload this folder** (`neoblox-server/`) to the server, e.g. with `scp` or `git`:
   ```
   scp -r neoblox-server you@your-server-ip:/home/you/neoblox-server
   ```
3. **Install & run it**:
   ```
   cd /home/you/neoblox-server
   npm install
   npm start
   ```
   You should see `Neoblox server listening on :8080`. Ctrl-C stops it — for a real
   deployment you want it to survive reboots and reconnects, so use PM2:
   ```
   sudo npm install -g pm2
   pm2 start server.js --name neoblox
   pm2 save
   pm2 startup   # follow the one printed command to enable on-boot start
   ```
4. **Put it behind Nginx with a real domain + HTTPS** (needed for `wss://` and for
   iPhone's "Add to Home Screen" to work). Point your domain's DNS `A` record at the
   server's IP first, then:
   ```
   sudo apt-get install -y nginx certbot python3-certbot-nginx
   ```
   Create `/etc/nginx/sites-available/neoblox`:
   ```
   server {
     listen 80;
     server_name yourdomain.com;
     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   ```
   Then:
   ```
   sudo ln -s /etc/nginx/sites-available/neoblox /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d yourdomain.com   # free SSL cert, auto-configures https + wss
   ```
   That's it — `https://yourdomain.com` now serves the live game.

## Option B — a PaaS (Railway, Render, Fly.io, etc.)

These all work the same basic way: connect the repo/folder, they detect
`package.json`, run `npm install && npm start`, and give you a public HTTPS URL with
WebSockets already working (no Nginx/certbot needed). Steps are almost identical
across providers:

1. Push this `neoblox-server/` folder to its own Git repo (or use the provider's CLI
   to deploy a folder directly, if it offers that).
2. Create a new "Web Service" and point it at that repo.
3. Leave build command as `npm install` and start command as `npm start` (most
   providers auto-detect this from `package.json`).
4. Once it's live, add your custom domain in the provider's dashboard and follow
   their instructions for the DNS record (usually a `CNAME`).

Cost note: most of these have a free or few-dollars-a-month tier, which is plenty for
a game like this with a handful of concurrent players.

## Custom domain, either way

Once the server is reachable at your domain over HTTPS, that domain *is* the game —
share that link with anyone; the game plus all its assets (three.js, icons, etc.)
serve straight from `public/`. Mobile Safari on iPhone/iPad works the same as
desktop, and **Share → Add to Home Screen** installs it with a proper app icon and
no address bar.

## A note on voice chat reliability

Voice uses WebRTC with a free public STUN server, which works for most networks. It
does **not** include a TURN relay (that typically needs a paid service like Twilio's
or a self-hosted `coturn`), so voice can fail to connect for players on strict
corporate/school networks or behind certain routers. If that becomes a real problem
for your players, look into adding a TURN provider and add its `urls`/`username`/
`credential` to the `ICE_SERVERS` array in the game's client code.

## Data

Published worlds live in `data/worlds.json`, created automatically. Back this file up
if you care about not losing published builds — it's the only thing this server
persists to disk.

## Files

- `server.js` — the whole server: static file serving, the WebSocket realtime layer
  (presence, party, chat, voice signaling), and the `/api/worlds` REST endpoints.
- `public/` — the game client itself (same file the Electron app and claude.ai
  artifact use), plus `manifest.json` and app icons for PWA install.
- `public/battle-assets/` — 3D model assets used by Thunder Battle.
- `data/worlds.json` — published worlds (created on first publish).

## Credits

- `public/battle-assets/thunderbot.glb` is "RobotExpressive" by Tomás Laulhé
  (assets by Quaternius), CC0-licensed (public domain), sourced via the three.js
  project's example assets (github.com/mrdoob/three.js). Used as Thunder Battle's
  player character model.
