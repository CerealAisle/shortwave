# Shortwave on a Raspberry Pi

This replaces **Part 4** (build the host) and **Part 5** (provision it) of
[DEPLOY.md](DEPLOY.md). Parts 1–3 and 6–10 are unchanged — come back to
DEPLOY.md at Part 6 when you finish here.

A Pi 3 B is enough for this. The bot idles around 80–120 MB and spends almost
all its time waiting. What a Pi costs you is build time and, on a 32-bit OS,
a Node version ceiling.

**An amd64 VM is the easier host** if you have an always-on machine — faster
builds, prebuilt native modules, no architecture dead ends. Use the Pi when
it's what you have, or when you'd rather not run a VM.

---

## P1 — Choose the OS

**Raspberry Pi OS Lite (64-bit).** Lite, not Desktop: on 1 GB of RAM the
desktop is a real cost for a headless service. 64-bit, not 32-bit: NodeSource
publishes no 32-bit ARM packages, and Node 22 is the last release line with
official 32-bit ARM builds at all.

Flash with Raspberry Pi Imager and use its gear icon to preconfigure hostname
(`shortwave`), your admin user, SSH, and Wi-Fi before first boot.

**Already running a 32-bit OS?** That's supported — see [P4](#p4--the-32-bit-armhf-path).

---

## P2 — First boot

```bash
ssh <YOUR_USER>@shortwave.local
```

If `.local` doesn't resolve, find the Pi in your router's client list.

Check the architecture before going further:

```bash
dpkg --print-architecture     # want: arm64
```

Use `dpkg --print-architecture`, not `uname -m`. Recent 32-bit Pi OS images
ship a **64-bit kernel with a 32-bit userland**, so `uname -m` reports
`aarch64` while every binary you can actually run is `armhf`.

---

## P3 — Provision

Copy the project across from your workstation:

```bash
scp shortwave.tar.gz <YOUR_USER>@shortwave.local:/tmp/
```

On the Pi:

```bash
tar xzf /tmp/shortwave.tar.gz -C /tmp
sudo mkdir -p /opt/lovense-bot
sudo cp -r /tmp/shortwave/. /opt/lovense-bot/
sudo chmod +x /opt/lovense-bot/deploy/setup-host.sh

sudo apt update && sudo apt full-upgrade -y
less /opt/lovense-bot/deploy/setup-host.sh     # read it before running as root
sudo /opt/lovense-bot/deploy/setup-host.sh
```

**10–20 minutes on a Pi 3 B.** Alongside what it does everywhere else, on a
low-memory Pi it raises swap from the stock 100 MB to 1 GB. Without that,
`npm ci` gets OOM-killed.

Confirm:

```bash
dpkg --print-architecture   # arm64 (or armhf)
node -v                     # v22.x
ls -l /usr/local/bin/node   # the stable symlink the service uses
free -h                     # Swap ~1.0Gi
id lovensebot
```

### Use the low-memory service unit

In Part 7 of DEPLOY.md, install `lovense-bot.pi.service` rather than
`lovense-bot.service`. They are identical apart from the memory cap — 400 MB
instead of 1 GB — which keeps the bot from starving anything else on a 1 GB
board:

```bash
sudo cp deploy/lovense-bot.pi.service /etc/systemd/system/lovense-bot.service
```

Note the rename: whichever variant you pick gets installed *as*
`lovense-bot.service`, so every other command in DEPLOY.md still applies.

### Everything else that differs

- **cloudflared** (Part 6): use the arm64 package.

  ```bash
  curl -fsSLo cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
  ```

- **First install** (Part 7): use `npm install`, not `npm ci`. The project
  ships without a `package-lock.json`; that first install creates one. Use
  `npm ci` from then on.

- **Build times** (Part 7): `npm install` takes 5–10 minutes, `npm run build`
  another one or two. That's normal, not a hang. On 32-bit ARM add another
  10–20 for `better-sqlite3` to compile.

---

## P4 — The 32-bit (armhf) path

Supported, with two caveats worth knowing before you commit:

1. **You're pinned to Node 22.** It's supported until April 2027, but Node 24
   dropped 32-bit ARM entirely, so there's no upgrade path on this OS.
2. **`better-sqlite3` compiles from source** — no 32-bit ARM prebuild exists.
   Expect 10–20 minutes, and be glad the script raised swap first.

The provisioning script detects `armhf` and installs Node from the official
nodejs.org ARMv7 tarball instead of NodeSource. Nothing else changes; use
`lovense-bot.pi.service` as above.

---

## Sharing the Pi with RetroPie

Fine, and the bot is built not to get in the way:

- it runs as `lovensebot`, a system user with no login shell
- `lovense-bot.pi.service` caps it at 400 MB, so it can't starve a game
- it doesn't touch RetroPie's autologin or EmulationStation
- the only thing it writes is `/opt/lovense-bot/data`

The one thing to plan around: `npm ci` will use most of the Pi's RAM for
10–20 minutes. Don't run the install while someone's playing.

Both services will contend for the same SD card. If you see stalls under load,
that's usually the card rather than either program — an A2-rated card helps,
and so does keeping the bot's `LOG_LEVEL` at `info` rather than `debug`.

---

## Building elsewhere

`tsc` on a Pi 3 B works but is slow. You can build on your workstation and
copy the result, but **native modules can't be cross-copied** — always run
the install on the Pi itself:

```bash
# on your workstation
rsync -av --exclude node_modules --exclude dist --exclude .env \
  ./ <YOUR_USER>@shortwave.local:/tmp/shortwave/
# then on the Pi (npm install the first time, npm ci once a lockfile exists)
cd /opt/lovense-bot && sudo -u lovensebot npm ci
```

---

## Pi-specific troubleshooting

**`npm install` killed.** Out of memory. Check `free -h`; if swap shows
100 MB, re-run `sudo /opt/lovense-bot/deploy/setup-host.sh`.

**`npm ci` fails with EUSAGE / "can only install with an existing
package-lock.json".** There's no lockfile yet. Run `npm install` once; it
creates one.

**`npm` fails with ERR_INVALID_ARG_TYPE / "Received null".** You're running
npm from a directory `lovensebot` can't read. `sudo` keeps the working
directory, so launching from `~` or `/root` leaves npm unable to find the
project. `cd /opt/lovense-bot` first.

**`setup-host.sh` fails with "Unsupported architecture: armhf" from
NodeSource.** You're running an older copy of the script that predates the
architecture detection. Take the current one from the repo.

**Node install succeeded but the service won't start.** Check
`ls -l /usr/local/bin/node`. The unit runs that path specifically, and the
script creates it whichever install route ran.
