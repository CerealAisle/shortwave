/**
 * Every piece of text the bot shows in Discord, in one place.
 *
 * Edit wording here and nowhere else. Plain strings are fixed text; the
 * functions fill in names, numbers and times. Keep the placeholders they use
 * (`${...}`) — they are what the code passes in.
 *
 * Discord formatting that appears below:
 *   **bold**   *italic*   `code`   -# small grey text (a whole line)
 *   rel(…)   renders as a live relative time, e.g. "in 3 minutes", "2 minutes ago"
 *   userMention(id) / channelMention(id)   render as @name / #channel
 *
 * Slash command and option descriptions (the `describe` entries) are shown in
 * Discord's command picker. Discord caps them at 100 characters, and they only
 * update after `npm run deploy-commands`. `npm test` checks the limit.
 *
 * "The target" below is the person commands act on — her, set by
 * TARGET_USER_ID. Names passed in are display names.
 */
import { channelMention, time, userMention } from 'discord.js';

/** A Discord live relative time: "2 minutes ago", "in 30 minutes". */
const rel = (ms: number) => time(Math.floor(ms / 1000), 'R');
/** First letter upper-cased, for a phrase that starts a sentence. */
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** " (507)", or nothing when there is no code. */
const codeSuffix = (code: number | undefined) => (code !== undefined ? ` (${code})` : '');

export const text = {
  // ===========================================================================
  // Shared by several commands
  // ===========================================================================
  common: {
    /** A command used outside the bot's server. */
    wrongServer: 'This bot only works in its own server.',
    /** A command used in a channel that is neither main nor command. */
    wrongChannel: 'Commands only work in the main channel or the bot channel.',
    /** A command crashed. */
    somethingWentWrong: 'Something went wrong running that command.',

    /** The target has never run /connect. */
    noToy: (self: boolean, name: string) =>
      self
        ? 'You have no toy linked yet. Run `/connect` first.'
        : `${name} has no toy linked yet. She needs to run \`/connect\`.`,
    /** /connect was run but the QR code was never scanned. */
    notScanned: (self: boolean, name: string) =>
      self
        ? "Your QR code hasn't been scanned yet. Scan the code from `/connect` first."
        : `${name}'s QR code hasn't been scanned yet.`,

    /** A command that would move a toy, refused during a /stop lockout. */
    stopped: (by: string, until: number) =>
      `Stopped by ${userMention(by)} — nothing can start ${rel(until)}.`,

    /** A command sent something and Lovense refused it. */
    commandFailed: (meaning: string, code: number | undefined) =>
      `That didn't go through — ${meaning}${codeSuffix(code)}.`,
  },

  // ===========================================================================
  // Working out who commands act on (TARGET_USER_ID)
  // ===========================================================================
  target: {
    /** Nobody has linked yet, so there is nobody to act on. */
    noneLinked: 'Nobody has linked a toy yet. Run `/connect` first.',
    /** TARGET_USER_ID is unset and more than one person is linked. */
    ambiguous:
      "More than one person is linked, so I can't tell who to act on. Set `TARGET_USER_ID` in `.env`.",
  },

  // ===========================================================================
  // Focus: which of her toys tease, buzz and pattern reach
  // ===========================================================================
  focus: {
    describe: 'Choose which toys tease, buzz and pattern reach',
    describeToy: 'All connected toys, or one toy',
    /** The first suggestion in the list. */
    allChoice: 'All connected toys',
    /** How the "all" focus is named in other messages. */
    allLabel: 'all connected toys',

    setAll: (name: string) =>
      `**Focus: all connected toys.** Tease, buzz and pattern now reach every toy connected to ${name}'s Lovense Remote.`,
    setToy: (toy: string) =>
      `**Focus: ${toy}.** Tease, buzz and pattern now reach ${toy} only. Choose "All connected toys" in \`/focus\` to go back.`,
    /** Added to setToy when that toy isn't connected right now. */
    setToyDisconnected: (toy: string) =>
      `\n⚠️ ${toy} isn't connected right now, so nothing will reach it until it is.`,
    /** The toy typed couldn't be matched. */
    badToy: (error: string) => `Can't focus on that: ${error}.`,

    // Reasons a command (or a tease buzz) can't reach the focus right now.
    // They follow "Can't buzz: …" and similar.
    noneConnected: 'none of her toys are connected right now',
    focusedGone: (toy: string) =>
      `the focused toy, ${toy}, isn't reported by Lovense Remote any more. Use \`/focus\` to pick another`,
    focusedDisconnected: (toy: string) => `the focused toy, ${toy}, isn't connected right now`,
  },

  // ===========================================================================
  // Matching a typed toy name (used by /focus)
  // ===========================================================================
  toy: {
    /** The app has not reported any toys. */
    noneReported:
      "Lovense Remote hasn't reported any toys yet. Connect a toy in the app and wait a few seconds",
    /** Two toys share the name typed. */
    ambiguous: (typed: string) =>
      `more than one toy is called "${typed}". Pick it from the suggestions instead`,
    /** No toy matches the name typed. */
    notFound: (typed: string, available: string) => `no toy called "${typed}". Toys: ${available}`,
    /** In the suggestions list, after the battery. */
    disconnectedSuffix: ' · disconnected',
  },

  // ===========================================================================
  // What Lovense's answers mean. Used by /test, the status board and errors.
  // ===========================================================================
  codes: {
    200: 'reachable',
    400: 'Lovense rejected the command as invalid (a bot bug)',
    404: 'Lovense rejected a parameter (a bot bug)',
    501: 'the developer token is invalid — check LOVENSE_TOKEN',
    502: "the developer token isn't allowed to use the server API",
    503: "Lovense doesn't know this link — run /connect again",
    507: "Lovense Remote isn't reachable",
    /** No answer at all. */
    network: "couldn't reach the Lovense servers (network)",
    /** A code not listed above. */
    unknown: 'Lovense returned an unexpected code',
  },

  /** What to do about an outage, shown on the board and in /test. */
  hints: {
    /** 507 while the app keeps checking in. The iOS background case. */
    backgrounded:
      'looks backgrounded — the app is still checking in, but commands are refused. Force-quit Lovense Remote and reopen it',
    /** 507 with no recent check-in. */
    appClosed: 'the app is closed or the phone is offline. Open Lovense Remote',
  },

  // ===========================================================================
  // /connect — everyone
  // ===========================================================================
  connect: {
    describe: 'Link your Lovense Remote app by scanning a QR code',

    /** The private reply with the QR code. */
    embedTitle: 'Connect Lovense Remote',
    embedSteps: [
      '1. Open **Lovense Remote** and connect your toys to it.',
      '2. Tap **Me → Scan QR code** and scan the image below.',
      '3. Confirm the prompt in the app.',
      '',
      'This links the **app**, not a single toy: any toy connected to Lovense Remote can be used.',
      'You stay in control: **Stop** in the app ends the link at once, and `/stop` halts everything from here.',
    ],
    /** Added under the steps when Lovense gives a code for the PC app. */
    pcCode: (code: string) => `\nUsing Lovense Remote for PC? Enter code: \`${code}\``,
    embedFooter: "This QR code is private — don't share it.",

    /** Lovense would not give a QR code. */
    qrFailed: (message: string) =>
      `Couldn't get a QR code: ${message}\n` +
      'Check that `LOVENSE_TOKEN` is right and the callback URL is set in the Lovense dashboard.',
  },

  // ===========================================================================
  // /test — everyone. Always tests her toys, whoever runs it.
  // ===========================================================================
  test: {
    describe: 'Check whether the toys are responding (nothing will move)',

    /** First line of the reply. */
    heading: (self: boolean, name: string) => `**Test: ${self ? 'your' : `${name}'s`} toys**`,
    responding: (toy: string) => `🟢 ${toy} — responding`,
    notResponding: (toy: string, meaning: string, code: number | undefined) =>
      `🔴 ${toy} — not responding: ${meaning}${codeSuffix(code)}`,
    /** The app answered but has no toy connected over Bluetooth. */
    appOnlyNoToy: '🟡 Lovense Remote answered, but no toy is connected to it. Check Bluetooth.',
    /** No toy reports connected and the app didn't answer either. */
    appNotResponding: (meaning: string) => `🔴 Not responding — ${meaning}`,
    /** A toy the app lists but says is disconnected. */
    disconnected: (toy: string) => `⚫ ${toy} — not connected to the app (Bluetooth)`,
    /** Added when there is a specific fix. */
    hint: (hint: string) => `⚠️ ${cap(hint)}.`,
    /** Added when she was sent fix-it steps. */
    dmSent: (owner: string) => `📩 Sent ${userMention(owner)} the steps to fix it.`,
    /** Added when that DM could not be delivered. */
    dmFailed: (owner: string) =>
      `Couldn't DM ${userMention(owner)} the steps — their DMs may be closed.`,
    /** Last line, small. */
    footer: (lastCheckIn: number) =>
      `-# Nothing moved: the test sends a 0% command. Lovense Remote last checked in ${rel(lastCheckIn)}.`,
  },

  // ===========================================================================
  // /stop — everyone
  // ===========================================================================
  stop: {
    describe: 'Stop everything now, and keep it stopped for a while',
    describeDuration: (defaultMinutes: number) =>
      `Minutes to keep everything stopped (default ${defaultMinutes}; 0 lifts a stop)`,

    /** With a lockout. */
    stoppedUntil: (until: number) =>
      `**Stopped.** Every toy has been halted. Nothing can start again ${rel(until)}.`,
    /** duration:0 while no lockout was running. */
    stoppedNoLock: '**Stopped.** Every toy has been halted. You can start again whenever you like.',
    /** duration:0 while a lockout was running: lifts it. */
    stoppedAndLifted: '**Stopped**, and the stop timer is lifted — things can start again now.',
  },

  // ===========================================================================
  // /tease — controller. Acts on her toys, following the focus.
  // ===========================================================================
  tease: {
    describe: 'Tease: messages from anyone else in the main channel buzz her focused toys',
    describeIntensity: (defaultPercent: number) => `Buzz strength %, default ${defaultPercent}`,
    describeDuration: (defaultSec: number) => `Buzz length in seconds, default ${defaultSec}`,
    describeOff: 'Turn tease off instead',

    /** Her app is known unreachable, so starting would do nothing. */
    unreachable: (name: string) =>
      `${name}'s Lovense Remote isn't reachable, so tease would do nothing. Run \`/test\` to see why.`,

    /** Tease started. */
    started: (name: string, percent: number, sec: number, focus: string, mainChannelId: string) =>
      `**Tease on** for ${name}: ${percent}% for ${sec}s.\n` +
      `Messages from anyone else in ${channelMention(mainChannelId)} buzz ${focus}.\n` +
      '`/tease off:True` turns it off, `/focus` changes which toys, `/stop` halts everything.',
    /** /tease run again while already on: strength or length changed. */
    retuned: (name: string, percent: number, sec: number, focus: string) =>
      `**Tease updated** for ${name}: now ${percent}% for ${sec}s, reaching ${focus}.`,
    /** Added when the focus can't be reached right now. */
    focusProblem: (error: string) =>
      `\n⚠️ Right now ${error}, so messages won't buzz anything until that changes.`,
    /** Added when her app hasn't been confirmed reachable yet. */
    notConfirmed: "\n\n*Not confirmed reachable yet — run `/test` if you're unsure.*",

    // --- off:True ---
    turnedOff: (name: string, buzzes: number, missed: number, minutes: number) =>
      `**Tease off** for ${name}. ${buzzes} buzz(es)${missed > 0 ? `, ${missed} missed` : ''} over ${minutes} minute(s).`,
    /** Tease wasn't on; a stop was sent anyway in case a buzz or pattern was running. */
    wasNotOn: (name: string) =>
      `Tease wasn't on for ${name}. Sent a stop anyway, in case anything was running.`,
  },

  // ===========================================================================
  // /buzz — controller. Her focused toys.
  // ===========================================================================
  buzz: {
    describe: 'Vibrate her focused toys at a given strength for a given time',
    describeIntensity: 'Strength as a percentage',
    describeSeconds: 'How long to run',
    /** The focus can't be reached right now. */
    cannot: (error: string) => `Can't buzz: ${error}.`,
    sent: (percent: number, sec: number, focus: string) =>
      `Sent: ${percent}% for ${sec}s to ${focus}. \`/stop\` ends it early.`,
  },

  // ===========================================================================
  // /pattern — controller. Her focused toys.
  // ===========================================================================
  pattern: {
    describe: 'Play a named pattern on her focused toys',
    describeName: 'Which pattern (from the patterns folder)',
    /** In the name suggestions, for a file that fails validation. */
    invalidSuggestion: 'invalid file — see /pattern',
    /** The pattern file is missing or invalid. */
    cannotPlay: (name: string, error: string) => `Can't play "${name}": ${error}.`,
    available: (names: string) => `Available: ${names}`,
    noPatterns: 'There are no patterns yet. Copy `patterns/_template.json` to add one.',
    /** The focus can't be reached right now. */
    cannot: (name: string, error: string) => `Can't play "${name}": ${error}.`,
    playing: (name: string, sec: number, focus: string) =>
      `Playing **${name}** for ${sec}s on ${focus}. \`/stop\` ends it early.`,
  },

  // ===========================================================================
  // /status — controller
  // ===========================================================================
  status: {
    describe: 'Show linked toys, the focus, and whether tease is on',
    noLinks: 'No toys are linked. Run `/connect` to link one.',
    embedTitle: 'Toy status',
    online: '🟢 Online',
    offline: '🔴 Offline',
    unknown: '⚪ Unknown',
    noHeartbeats: ' (no check-ins — enable heartbeat in the Lovense dashboard)',
    app: (platform: string | null) => `App: ${platform ?? 'unknown'}`,
    lastCheckIn: (at: number) => `Last check-in: ${rel(at)}`,
    neverCheckedIn: 'Last check-in: never — QR not scanned yet',
    focus: (label: string) => `Focus: ${label}`,
    toyLine: (toy: string, battery: number | undefined, connected: boolean, focused: boolean) =>
      `• ${toy}${battery !== undefined ? ` ${battery}%` : ''}${connected ? '' : ' — disconnected'}${focused ? ' ◀ focus' : ''}`,
    noToys: '• no toys reported yet',
    teaseOff: 'Tease off',
    teaseOn: (detail: string, startedAt: number, by: string | null) =>
      `**Tease on** at ${detail} · started ${rel(startedAt)}${by ? ` by ${userMention(by)}` : ''}`,
    teasePaused: (detail: string, startedAt: number, by: string | null) =>
      `**Tease paused** (app unreachable) at ${detail} · started ${rel(startedAt)}${by ? ` by ${userMention(by)}` : ''}`,
  },

  // ===========================================================================
  // /disconnect — controller
  // ===========================================================================
  disconnect: {
    describe: "Unlink someone's Lovense Remote and delete its record from the bot",
    describeTarget: 'Whose link to remove',
    nothingLinked: (self: boolean, name: string) =>
      self ? 'You have no toy linked.' : `${name} has no toy linked.`,
    done: (self: boolean, name: string) =>
      `Unlinked ${self ? 'your' : `${name}'s`} Lovense Remote and turned tease off. ` +
      'The app stays authorised until **Stop** is pressed in Lovense Remote. `/connect` links again.',
  },

  // ===========================================================================
  // A tease summary — used by /status, the board and the reminder
  // ===========================================================================
  /** "50% / 1.5s · 12 buzz(es) · 2 missed" */
  teaseDetail: (percent: number, sec: number, buzzes: number, missed: number) =>
    `${percent}% / ${sec}s · ${buzzes} buzz(es)${missed > 0 ? ` · ${missed} missed` : ''}`,

  // ===========================================================================
  // The pinned status board in the command channel
  // ===========================================================================
  board: {
    header: (updatedAt: number) => `**Shortwave — live status** · updated ${rel(updatedAt)}`,
    /** Shown above everything while a /stop lockout runs. */
    stoppedBanner: (by: string, until: number) =>
      `🛑 **Stopped by ${userMention(by)} — nothing can start ${rel(until)}.**`,
    noLinks: '*No toys linked. Run `/connect` to link one.*',
    /** One per person. */
    person: (displayName: string, userId: string) => `**${displayName}** · ${userMention(userId)}`,
    toyLine: (dot: string, toy: string, battery: number | undefined, connected: boolean, focused: boolean) =>
      `${dot} ${toy}${battery !== undefined ? ` · ${battery}%` : ''}${connected ? '' : ' · disconnected'}${focused ? ' ◀ focus' : ''}`,
    noToys: (dot: string) => `${dot} no toys reported`,
    /** Under the toys: the focus, then the tease state. */
    focusAndTease: (focus: string, tease: string) => `focus: ${focus} · ${tease}`,
    teaseOff: 'tease off',
    teaseOn: (detail: string, running: string) => `tease on at ${detail} · ${running}`,
    teasePaused: (detail: string, running: string) =>
      `tease paused (app unreachable) at ${detail} · ${running}`,

    // The reachability line under each person's toys.
    reachableProbed: (at: number) => `reachable, checked ${rel(at)}`,
    reachableHeartbeat: 'reachable (app checking in)',
    /** Added when the app is checking in but the last command failed. */
    lastFailed: (at: number, meaning: string, code: number | undefined) =>
      ` · last command failed ${rel(at)}: ${meaning}${codeSuffix(code)}`,
    unreachable: (since: number | null, meaning: string, code: number | undefined) =>
      `unreachable${since ? ` since ${rel(since)}` : ''} — ${meaning}${codeSuffix(code)}`,
    unreachableSilent: (since: number | null) =>
      `unreachable${since ? ` since ${rel(since)}` : ''} — no check-in from Lovense Remote`,
    /** On its own line under "unreachable", when there is a specific fix. */
    hint: (hint: string) => `⚠️ ${cap(hint)}`,
    notScanned: 'QR not scanned yet',
    notChecked: 'not checked yet',
  },

  // ===========================================================================
  // Messages the bot posts on its own, in the command channel
  // ===========================================================================
  channel: {
    /** A QR code from /connect was scanned (first time, or re-paired). */
    connected: (user: string, toys: string) =>
      `${userMention(user)} connected Lovense Remote (${toys}). Use \`/tease\` when ready.`,
    /** In `connected`, when the app reported no toys. */
    noToysReported: 'no toys reported yet',

    /** Tease turned itself off: the app stayed unreachable past OFFLINE_GRACE_SEC. */
    teaseOffAfterOutage: (user: string) =>
      `⚠️ ${userMention(user)}'s toys stopped responding, so tease has been turned off. ` +
      'The pinned status shows the live state.',

    /** Every TEASE_REMINDER_MINUTES while tease is on. Doesn't ping. */
    reminder: (user: string, since: number, detail: string, focus: string, reach: string) =>
      `**Tease still on** for ${userMention(user)} — since ${rel(since)} · ${detail} · reaching ${focus} · ${reach}`,
    /** The reachability part of the reminder. */
    reminderPaused: '⏸️ paused — app unreachable',
    reminderReachable: (checkedAt: number | null) =>
      `🟢 reachable${checkedAt !== null ? `, checked ${rel(checkedAt)}` : ''}`,
    reminderUnreachable: '🔴 unreachable',
    reminderUnknown: '⚪ reachability unknown',

    /** Someone ran /stop somewhere other than the command channel. */
    stopRun: (user: string, channel: string, people: number, until: number | null, lifted: boolean) =>
      `🛑 ${userMention(user)} ran \`/stop\` in ${channelMention(channel)}. ` +
      `All toys halted${people > 0 ? ` and tease turned off for ${people} person(s)` : ''}. ` +
      (until !== null ? `Locked until ${rel(until)}.` : lifted ? 'Lockout lifted.' : 'No lockout.'),
  },

  // ===========================================================================
  // Direct messages. Sent only when /test finds a toy not responding, to her,
  // with the steps for that particular failure.
  // ===========================================================================
  dm: {
    /** The app is open but iOS has suspended its connection. */
    backgrounded:
      "**Your toy isn't responding** — Lovense Remote looks like it's been put in the background.\n\n" +
      'To fix it:\n' +
      '1. **Force-quit** Lovense Remote: swipe up from the bottom, then swipe the app away. ' +
      "Just reopening it usually isn't enough.\n" +
      '2. Open it again and wait for the toy to reconnect.\n' +
      '3. Run `/test` to check.',
    /** No contact from the app at all. */
    appClosed:
      "**Your toy isn't responding** — Lovense Remote seems to be closed, or your phone is offline.\n\n" +
      'To fix it:\n' +
      '1. Open Lovense Remote and check your toy is connected.\n' +
      '2. Make sure your phone has a data or Wi-Fi connection.\n' +
      '3. Run `/test` to check.',
    /** The app answers but no toy is attached over Bluetooth. */
    bluetooth:
      "**Your toy isn't connected** — Lovense Remote is running, but no toy is connected to it.\n\n" +
      'To fix it:\n' +
      '1. Make sure the toy is switched on and charged.\n' +
      '2. In Lovense Remote, connect the toy (it should show as connected).\n' +
      '3. Run `/test` to check.',
    /** Lovense no longer recognises the link. */
    unlinked:
      "**Your Lovense Remote isn't linked any more** — Lovense doesn't recognise the connection.\n\n" +
      'To fix it: run `/connect` and scan the new QR code in Lovense Remote.',
    /** Lovense's servers couldn't be reached — not something she can fix. */
    network:
      "**Your toy couldn't be reached** — the Lovense servers didn't answer. " +
      "This usually isn't anything on your side. Try `/test` again in a few minutes.",
  },
};

export type DmKind = keyof typeof text.dm;
