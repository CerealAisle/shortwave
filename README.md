# Shortwave

A private, two-person Discord bot that bridges Discord message events to a
Lovense toy over Lovense's cloud API — no LAN between the bot and the toy.

**Flow:** `/connect` links a toy by QR code → `/tease` turns tease on → every
message from the *other* person in the main channel sends a short buzz →
`/tease off:True` turns it off.

**Setting this up? Follow [DEPLOY.md](DEPLOY.md)** — a linear,
copy-pasteable walkthrough from bare host to working bot. This README is the
reference behind it: architecture, configuration, extension points and
troubleshooting. [WORKFLOW.md](WORKFLOW.md) covers the day-to-day loop — edit,
test, push, deploy, roll back. [TESTING.md](TESTING.md) covers the test suite,
and [STAGING.md](STAGING.md) how to run a staging instance beside production.
[ROADMAP.md](ROADMAP.md) records where it's going and the decisions behind it.

---

## Requirements

| | |
|---|---|
| **Host** | Any always-on Linux box with systemd. Ubuntu Server 24.04 LTS (amd64) is the reference target; Debian 13 and Raspberry Pi OS (arm64 or armhf) also work. The provisioning script detects the architecture and adapts. |
| **Resources** | ~120 MB RAM in normal operation, 2 GB total recommended for a comfortable build. About 1 GB of disk. CPU is near-idle. |
| **Runtime** | Node.js 22 LTS |
| **Network** | Outbound HTTPS, plus one publicly reachable HTTPS path for the Lovense callback (a Cloudflare Tunnel; no port forwarding) |
| **Accounts** | A Discord application, and an approved Lovense developer account with **heartbeat enabled** |
| **Phone** | Lovense Remote (iOS 5.1.4+ / Android 5.1.1+) with the toy paired over Bluetooth |

Hosting notes for specific platforms:
[DEPLOY.md Part 4](DEPLOY.md#part-4--build-the-ubuntu-vm) for a Hyper-V VM,
[DEPLOY-PI.md](DEPLOY-PI.md) for a Raspberry Pi.

---

## Contents

0. [Workflow](WORKFLOW.md) — develop, test, deploy, roll back
0. [Testing](TESTING.md) — suite, environments, adding tests
0. [Staging](STAGING.md) — two instances on one host
0. [Roadmap](ROADMAP.md) — planned changes and decisions
1. [How it works](#how-it-works)
2. [Architecture](#architecture)
3. [Control and fail-safes](#control-and-fail-safes)
4. [Configuration reference](#configuration-reference)
5. [Commands](#commands)
6. [Adding a new command](#adding-a-new-command)
7. [Troubleshooting](#troubleshooting)
8. [Security notes](#security-notes)

---

## How it works

There are two directions of traffic, and they use different paths.

**Outbound (bot → toy)** goes through Lovense's servers:

```
your host                   Lovense cloud            Phone (anywhere)
  bot process  ──HTTPS──▶  api.lovense.com  ──push──▶  Lovense Remote ──BLE──▶ toy
               POST /api/lan/v2/command
               { token, uid, command: "Function", action: "Vibrate:10", timeSec: 2 }
```

This is the Lovense "Standard API, by server" variant. It needs only your
developer token and the user's `uid`, so the bot and the toy can be on
opposite sides of the country. The phone running Lovense Remote needs internet
— cellular data is fine — and the toy needs to be connected to that app over
Bluetooth.

**Inbound (toy status → bot)** is a webhook:

```
Lovense Remote  ──HTTPS POST──▶  your public callback URL  ──▶  host :4000
```

After a QR scan, and then on every heartbeat, the Lovense Remote app posts the
toy list, battery and platform to the callback URL you register in the Lovense
dashboard. That's how the bot knows a link succeeded, what toys are attached,
and whether the phone is still alive. A home host is behind NAT, so a
Cloudflare Tunnel provides that public URL — it dials out, so nothing on your
network is exposed and no port is forwarded.

---

## Architecture

```
src/
├── index.ts                    entrypoint: wiring + graceful shutdown
├── config.ts                   env parsing/validation (zod) — fails fast
├── logger.ts                   leveled console logging
├── text.ts                     every word the bot shows in Discord — edit here
│
├── lovense/
│   ├── types.ts                ToyAction union + API payload types
│   ├── actions.ts              action builders; percent→level conversion
│   ├── patterns.ts             loads and validates patterns/*.json
│   ├── toys.ts                 toy names, lookup and suggestions
│   └── client.ts               HTTP transport, uid/utoken derivation, errors
│
├── store/
│   └── store.ts                SQLite: toy links + append-only command log
│
├── session/
│   ├── rate-limiter.ts         min-interval + sliding per-minute cap
│   ├── presence.ts             liveness from command results + heartbeats
│   ├── prober.ts               Vibrate:0 probe loop with offline backoff
│   └── manager.ts              session state machine, dispatch choke point
│
├── http/
│   └── callback.ts             Fastify server for Lovense webhooks
│
└── discord/
    ├── types.ts                BotCommand interface
    ├── registry.ts             auto-loads ./commands/*.js
    ├── deploy-commands.ts      registers slash commands to the guild
    ├── channels.ts             main / command channel roles
    ├── client.ts               Discord client + interaction router
    ├── status-board.ts         pinned live-status post in the command channel
    ├── notify.ts               posts to the command channel
    ├── failure.ts              a failed send, as a reply
    ├── dm.ts                   the one DM: fix-it steps after a failed /test
    ├── toy-option.ts           the shared `toy` option and its autocomplete
    ├── events/message-create.ts  the trigger path
    └── commands/               one file per slash command
```

The extension points that matter:

- **`lovense/types.ts` → `ToyAction`** is a discriminated union covering
  Function, Pattern and Preset requests. Anything the Lovense API can do is
  expressible as one of these three.
- **`lovense/actions.ts`** holds the builders (`vibrate`, `pulse`, `pattern`,
  `ramp`, `preset`, `stop`). New behaviour is usually a new builder here, not a
  new code path.
- **`SessionManager.sendNow()`** is the only function that talks to the toy.
  The intensity ceiling, the audit log and error mapping all live behind it, so
  a new command can't accidentally bypass them.
- **`discord/commands/`** is scanned at boot. Drop in a file exporting
  `{ data, execute }`, re-run `npm run deploy-commands`, restart. No registry
  edits.

**Patterns** are JSON files in `patterns/`, one per pattern, named by
filename. Copy `patterns/_template.json`; the format is in
[patterns/README.md](patterns/README.md). `npm test` validates every file
there, and the bot reads the folder each time `/pattern` runs, so a new
pattern needs a deploy but no restart or `deploy-commands`.

`commands/buzz.ts` is deliberately written as the reference implementation of
"vibrate at X% for X seconds" — copy it when adding more.

Tests live next to the code they cover as `*.test.ts` and are picked up
automatically by `npm test`. See [TESTING.md](TESTING.md).

---

## Control and fail-safes

These are design decisions, not incidental behaviour, and they're worth knowing
before you change anything:

- **Consent is physical, not a command.** The toy being on and worn is the
  signal; there is no software gate for it.
- **The wearer sees three commands.** `/connect`, `/test` and `/stop` are
  visible to everyone. Every other command is a controller command, hidden
  from — and refused to — anyone without Administrator (see
  [Commands](#commands)).
- **Anything that stops is never gated.** Commands that increase stimulation
  may be restricted; commands that reduce or stop it never are. `/stop` has
  no owner or permission check and is visible to everyone, so whoever is
  wearing a toy can always end everything. `src/session/manager.test.ts`
  holds this in place.
- **`/stop` holds everything still afterwards.** For `STOP_LOCKOUT_MINUTES`
  (default 30), or the `duration` given, nothing that moves can start — no
  buzz, pattern or tease, from anyone. A later `/stop` replaces the timer, so
  either person can shorten it, and `/stop duration:0` lifts it. When that
  is OK is agreed between the two of you, not decided by the bot. It is enforced in `sendNow`, so no command can get
  round it, and saved to the database, so a restart can't end it early. 0%
  commands (`/test`, the probe) still go through.
- **The owner's own messages never trigger their toy** — that check is in
  `message-create.ts` and is not configurable.
- **`/stop` works for either person.** It halts every toy in the server and
  disarms every session. It's the safeword, so it deliberately isn't
  owner-restricted and never waits on a confirmation prompt.
- **Tease has no expiry; it has a reminder.** Tease is driven by the other
  person's messages, so tease nobody is paying attention to produces nothing
  by itself, and a timeout could only cut a quiet session short. Instead,
  every `TEASE_REMINDER_MINUTES` (default 30) a fresh, non-pinging message in
  the command channel gives the buzz count, strength and whether the toy is
  reachable. It is skipped if the toy was already paused for the whole
  interval.
- **Restarts fail closed.** Armed state is in memory only, never persisted. A
  crash, reboot or `systemctl restart` comes back disarmed.
- **Shutdown stops the toy.** `SIGTERM` sends a Stop to every armed toy before
  the process exits; systemd's `TimeoutStopSec=20` gives it room to finish.
- **Presence is tested, not inferred.** Every `PROBE_INTERVAL_SEC` (default
  5 min) each linked toy is sent `Vibrate:0` for ~1.1 s — nothing moves — and
  Lovense's answer is definitive for the exact path a real buzz takes: `200`
  reachable, `507` app offline, `501`/`503` link or token problem. Any real
  command's answer counts the same way and postpones the next probe. A probe
  is never sent while a command is still running on the toy, since it would
  cut it short. While a toy is unreachable the interval backs off to
  `PROBE_OFFLINE_INTERVAL_SEC` (15 min), and a heartbeat arriving brings the
  next probe forward. Heartbeats remain a secondary signal for when there is
  no recent result.
- **Losing the toy pauses the session, it doesn't end it.** If a probe or
  command fails, heartbeats stop for `HEARTBEAT_TIMEOUT_SEC` with no recent
  successful command, or the app reports no connected toy, the session
  moves to `suspended`: triggers stop firing, but the session survives and
  resumes by itself if the toy returns within `OFFLINE_GRACE_SEC`. Only when
  that window closes is it disarmed for real. This matters over a multi-hour
  session, where brief network blips are near-certain. Set
  `OFFLINE_GRACE_SEC=0` to disarm on the first blip instead.
- **A 507 from Lovense suspends the session at once.** "Lovense APP is
  offline" is the server stating it has no live connection to the app, which
  is better evidence than heartbeat silence and arrives minutes sooner. It
  outranks a recent heartbeat, because the app can keep sending heartbeats
  while its command channel is dead — the iOS-suspend case. A trigger's wake
  retries run first, so it is only reported once every attempt has failed.
  **Only a command that gets through clears it** — a heartbeat does not. A
  backgrounded iOS app keeps heartbeating while refusing commands, and
  letting each heartbeat clear the 507 made sessions flap between paused and
  resumed every minute. Instead, a heartbeat brings the next probe forward
  (at most once a minute), and that probe's success is what resumes.
- **Outages and errors are shown, not posted.** Pauses, recoveries and
  failed commands appear on the pinned status board: the code, what it
  means, and a "looks backgrounded" warning when the app is checking in but
  refusing commands. The bot posts only four things to the command channel
  on its own: a new connection, the tease reminder, tease turning itself off
  after a long outage, and someone running `/stop` elsewhere.
- **One kind of DM.** When `/test` finds a toy not responding for a reason
  its owner can fix, they get a DM with the steps for that failure —
  force-quit a backgrounded app, open a closed one, reconnect Bluetooth,
  re-pair a lost link. Nothing else sends a DM. `DM_ON_FAILED_TEST=false`
  turns it off.
- **`/tease` refuses an unreachable toy** rather than starting into the void.
- **Rate limiting is on by default.** `MIN_COMMAND_INTERVAL_MS` (1.5 s) and
  `MAX_COMMANDS_PER_MINUTE` (25) mean a message flood doesn't turn into a
  continuous vibration. Excess triggers are dropped, not queued.
- **`MAX_INTENSITY_PERCENT`** caps every command including manual ones.
- **The Lovense app always wins.** Pressing Stop in Lovense Remote severs the
  link out of band; nothing the bot does can override that.

---

## Setup

The full procedure — Discord application, Lovense dashboard, host, tunnel,
install, iPhone, first run — is [DEPLOY.md](DEPLOY.md). It's written to be
followed top to bottom once.

A few facts that belong with the code rather than the walkthrough:

**No privileged intents.** The bot reacts to the fact that a message was sent,
never to its contents, so Message Content stays off in the Discord portal. If
you later add keyword triggers you'll need to enable it there *and* add
`GatewayIntentBits.MessageContent` to the intents list in
`src/discord/client.ts`.

**Two channels, two jobs.** Messages in the main channel drive the triggers,
and the bot is close to silent there. Everything the bot says on its own —
disconnects, resumes, errors, connection notices — goes to the command
channel. Slash commands work in either and reply where they were run, so
`/stop` and `/status` are usable from the main channel. Commands from any
other channel are refused.

**The pinned status post.** One message in the command channel shows every
linked user, their toys, battery, whether each is reachable and when it was
last probed, and the session state. It is edited in place, at most once every
15 seconds and only when something changed. Its ID is stored in the
`settings` table, so a restart edits the same post; if it has been deleted, a
fresh one is posted and pinned. It needs `Read Message History` and
`Pin Messages` in that channel — without the latter it still posts, just
unpinned.

**Per-command permissions.** Discord's own **Server Settings → Integrations →
Shortwave** can restrict individual commands by channel or member, without
any code change.

**Heartbeat is required.** With it off, Lovense Remote calls your callback URL
exactly once, at pairing. The bot then can't distinguish "phone asleep" from
"phone fine but quiet", so it reports ⚪ Unknown and the offline detection in
`src/session/presence.ts` never engages.

**Layout on the host.** The provisioning script (`deploy/setup-host.sh`)
creates:

| Path | |
|---|---|
| `/opt/lovense-bot` | the project, owned by `lovensebot` |
| `/opt/lovense-bot/.env` | credentials, mode `600` |
| `/opt/lovense-bot/data/bot.db` | SQLite: toy links + command log, mode `700` dir |
| `/etc/systemd/system/lovense-bot.service` | the unit |
| `/etc/cloudflared/config.yml` | tunnel ingress |

Two systemd units ship in `deploy/`, differing only in their memory cap.
Install whichever fits, always *as* `lovense-bot.service`:

| File | Cap | For |
|---|---|---|
| `lovense-bot.service` | 1 GB | hosts with 2 GB or more |
| `lovense-bot.pi.service` | 400 MB | a 1 GB Raspberry Pi |
## Configuration reference

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token from the Discord portal |
| `DISCORD_CLIENT_ID` | — | Application ID |
| `DISCORD_GUILD_ID` | — | Your private server's ID |
| `MAIN_CHANNEL_ID` | — | Shared channel; only messages here trigger buzzes |
| `COMMAND_CHANNEL_ID` | — | Bot's home; all bot-initiated messages go here. Must differ from main |
| `LOVENSE_TOKEN` | — | Lovense developer token |
| `USER_TOKEN_SALT` | — | `openssl rand -hex 32`; derives per-user `utoken` |
| `CALLBACK_PORT` | `4000` | Local port for the webhook server |
| `CALLBACK_PATH` | `/lovense/callback` | Must match the Lovense dashboard |
| `CALLBACK_BIND` | `127.0.0.1` | Leave as-is when using a tunnel |
| `DATABASE_PATH` | `./data/bot.db` | SQLite file |
| `PATTERNS_DIR` | `./patterns` | One JSON file per `/pattern`; read on each use, no restart needed |
| `BUZZ_INTENSITY_PERCENT` | `50` | Default per-message strength |
| `BUZZ_DURATION_SEC` | `1.5` | Lovense requires > 1 s; shorter values are floored |
| `MAX_INTENSITY_PERCENT` | `100` | Hard ceiling on every command |
| `MIN_COMMAND_INTERVAL_MS` | `1500` | Minimum gap between commands |
| `MAX_COMMANDS_PER_MINUTE` | `25` | Sliding-window cap |
| `TEASE_REMINDER_MINUTES` | `30` | Reminder interval while tease is on; `0` disables. Tease never expires |
| `STOP_LOCKOUT_MINUTES` | `30` | After `/stop`, how long nothing that moves can start. `/stop duration:` overrides it per use; a later `/stop` replaces it, and `duration:0` lifts it |
| `HEARTBEAT_TIMEOUT_SEC` | `300` | Offline threshold; `0` disables liveness |
| `PRESENCE_POLL_SEC` | `15` | How often to sweep for stale links and due probes |
| `PROBE_INTERVAL_SEC` | `300` | `Vibrate:0` liveness probe per toy; `0` disables |
| `PROBE_OFFLINE_INTERVAL_SEC` | `900` | Probe interval while a toy is unreachable |
| `OFFLINE_GRACE_SEC` | `300` | Pause-before-disarm window; `0` disarms on first blip |
| `WAKE_RETRY_ATTEMPTS` | `2` | Retries for a 507 from a sleeping iOS app |
| `WAKE_RETRY_DELAY_MS` | `700` | Base retry delay (grows per attempt) |
| `DM_ON_FAILED_TEST` | `true` | When `/test` fails, DM the toy's owner the steps to fix it. The only DM the bot sends |
| `TRIGGER_ON_BOT_MESSAGES` | `false` | Whether other bots/webhooks count |
| `LOG_LEVEL` | `info` | `debug` to trace every trigger decision |

Note on scale: Lovense's strength range is 0–20 for Vibrate and Rotate (0–3 for
Pump). The bot speaks in percentages and converts in `percentToLevel()`, so the
granularity is really 5% steps.

---

## Commands

Every command replies in the channel it was run in.

All wording the bot shows in Discord lives in `src/text.ts`, grouped by
command, with a note on when each message appears. Edit it there; `npm test`
checks that descriptions still fit Discord's limits.

**Everyone** sees these three, and nothing else:

| Command | What it does |
|---|---|
| `/connect` | Ephemeral QR code to link your own toy |
| `/test [target]` | Sends a 0% command to each connected toy — nothing moves — and posts which are responding, with what any error means. If one isn't, DMs its owner how to fix it. Defaults to yourself |
| `/stop [duration]` | Safeword: halts every toy, turns tease off, and keeps everything stopped for `duration` minutes (default `STOP_LOCKOUT_MINUTES`, 30). A later `/stop` replaces the timer; `duration:0` lifts it. Never gated. Tells the command channel when run elsewhere |

**The controller** (anyone with Administrator, which includes the server
owner) also sees:

| Command | What it does |
|---|---|
| `/tease [user] [toy] [intensity] [duration] [off]` | Tease on: others' messages buzz the toy. No expiry. Re-run for a toy already teasing to change its strength or length. With `off:True`, turns tease off for that user (or just that toy) and sends a stop, even during a `/stop` lockout |
| `/buzz <intensity> <seconds> [target] [toy]` | One-off manual vibration |
| `/pattern <name> [target] [toy]` | Play a named pattern from `patterns/`. The name autocompletes |
| `/status` | Linked toys, battery, tease state, trigger counts |
| `/disconnect [target]` | Delete a link from the bot. The wearer disconnects from the Lovense app instead |

Controller commands are hidden with Discord's own default permission
setting, so Discord enforces it: the wearer does not see them in the command
picker and cannot run them. Two things keep that true:

- **The wearer must not have Administrator** through any of their roles.
- **Per-person changes go in Discord**, under Server Settings → Integrations
  → Shortwave, which can show a command to a specific member or role
  without a code change.

`/connect` replies ephemerally because the QR code is a control credential.

**More than one toy.** Every toy paired to a person's Lovense Remote app is
listed under them, and `toy` picks one by nickname or model — it
autocompletes from that person's toys. Leave it out and `/buzz` and
`/pattern` go to all of them, `/tease` covers every connected toy, and
`/tease off:True` turns all of them off. Tease strength, length and counts are per toy, so two
toys can tease at different strengths; pausing is per person, because one
phone carries all their toys. `/stop` has no toy option: it is the safeword
and always stops everything.
The pinned status post in the command channel is the ambient view; `/status`
is the on-demand one.

---

## Adding a new command

Say you want `/wave` — a preset pattern for N seconds.

**1.** If a new builder is needed, add it to `src/lovense/actions.ts`. (A preset
builder already exists, so this step is free here.)

**2.** Create `src/discord/commands/wave.ts`:

```ts
import { SlashCommandBuilder } from 'discord.js';
import * as actions from '../../lovense/actions';
import { LovenseError, makeUid } from '../../lovense/client';
import { sessions } from '../../session/manager';
import { store } from '../../store/store';
import type { BotCommand } from '../types';

export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('wave')
    .setDescription('Run the wave preset')
    .addNumberOption((o) =>
      o.setName('seconds').setDescription('Duration').setMinValue(1).setRequired(true),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;
    const link = store.getByUser(interaction.guildId, interaction.user.id);
    if (!link) {
      await interaction.reply('No toy linked. Run `/connect` first.');
      return;
    }

    const seconds = interaction.options.getNumber('seconds', true);
    await interaction.deferReply();

    try {
      await sessions.sendNow(
        makeUid(interaction.guildId, interaction.user.id),
        actions.preset('wave', seconds),
        `wave:${interaction.user.id}`,
      );
      await interaction.editReply(`Wave for ${seconds}s.`);
    } catch (err) {
      const msg = err instanceof LovenseError ? err.message : (err as Error).message;
      await interaction.editReply(`Failed: ${msg}`);
    }
  },
};
```

**3.** `npm run build && npm run deploy-commands && sudo systemctl restart lovense-bot`

The three rules: resolve the link from the store, build a `ToyAction` with a
builder, dispatch through `sessions.sendNow()`. Never call `lovense.send()`
directly from a command — that skips the cap and the audit log.

To change *what* triggers a buzz rather than adding a command, edit
`src/discord/events/message-create.ts`. Reactions, edits and voice events are
all similar handlers on the same client.

---

## Troubleshooting

**Lovense server error codes** (surfaced in command replies and the log):

| Code | Meaning | Usual cause |
|---|---|---|
| 200 | Success | — |
| 400 | Invalid command | Malformed action string |
| 404 | Invalid parameter | e.g. `timeSec` ≤ 1, or strength out of range |
| 501 | Invalid token | `LOVENSE_TOKEN` wrong or app not approved |
| 502 | No permission for this API | Developer app isn't a Standard Solution |
| 503 | Invalid user ID | uid not linked — re-run `/connect` |
| 507 | Lovense app offline | Phone asleep, app killed, or no internet |

**507 is the one you'll actually hit.** Lovense Remote must be running (at
minimum backgrounded), the phone needs data, and the toy needs an active
Bluetooth connection. Aggressive battery optimisation on Android is a common
culprit — exempt Lovense Remote from it.

**QR scanned but no confirmation message.** The callback isn't arriving. Check:

```bash
curl https://your-domain/healthz              # tunnel up?
sudo journalctl -u cloudflared -n 50          # tunnel healthy?
sudo journalctl -u lovense-bot -n 50          # any 403 "bad utoken"?
```

A 403 in the log means `USER_TOKEN_SALT` changed since that link was created —
run `/disconnect` and `/connect` again. Also confirm the dashboard callback URL
exactly matches `CALLBACK_PATH`.

**Slash commands not appearing.** Run `npm run deploy-commands` and check its
output. Confirm the bot was invited with the `applications.commands` scope — if
not, re-invite with the OAuth2 URL.

**Everything shows `⚪ Unknown` in `/status`.** Heartbeats aren't arriving. The
bot has had exactly one callback per link (the pairing one) and deliberately
won't guess at liveness from that. Enable heartbeat in the Lovense developer
dashboard. A successful probe or buzz also establishes presence, so this
should clear within `PROBE_INTERVAL_SEC` of linking unless probing is off.

**Tease keeps pausing or turning itself off.** The heartbeat interval is longer than
`HEARTBEAT_TIMEOUT_SEC`, so a healthy link looks stale between beats. Raise the
timeout to roughly three times the dashboard's heartbeat interval. Confirm the
real rate with:

```bash
LOG_LEVEL=debug journalctl -u lovense-bot -f | grep heartbeat
```

**Sessions pause and resume repeatedly on iOS.** Normal in small doses — iOS is
waking the app in bursts. If it's constant, the heartbeat gaps exceed
`HEARTBEAT_TIMEOUT_SEC`; raise it to about 3× the largest gap you see in
`journalctl -u lovense-bot -f | grep heartbeat`.

**First buzz after a quiet period is missed, later ones land.** That's a
suspended iOS app being woken by the first command. `WAKE_RETRY_ATTEMPTS`
already retries a 507 twice; raise it, or raise `WAKE_RETRY_DELAY_MS`, if the
app is slow to wake. Check the `source` column of `command_log` for `:retry`
entries to see how often this is happening.

**Session died and never came back.** Most likely the app was swiped closed in
the iOS app switcher, which stops background wakes entirely until it's
reopened. Nothing on the bot side can recover from that.

**"The Lovense Remote app is offline" (error 507), and reopening the app
doesn't fix it — only a force-quit does.** This is the single most common
failure in real use, and it is not a bug in the bot.

Lovense's cloud delivers commands by pushing them down a connection the app
holds open to Lovense's servers. When iOS suspends the app, that connection
dies. Resuming the app from the background restores the UI and the Bluetooth
link to the toy — so manual control *inside the app* works — but does not
reliably re-register the app with Lovense's servers. Only a cold launch does.
So the app looks healthy while Lovense's server still reports it offline, and
507 is that server telling the truth.

The bot treats a 507 as authoritative: it marks the link offline immediately
rather than waiting out `HEARTBEAT_TIMEOUT_SEC`, suspends the session, and
resumes automatically on the next callback. Heartbeats can continue while the
command channel is dead, which is why the 507 outranks a recent heartbeat.

Mitigations, in order of effectiveness: keep the app in the foreground with
the screen locked and the phone on a charger; use iOS **Guided Access**
(Settings → Accessibility → Guided Access) to pin it there for a session;
confirm Background App Refresh is on and Low Power Mode off. When it does
happen, force-quit and reopen — don't just reopen.

**This cannot be automated away on iOS**, and it is worth knowing why before
spending time on it:

- Shortcuts has no action that closes or force-quits another app. The sandbox
  gives no app the ability to terminate another, so no third-party tool
  provides it either.
- Even if a shortcut could be triggered remotely, its `Open App` action on a
  *suspended* app performs the resume that does not work. Only a cold launch
  re-registers the app, and "cold launch" is not something Shortcuts can force.
- Triggering a shortcut from a server without anyone touching the phone needs
  something like Pushcut's Automation Server, which requires a **dedicated**
  iOS device sitting unlocked with the app visible on screen. That is not a
  phone anyone is carrying.

So the recovery path is a human, and the bot's job is to reach them quickly.
Running `/test` does that: when it fails, the toy's owner gets a DM with the
fix for that failure, and a DM raises a push notification even when the
channel is muted. Set the DM
conversation to allow notifications, and on iOS add Discord to any Focus mode
that might be active.

**Buzzes feel sparse during fast conversation.** That's `MIN_COMMAND_INTERVAL_MS`
dropping triggers by design. Lower it if you want, but overlapping commands with
`stopPrevious: 1` (the default) cancel each other, so going much below ~1 s
produces stutter rather than more sensation.

**Every credential reports "Required" at startup.** The `.env` file isn't
being read — not a quoting problem. Usually it's owned by root at mode `600`
while the bot runs as `lovensebot`. `dotenv` swallows the read error, so this
looks like a malformed file. Check with `sudo -u lovensebot head -1
/opt/lovense-bot/.env`; fix with `sudo chown lovensebot:lovensebot
/opt/lovense-bot/.env`. Since v1.0.1 the bot names the real cause itself.

**`npm` fails with `ERR_INVALID_ARG_TYPE` — "path argument must be of type
string… Received null".** You're running npm from a directory the
`lovensebot` user can't read. `sudo` preserves the working directory, so
`sudo -u lovensebot npm install` launched from `~` or `/root` leaves npm
unable to find the project root. `cd /opt/lovense-bot` first.

**`npm ci` fails with `EUSAGE` — "can only install with an existing
package-lock.json".** No lockfile yet. The project ships without one; run
`npm install` once to generate it, then commit the resulting
`package-lock.json` so later installs are reproducible.

**`npm install` gets killed.** Out of memory — only likely on a host with
under 2 GB. See [DEPLOY-PI.md](DEPLOY-PI.md); the provisioning script raises
swap on low-memory hosts, so check `free -h` and re-run it if swap looks
small.

**Permission denied entering `/opt/lovense-bot`.** Deliberate: mode `750`,
owned by `lovensebot`. Work as root (`sudo -i`) and prefix file-writing
commands with `sudo -u lovensebot`, or add yourself to the group with
`sudo usermod -aG lovensebot $USER` for read access.

**Service won't start after a Node upgrade or reinstall.** The unit runs
`/usr/local/bin/node` specifically. Check `ls -l /usr/local/bin/node`;
`deploy/setup-host.sh` recreates that symlink whichever install route it took.

**Useful commands:**

```bash
sudo systemctl status lovense-bot
journalctl -u lovense-bot -f
journalctl -u lovense-bot -p warning --since "1 hour ago"
sqlite3 /opt/lovense-bot/data/bot.db \
  'SELECT datetime(created_at/1000,"unixepoch"), description, source, ok, error
     FROM command_log ORDER BY id DESC LIMIT 20;'
```

Set `LOG_LEVEL=debug` to see every trigger decision, including throttled ones.

---

## Security notes

- `.env` holds two credentials that grant real control. `chmod 600`, owned by
  `lovensebot`, and never committed.
- The Lovense developer token controls every toy linked to your developer app.
  If it leaks, rotate it in the dashboard immediately.
- The callback endpoint verifies the `utoken` Lovense echoes back (HMAC of the
  uid under your salt, compared in constant time) before trusting any payload.
- The tunnel ingress allow-lists two paths. Don't widen it to `service:` on a
  catch-all hostname.
- The systemd unit runs unprivileged with `ProtectSystem=strict` and a single
  writable path. The bot never needs root.
