# Testing

## Running the suite

```bash
npm test          # build, then run every *.test.ts
npm run test:watch
npm run check     # typecheck + test — what CI runs
```

No test dependencies. Node 22 ships a test runner (`node:test`) and an
assertion library (`node:assert`), which for a project this size beats adding
Jest or Vitest and their transitive tree.

Tests run against the placeholder credentials in `.env.test`, loaded with
`node --env-file`. Nothing in the suite touches a real toy, a real Discord
server, or a real Lovense account. That's deliberate: **a test suite you're
afraid to run is one you stop running.**

---

## Environments

Three, which is the usual shape:

| | What it is | Credentials |
|---|---|---|
| **Test** | `npm test` on your laptop or in CI. Pure logic, no network. | `.env.test`, all fake |
| **Staging** | A private Discord server with two accounts you control, and a toy you don't mind interrupting. | Its own `.env` |
| **Production** | The real server. | Its own `.env` |

You already built the staging environment by instinct — the test server with
two accounts and a spare toy is exactly it, and finding the iOS disconnect
bug there rather than mid-session is what it's for.

**Keeping staging and production apart.** The clean version is two Discord
applications (so two bot tokens), two `.env` files, and two systemd units on
different `CALLBACK_PORT`s. That's how a team would do it, because staging
must never be one typo away from production.

For two people and one bot, that's probably over-engineering. The pragmatic
middle is one bot with two config files:

```bash
/opt/lovense-bot/.env          # production
/opt/lovense-bot/.env.staging  # test guild, test channel
```

and a second unit that points at the other file, so switching is deliberate
rather than an edit to a live config. What matters is that changing
environments is an explicit act, not something you can do by accident.

One thing that genuinely cannot be duplicated: the **Lovense callback URL** is
a single global setting on your developer account. Both environments hit the
same tunnel, so the bot distinguishes them by `uid`
(`{GUILD_ID}:{USER_ID}`) rather than by endpoint. Worth remembering before
assuming staging is fully isolated — it isn't, at the Lovense layer.

---

## What the suite covers

The testing pyramid in its usual form: many fast unit tests, fewer
integration tests, very few end-to-end. This project is nearly all base.

### Unit — pure logic, no I/O

- **`lovense/actions.test.ts`** — the safety-critical one. Percent-to-level
  conversion, the intensity ceiling, and the rule that no command may ever
  carry `timeSec: 0`, which Lovense reads as *run indefinitely*. If one test
  file here earns its keep, it's this.
- **`session/rate-limiter.test.ts`** — interval floor, sliding per-minute
  quota, and that excess is *dropped* rather than queued.
- **`session/presence.test.ts`** — the online/offline/unknown state machine,
  including that a 507 outranks a heartbeat that arrived seconds ago, and that
  a link can't get stuck offline forever.

### Not covered, and why

- **Anything that talks to Lovense or Discord.** Testing these means mocking
  `fetch` and the discord.js client. Worth doing if the project grows; the
  seam already exists at `LovenseClient.send()`.
- **The session manager's timers.** Testable with `node:test`'s mock timers,
  but the state machine has been verified by simulation rather than committed
  tests. That's a gap, honestly labelled.
- **The Fastify callback handler.** Fastify's `app.inject()` makes this
  straightforward — send a fake Lovense payload, assert the store updated and
  a bad `utoken` is rejected with 403. A good next addition.
- **End-to-end with a real toy.** Not automatable, and not worth trying.
  This is what the staging server is for, run by hand.

---

## Adding a test

Put it next to the code as `<name>.test.ts`. It gets compiled into `dist/`
and picked up automatically.

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { thing } from './thing';

describe('thing', () => {
  it('does what it says', () => {
    assert.equal(thing(1), 2);
  });
});
```

Two habits worth keeping:

**Inject the clock.** `RateLimiter.tryAcquire(now = Date.now())` takes the
time as a parameter, which is why its tests run instantly instead of sleeping
for a minute. Anything time-dependent is far easier to test if the time comes
in from outside.

**Assert the property, not the example.** `percentToLevel(50) === 10` is a
fine test. Looping over the whole input range and asserting the result is
never outside `0..20` is a better one, because it catches the case you didn't
think of.

---

## Why bother, for a two-person bot

Most of this project is a thin shell around two APIs — the kind of code where
tests earn little. Three things here are different:

1. **The intensity and duration guards.** A bug that sends `Vibrate:20` when
   someone asked for 20%, or emits `timeSec: 0`, has a physical consequence.
   That's not a class of bug to find in production.
2. **The state machines.** Presence and session state have enough edges
   (unknown vs offline, pause vs disarm, 507 vs heartbeat) that reasoning
   about them in your head stops being reliable.
3. **Refactoring confidence.** The suite is what lets you change the trigger
   logic six months from now without re-testing every path by hand with a toy.

A worked example of point 2: the first version of the sliding-window test in
this repo asserted the wrong thing. The original requests were 1 ms apart, so
they all aged out of the window together, and the assumption that "exactly one
slot frees up" was simply false. The test failed, which is how the wrong
assumption got found. That's the whole value proposition in one incident.
