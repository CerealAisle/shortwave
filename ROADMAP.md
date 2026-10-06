# Roadmap

Where Shortwave is going, and the decisions behind it. Written down because
these were settled in conversation and would otherwise be lost.

The source requirements are in `bot-requirements.txt`. Where this file and
that one disagree, this one is newer.

---

## Decisions

**Consent is physical, not a command.** The toy being powered on and worn is
the signal. The bot has no software gate for it, so there is no `/on`
container — the command is removed rather than repurposed.

**Anything that stops is never gated.** `/stop` is usable by the
person wearing the toy, unconditionally, whoever started something and whoever
is controlling it. The rule: *commands that increase stimulation may be
restricted; commands that reduce or stop it never are.*

**Tease has no expiry; it has a reminder.** The trigger for tease is
CerealAisle's own messaging, so a session left on while attention moves
elsewhere produces nothing. Rather than a timeout that can only cut short a
session that was going fine, the bot posts periodically to the command channel
while tease is active — `TEASE_REMINDER_MINUTES`, default 30.

**The wearer sees three commands: `/connect`, `/test`, `/stop`.** In
practice one person controls and the other wears, so everything else is a
controller command, hidden with Discord's default member permissions.
`/stop` also holds everything still afterwards (`STOP_LOCKOUT_MINUTES`,
default 30). A later `/stop` replaces the timer, so either person can shorten
it — always by agreement, which is theirs to keep, not the bot's. `/off` is
gone: `/tease off:True` turns tease off. Supersedes the command surface table
at the end of this file.

**Outages are shown, not posted.** A backgrounded iOS app produced a
paused/resumed pair every minute. Only a command that gets through now ends
an outage — heartbeats no longer do — and outages, pauses and errors are
shown on the pinned board instead of posted: the code, what it means, and a
"backgrounded" diagnosis. The bot still posts four things itself: a new
connection, the tease reminder, tease turning off after a long outage, and
`/stop` run elsewhere. All of the wording lives in `src/text.ts`.

**She is always the target; `/focus` picks the toys.** `/connect` links her
Lovense Remote app, so every toy connected to it is usable. Commands act on
her (`TARGET_USER_ID`) with no user option, except `/disconnect`. `/focus`
sets which toys they reach — all connected toys, or one — and tease reads it
at each message, so on "all" a toy connected mid-session joins in. This
replaces phase 6's per-command `toy` option and per-toy tease strengths.

**`/stop` stays.** It was missing from the requirements draft. Halts every toy,
clears every mode, usable by anyone, no confirmation prompt. It is the
safeword.

**The two channels have distinct jobs.**

| | Who sees it | What it is for |
|---|---|---|
| **Command channel** (`somno` / `test-bot-commands`) | CerealAisle only | The bot's home. Nearly all bot messaging, the pinned status post, and commands issued discreetly. |
| **Main channel** (`sugar-and-spice` / `test-channel`) | Both | Conversation. Message activity here is what drives tease. The bot is close to silent in it. |

Two rules follow, and they cover every case:

- **Bot-initiated messages go to the command channel.** New connections,
  tease reminders, tease turning off, `/stop` notices, and the pinned board.
  She never sees them in the shared channel.
- **Command replies go wherever the command was issued.** So `/status` run in
  the main channel answers in the main channel. This is what makes `/stop` and
  `/disconnect` usable by her — she only has the main channel, and she must
  always be able to stop things and see that it worked.

Commands are therefore accepted in **both** channels. Only unsolicited
messages are confined to the command channel.

**No DMs.** When `/test` finds a toy not responding for a reason she can
fix, the steps are posted in the shared channel with an @mention.

**Multi-toy work is deferred** until there is a second toy to test with.
Shipping toy addressing never exercised against two real toys would be
guessing.

---

## The invariant that needs guarding

Wearer-can-always-stop holds in the current build, but only as a side effect
of nobody being able to control anyone else's toy:

| | Today | Why it holds |
|---|---|---|
| `/off` | `disarm(guildId, interaction.user.id)` | Always the caller's own state |
| `/stop` | `stopAll(guildId)` | No permission check of any kind |

The moment someone else can start something on your toy, this stops being
automatic. Lock it with a `SessionManager` test before that lands — stubbing
`lovense.send` with `node:test`'s `mock.method` against the exported singleton
is enough, and it also closes the session-manager gap [TESTING.md](TESTING.md)
admits to.

---

## Phases

Ordered so the first three deliver the thing actually being asked for: knowing
at a glance whether a toy is responding. Each is independently deployable and
testable with one toy.

### 1. Two channels with distinct roles

Replace `TRIGGER_CHANNEL_ID` with `MAIN_CHANNEL_ID` and `COMMAND_CHANNEL_ID`.

- Message triggers fire only from the main channel
- All six `notify()` call sites in `index.ts` target the command channel
- Command replies go to the invoking channel — which is already the default
  behaviour of a Discord interaction reply, so this is mostly about *not*
  hard-coding a channel
- Reject commands from channels that are neither

Touches: `config.ts`, `message-create.ts`, `index.ts`, `client.ts`.

Independent of everything else, and a good first change on the new servers —
it exercises the deploy loop without touching session logic.

### 2. Active probe, and presence driven by it

Presence today is *inferred* from heartbeats, which is passive, up to five
minutes stale, and has already lied — the app heartbeating while its command
channel was dead.

Replace inference with a test. Every few minutes, for each linked toy, send
`Vibrate:0` for ~1.1 seconds. Nothing moves. Lovense's response is definitive
about the exact path a real command takes:

| Response | Meaning |
|---|---|
| `200` | Reachable right now |
| `507` | App offline |
| `503` / `501` | Link or token problem |

This is the requirements' keepalive idea, doing a job it definitely does.
Whether it also keeps the toy's Bluetooth from idling is a bonus to measure,
not the justification.

Details worth getting right:

- Back the interval off when a toy is offline (say 5 min → 15 min) so a dead
  link doesn't fill the log
- The 507 fast-path in `presence.ts` stays; the probe just means it fires
  within minutes rather than at the heartbeat timeout
- Keep `HEARTBEAT_TIMEOUT_SEC` as a secondary signal — a callback arriving is
  still evidence

Touches: `presence.ts`, `config.ts`, a new probe loop in `index.ts`.

### 3. Pinned status post

One message in the command channel, edited in place, showing every user and
their toys. Glanceable, no command needed.

Sketch:

```
Shortwave — live status                      updated 2 minutes ago

Daddy  ·  CerealAisle
  🟢 Lush 3      87%   reachable, probed 2m ago
     tease off

Sweetheart  ·  QuietYogurtcloset975
  🔴 Hush 2      41%   unreachable since 18m ago
     tease on · 12 buzzes · 2h 14m
```

Implementation notes that are easy to miss:

- **Persist the message ID**, so a restart edits the existing post rather than
  posting a second one. A one-row `settings` table, or a column on a new
  `channels` table.
- On boot, fetch that message; if it's gone (deleted, purged), post a fresh
  one, re-pin, and store the new ID.
- **Debounce the edits.** A flapping toy could otherwise produce an edit every
  few seconds. One edit per ~15s, coalescing changes, is plenty.
- Update on: probe result change, presence transition, tease toggle, connect,
  disconnect.

Touches: new `src/discord/status-board.ts`, `store.ts` (message ID),
`index.ts`.

Depends on 1 (needs the command channel) and 2 (needs trustworthy data).

### 4. Remove `/on`; `/tease` becomes the toggle

`/on` currently means "arm for message triggers". With the container gone,
that is just what `/tease` is. `/off` turns it off.

- Do the invariant test above **first**, as the opening commit of this phase
- **No auto-expiry.** An earlier draft kept one as a guard against
  forgetting. It isn't needed: the trigger for tease is *your own messaging*,
  so attention moving elsewhere stops the buzzes by itself. An expiry would
  only fire in the case where nothing was happening anyway, and would cut a
  long quiet session short for no reason.
- **A periodic reminder instead.** While tease is active, the bot posts to the
  command channel on an interval — `TEASE_REMINDER_MINUTES`, default `30`,
  `0` disables. Visibility without a deadline: the thing worth solving was
  *losing track*, not runaway stimulation.
- `Session` becomes tease state; the suspend/resume machinery carries over
  unchanged
- `SESSION_TIMEOUT_MINUTES` loses its meaning here — nothing else reads it
  once tease is the only persistent mode. Remove it in this phase rather than
  leaving a config key that does nothing.

The reminder is worth a little care, because a bare "tease is still on" ping
every half hour becomes noise you learn to ignore:

- Post to the **command channel**, per the phase 1 rule for bot-initiated
  messages. She never sees it.
- Carry state, so it's worth reading: buzzes since tease started, the current
  intensity and duration, and whether the toy is reachable right now.
- Count the interval from the last *reminder*, not from arm time, so a
  restart can't produce a burst.
- Skip the post entirely if the toy has been unreachable for the whole
  interval and a disconnect notice already went out — one message about a
  dead link is enough.
- Edit-or-post is a judgement call: a fresh message each time is a visible
  heartbeat, editing one keeps the channel clean. Post fresh, since the
  pinned status board from phase 3 is already the quiet ambient view.

Touches: `manager.ts`, delete `on.ts`, new `tease.ts`, `message-create.ts`,
`status.ts`, `config.ts` (add `TEASE_REMINDER_MINUTES`, drop
`SESSION_TIMEOUT_MINUTES`), `.env.example` and the README config table, new
`manager.test.ts`.

### 5. Pattern library

Named patterns from files, referenced by name in `/pattern`. Mostly additive;
targets all of a user's toys until phase 6.

Touches: new `src/lovense/patterns.ts` and a `patterns/` directory, new
`pattern.ts` command.

### 6. Multiple toys — *built; not yet tested with two real toys*

Toys become addressable by name; sessions key on `(guild, owner, toyId)`
instead of `(guild, owner)`. Every command gains an optional toy argument
defaulting to all.

The Lovense transport already supports this — `client.send(uid, action,
toyId?)` passes `toy` in the payload today — so this is a bot-side data model
change only.

Do it as one deliberate change on a branch. Half the commands taking a toy
argument and half not is worse than either end state.

Touches: `store.ts` (schema migration), `manager.ts`, every command.

**As built**, with two departures from the plan above:

- **No schema migration.** A link is one Lovense Remote app, and every toy
  paired to it already arrives in each callback and is stored with the link.
  That is all toy addressing needs; a separate toys table would duplicate it.
- **Two levels instead of re-keying the session.** The session stays per
  `(guild, owner)` and holds a `ToyTease` per toy. Pause, the grace window,
  the rate limit and the reminder are properties of the phone, which carries
  every toy at once, so they stay per person. Strength, length, who started it
  and the counts are per toy — effectively keyed on `(guild, owner, toyId)`.

`toy` is optional on `/tease`, `/buzz`, `/pattern` and `/off`, and
autocompletes from the target's toys. `/stop` deliberately has none. When all
of a person's toys tease at the same settings, a trigger is still one
untargeted command — exactly what a one-toy setup sent before — and only
diverging settings produce one command per toy.

**Check with two real toys before relying on it** (with `/focus`, which
replaced the per-command `toy` option):

1. Both toys appear on the status board and in the `/focus` suggestions.
2. `/focus <one>`, then `/buzz`: only that toy moves.
3. `/focus All connected toys`, `/tease`, and post: both toys buzz from one
   message, and neither cuts the other short.
4. With tease on and focus on all, connect the second toy only now: the next
   message buzzes it too.
5. Switch one toy off: the board marks it ⚫ disconnected while the other
   stays 🟢.
6. `/stop` halts both.

---

## Command surface after phase 4

| Command | Where it replies | Notes |
|---|---|---|
| `/connect` | invoking channel, ephemeral | QR is a credential |
| `/disconnect` | invoking channel | |
| `/status [user]` | **invoking channel** | The pinned post is the ambient view; this is the on-demand one |
| `/tease [user] [intensity] [duration]` | invoking channel | Persistent mode. No expiry; reminds in the command channel every `TEASE_REMINDER_MINUTES` |
| `/buzz [user] <intensity> <duration>` | invoking channel | One-shot, self-limiting |
| `/pattern [user] <name>` | invoking channel | One-shot |
| `/off` | invoking channel | Never gated |
| `/stop` | invoking channel | Never gated. Safeword. |

Pick one argument order and keep it — the requirements draft has `Buzz
<intensity> <duration>` and `Tease <duration> <intensity>` in opposite orders.
Discord options are named rather than positional so it won't bite in the
client, but the docs should agree with themselves.
