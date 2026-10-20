# Neoblox server — real online multiplayer, party & voice chat

## What's in Neoblox

- **Home** — a game platform front page: who's online (and what they're playing), Continue
  and Recommended rows with live 3D thumbnails, Discover (Popular / Top Rated / New / Most
  Visited + search), a page for every experience with a big Play button, thumbs up/down,
  visits and active players.
- **Avatar** — blocky characters with a smiley face, body colors, your owned items, the
  Ender skin or your own uploaded `.glb`.
- **Avatar Shop** — hats, faces, glasses, backpacks, capes and wings bought with tokens.
  Tokens come from **Quests** (new accounts get a 50-token welcome gift).
- **Experiences** — Neoblox Lobby (the Fortnite-style hub), Sky Rush (a checkpoint obby),
  Thunder Battle, and every world people publish. In-game: menu (Players / Settings /
  Help, Reset Character, Leave), chat with bubble chat, a player list with leaderstats,
  health, falling apart and respawning at your checkpoint, an orbit camera (right-drag,
  wheel zoom, Shift for shift-lock).
- **NeoStudio** — a game-studio editor: Toolbox, Explorer, Properties, Output; Select /
  Move / Rotate / Build / Delete; block, wedge, sphere and cylinder parts with any color
  and material; kill bricks, checkpoints, jump pads; day/sunset/night lighting; Play test
  with F5; Publish.
- **Scripting (JavaScript, Roblox-style)** — insert a Script into a part, into
  ServerScriptService, or into an on-screen button, and write JavaScript against the same
  API Roblox uses (see below). NeoStudio opens scripts as tabs with syntax highlighting,
  autocomplete, live error checking, an Examples menu and a Help sheet; errors show in
  Output (click one to jump to the line). In published games, F9 opens the Developer Console.
- **Pictures** — logged-in builders upload pictures ("My Pictures") and use them as a game's
  **cover** (shown on Home and the game page instead of the 3D snapshot), as **decals** on any
  side of a part (posters, signs, logos), or as on-screen **ImageLabels**. Scripts can use them
  too: `Instance.new("Decal")` with `Texture`/`Face`, `Instance.new("ImageLabel")` with `Image`.
  The browser shrinks each picture to 1024px and re-encodes it before upload (which also
  strips photo metadata like GPS location); the server only keeps real PNG/JPEG/WebP/GIF data
  (2 MB max, 150 per account) and serves them at `/img/<id>` as plain images. The uploader can
  delete a picture; so can an admin (`DELETE /api/images/<id>` with an `X-Admin-Password`
  header) if something inappropriate gets uploaded.

Run the server checks with `npm test`.

## Scripting

Scripts are JavaScript, shaped like Roblox Lua:

```js
// a kill brick — a Script inside a part
const part = script.Parent;

part.Touched.Connect((hit) => {
  const humanoid = hit.Parent.FindFirstChild("Humanoid");
  if (humanoid) humanoid.Health = 0;
});
```

| Roblox Lua | Neoblox JavaScript |
| --- | --- |
| `part.Touched:Connect(function(hit) … end)` | `part.Touched.Connect((hit) => { … })` |
| `wait(1)` | `await wait(1)` |
| `Vector3.new(0, 5, 0)` | `new Vector3(0, 5, 0)` (or `Vector3.new(…)`) |
| `part:Destroy()` | `part.Destroy()` |

What's there: `game`, `workspace`, `script`, `Instance.new` (Part, Model, Folder,
Int/Number/String/BoolValue, ClickDetector, PointLight, Sound, TextLabel/TextButton,
BindableEvent, RemoteEvent…), parts (Position, Size, Orientation, CFrame, Color, Material,
Transparency, CanCollide, Anchored, Shape, Touched/TouchEnded), `Players` (LocalPlayer,
PlayerAdded, GetPlayerFromCharacter, Character, Humanoid with Health/WalkSpeed/JumpPower,
leaderstats on the leaderboard), `TweenService`, `RunService` (Heartbeat), `Debris`,
`Lighting.ClockTime`, `UserInputService`, `StarterGui:SetCore("SendNotification")`,
`workspace.Raycast`, `wait` / `task.*`, `Vector3`, `Color3`, `CFrame`, `UDim2`, `TweenInfo`,
`BrickColor`, `Enum`. Neoblox extras: `part.Gameplay = "KillBrick" | "Checkpoint" | "JumpPad"`
and `player.GiveXP(n)`.

How it runs: scripts run on each player's own device while they're in a game (or in a
NeoStudio playtest). They never run in the page itself — `public/rbx/neoscript.js` runs
them inside QuickJS, a separate JavaScript engine compiled to WebAssembly
(`public/vendor/quickjs`, MIT), so a script has no `window`, DOM, network, cookies or
storage — only the game API in `public/rbx/neoscript-runtime.js`, and every call from it
into the game is checked and clamped. A CPU deadline stops endless loops ("Script
timeout"), and there are caps on memory, new parts, lights, on-screen labels, sounds and
notifications. Worlds made with the old one-line commands (`say "hi"`, `color #ff0000`…)
are converted to JavaScript automatically when they load.

This is what makes Neoblox *actually* online: a small Node.js server that the game
connects to automatically once you deploy it. It gives you:

- **Real multiplayer** — everyone who opens your domain sees each other, in the lobby
  and inside any world, not just people viewing the same claude.ai tab.
- **Party system** — create a party, share the 5-letter code (or invite from the
  player list), see who's in it.
- **Chat that persists across the site** — a "Party & chat" bubble in the bottom-right
  corner, on every screen (name entry, lobby, a course, NeoStudio) — not just inside
  the 3D view. Party-only or site-wide ("Global") tabs. Every message also flashes briefly
  near the top of the screen as a fading live feed, so you catch what's being said even
  with the chat panel closed.
- **Voice chat** — a mic button in the party panel opens a peer-to-peer voice call
  between everyone in your party (WebRTC), no phone numbers or third-party app needed.
  Whenever someone's mic actually picks up speech, a small 🎙️ icon lights up over their
  head in the 3D world (for both party voice and the global voice room), so you can tell
  who's talking at a glance.
- **Global voice room** — a separate, site-wide voice channel (🌐 in the party panel) that
  anyone online can join, independent of parties. Capped at 12 people at once (mesh WebRTC —
  every extra person adds a connection to everyone else already in, so this keeps it sane).
- **Lobby music** — a 🎵 button next to the party dock lets you upload your own audio file
  and play it as personal background music while you're in the lobby. Plays only for you
  (nothing is sent to the server or other players), pauses automatically when you head into
  a world/battle, and resumes when you're back.
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

Everything the server keeps lives in `data/` (created automatically): published worlds
(`worlds.json`), accounts with tokens, quests and Avatar Shop items (`users.json`),
uploaded avatars (`avatars/`), uploaded pictures (`images/` + `images.json`) and game stats — visits and thumbs up/down
(`gamestats.json`). Put `data/` on a persistent volume (a Railway Volume) or it resets on
every redeploy.

## Files

- `server.js` — the whole server: static file serving, the WebSocket realtime layer
  (presence, party, chat, voice signaling), and the `/api/worlds` REST endpoints.
- `public/` — the game client itself (same file the Electron app and claude.ai
  artifact use), plus `manifest.json` and app icons for PWA install.
- `public/battle-assets/` — 3D model assets used by Thunder Battle.
- `public/rbx/` — the home page (`home.js/css`), the in-game UI + camera (`hud.js/css`),
  NeoStudio's editor (`studio.js/css`), its script editor (`codeeditor.js/css`) and the
  scripting runtime (`neoscript.js` + `neoscript-runtime.js`) and the picture picker
  (`pictures.js/css`).
- `public/vendor/quickjs/` — the QuickJS engine (WebAssembly) that runs scripts.
- `accounts.js` — accounts, tokens, quests and the Avatar Shop catalog.
- `test/api.test.js` — server checks (`npm test`).

## Credits

- `public/vendor/quickjs/` is QuickJS (© Fabrice Bellard and Charlie Gordon) built for the
  web by quickjs-emscripten (© Jake Teton-Landis), both MIT-licensed — see its `LICENSE`.
- `public/battle-assets/thunderbot.glb` is "RobotExpressive" by Tomás Laulhé
  (assets by Quaternius), CC0-licensed (public domain), sourced via the three.js
  project's example assets (github.com/mrdoob/three.js). Used as Thunder Battle's
  player character model.
