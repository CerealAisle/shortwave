/**
 * Every piece of text the bot shows in Discord, in one place.
 *
 * Edit wording here and nowhere else. Plain strings are fixed text; the
 * functions fill in names, numbers and times. Keep the placeholders they use
 * (`${...}`) — they are what the code passes in.
 *
 * Discord formatting that appears below:
 *   **bold**   *italic*   `code`   -# small grey text (a whole line)
 *   time(…, 'R')   renders as a live relative time, e.g. "in 3 minutes"
 *   userMention(id) / channelMention(id)   render as @name / #channel
 *
 * Slash command and option descriptions (the `describe` entries) are shown in
 * Discord's command picker. Discord caps them at 100 characters, and they only
 * update after `npm run deploy-commands`.
 */
import { channelMention, time, userMention } from 'discord.js';

/** A Discord live relative time: "2 minutes ago", "in 30 minutes". */
const rel = (ms: number) => time(Math.floor(ms / 1000), 'R');
/** First letter upper-cased, for a phrase that starts a sentence. */
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "Your" or "Sam's" */
const whose = (self: boolean, name: string) => (self ? 'Your' : `${name}'s`);
/** "your" or "Sam's" */
const whoseLower = (self: boolean, name: string) => (self ? 'your' : `${name}'s`);

export const text = {
  // ---------------------------------------------------------------------------
  // Shared by several commands
  // ---------------------------------------------------------------------------
  common: {
    /** A command used outside the bot's server. */
    wrongServer: 'This bot only works in its own server.',
    /** A command used in a channel that is neither main nor command. */
    wrongChannel: 'Commands only work in the main channel or the bot channel.',
    /** A command crashed. */
    somethingWentWrong: 'Something went wrong running that command.',

    /** The target has never run /connect. */
    noToy: (self: boolean, name: string) =>
      self ? 'You have no toy linked yet. Run `/connect` first.' : `${name} has no toy linked.`,
    /** /connect was run but the QR code was never scanned. */
    notScanned: (self: boolean, name: string) =>
      `${whose(self, name)} QR code hasn't been scanned yet. Scan the code from \`/connect\` first.`,

    /** A command that would move a toy, refused during a /stop lockout. */
    stopped: (by: string, until: number) =>
      `Stopped by ${userMention(by)} — nothing can start ${rel(until)}.`,

    /** A command that sent something to a toy and Lovense refused. */
    commandFailed: (meaning: string, code: number | undefined) =>
      `That didn't go through — ${meaning}${code !== undefined ? ` (${code})` : ''}.`,
  },

  // ---------------------------------------------------------------------------
  // The `toy` option on /tease, /buzz and /pattern
  // ---------------------------------------------------------------------------
  toy: {
    describe: 'Which toy (defaults to all of them)',
    /** The app has not reported any toys. */
    noneReported:
      'the Lovense app hasn\'t reported any toys yet. Open Lovense Remote with the toy connected and wait a moment',
    /** Two toys share the name typed. */
    ambiguous: (typed: string) =>
      `more than one toy is called "${typed}". Pick it from the suggestions instead`,
    /** No toy matches the name typed. */
    notFound: (typed: string, available: string) => `no toy called "${typed}". Toys: ${available}`,
    /** In the suggestions list, after the battery. */
    disconnectedSuffix: ' · disconnected',
  },

  // ---------------------------------------------------------------------------
  // What Lovense's answers mean. Used by /test, the status board and errors.
  // ---------------------------------------------------------------------------
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
      "looks backgrounded — the app is still checking in, but commands are refused. Force-quit Lovense Remote and reopen it",
    /** 507 with no recent check-in. */
    appClosed: 'the app is closed or the phone is offline. Open Lovense Remote',
  },

  // ---------------------------------------------------------------------------
  // /connect — everyone
  // ---------------------------------------------------------------------------
  connect: {
    describe: 'Link your Lovense toy by scanning a QR code',

    /** The private reply with the QR code. */
    embedTitle: 'Connect your toy',
    embedSteps: [
      '1. Open **Lovense Remote** and make sure your toy is connected to it.',
      '2. Tap **Me → Scan QR code** and scan the image below.',
      '3. Confirm the prompt in the app.',
      '',
      'You stay in control: **Stop** in the app ends the link at once, and `/stop` halts everything from here.',
    ],
    /** Added under the steps when Lovense gives a code for the PC app. */
    pcCode: (code: string) => `\nUsing Lovense Remote for PC? Enter code: \`${code}\``,
    embedFooter: "This QR code is private — don't share it.",

    /** Replaces the QR code once the scan lands (within 15 minutes). */
    scanned: (toys: string[]) =>
      `✅ **Connected.** ${toys.length > 0 ? `Shortwave can see: ${toys.join(', ')}.` : 'No toys reported yet — make sure your toy is connected in Lovense Remote.'}\n` +
      'Run `/test` any time to check it is responding.',

    /** Lovense would not give a QR code. */
    qrFailed: (message: string) =>
      `Couldn't get a QR code: ${message}\n` +
      'Check that `LOVENSE_TOKEN` is right and the callback URL is set in the Lovense dashboard.',
  },

  // ---------------------------------------------------------------------------
  // /test — everyone
  // ---------------------------------------------------------------------------
  test: {
    describe: 'Check whether toys are responding (nothing will move)',
    describeTarget: 'Whose toys (defaults to yours)',

    /** First line of the reply. */
    heading: (self: boolean, name: string) => `**Test: ${whoseLower(self, name)} toys**`,
    responding: (toy: string) => `🟢 ${toy} — responding`,
    notResponding: (toy: string, meaning: string, code: number | undefined) =>
      `🔴 ${toy} — not responding: ${meaning}${code !== undefined ? ` (${code})` : ''}`,
    /** The app answered but has no toy connected over Bluetooth. */
    appOnlyNoToy: '🟡 The Lovense app answered, but no toy is connected to it. Check Bluetooth.',
    /** No toy reports connected and the app didn't answer either. */
    appNotResponding: (meaning: string) => `🔴 Not responding — ${meaning}`,
    /** A toy the app lists but says is disconnected. */
    disconnected: (toy: string) => `⚫ ${toy} — not connected to the app (Bluetooth)`,
    /** Added when there is a specific fix. */
    hint: (hint: string) => `⚠️ ${cap(hint)}.`,
    /** Added when the toy's owner was sent fix-it steps. */
    dmSent: (owner: string) => `📩 Sent ${userMention(owner)} the steps to fix it.`,
    /** Added when that DM could not be delivered. */
    dmFailed: (owner: string) =>
      `Couldn't DM ${userMention(owner)} the steps — their DMs may be closed.`,
    /** Last line, small. */
    footer: (lastCheckIn: number) =>
      `-# Nothing moved: the test sends a 0% command. App last checked in ${rel(lastCheckIn)}.`,
  },

  // ---------------------------------------------------------------------------
  // /stop — everyone
  // ---------------------------------------------------------------------------
  stop: {
    describe: 'Stop everything now, and keep it stopped for a while',
    describeDuration: (defaultMinutes: number) =>
      `Minutes to keep everything stopped (default ${defaultMinutes}; 0 to lift a stop)`,

    /** With a lockout. */
    stoppedUntil: (until: number) =>
      `**Stopped.** Every toy has been halted. Nothing can start again ${rel(until)}.`,
    /** duration:0 while no lockout was running. */
    stoppedNoLock: '**Stopped.** Every toy has been halted. You can start again whenever you like.',
    /** duration:0 while a lockout was running: lifts it. */
    stoppedAndLifted: '**Stopped**, and the stop timer is lifted — things can start again now.',
  },

  // ---------------------------------------------------------------------------
  // /tease — controller
  // ---------------------------------------------------------------------------
  tease: {
    describe: 'Tease: messages from anyone else in the main channel buzz the toy',
    describeUser: 'Whose toy (defaults to yours)',
    describeIntensity: (defaultPercent: number) => `Buzz strength %, default ${defaultPercent}`,
    describeDuration: (defaultSec: number) => `Buzz length in seconds, default ${defaultSec}`,
    describeOff: 'Turn tease off instead (for this user, or just this toy)',

    /** The toy is known unreachable, so starting would do nothing. */
    unreachable: (self: boolean, name: string) =>
      `${whose(self, name)} toy isn't reachable, so tease would do nothing. Run \`/test\` to see why.`,
    /** The `toy` option could not be matched. */
    badToy: (error: string) => `Can't start tease: ${error}.`,

    /** One line per toy started. */
    started: (toy: string, percent: number, sec: number) =>
      `**Tease on**: ${toy} at ${percent}% for ${sec}s`,
    /** One line per toy already teasing that was retuned. */
    retuned: (toy: string, percent: number, sec: number) =>
      `**Tease updated**: ${toy} now ${percent}% for ${sec}s`,
    /** After those lines. */
    explainer: (self: boolean, name: string, toys: string, mainChannelId: string) =>
      `Messages from anyone else in ${channelMention(mainChannelId)} buzz ${whoseLower(self, name)} ${toys}.\n` +
      '`/tease off:True` turns it off, `/stop` halts everything.',
    /** Added when the toy hasn't been confirmed reachable yet. */
    notConfirmed: "\n\n*Not confirmed reachable yet — run `/test` if you're unsure.*",

    // --- off:True ---
    /** The `toy` option could not be matched. */
    badToyOff: (error: string) => `Can't turn that off: ${error}.`,
    /** Tease was on and has been turned off. */
    turnedOff: (toys: string, buzzes: number, missed: number, minutes: number) =>
      `**Tease off** for ${toys}. ${buzzes} buzz(es)${missed > 0 ? `, ${missed} missed` : ''} over ${minutes} minute(s).`,
    /** Added when other toys of the same person are still teasing. */
    stillOn: (toys: string) => `\nStill on: ${toys}.`,
    /** Tease wasn't on; a stop was sent anyway in case a buzz or pattern was running. */
    wasNotOn: (self: boolean, name: string) =>
      `Tease wasn't on for ${whoseLower(self, name)} toy. Sent a stop anyway, in case anything was running.`,
  },

  // ---------------------------------------------------------------------------
  // /buzz — controller
  // ---------------------------------------------------------------------------
  buzz: {
    describe: 'Vibrate a toy at a given strength for a given time',
    describeIntensity: 'Strength as a percentage',
    describeSeconds: 'How long to run',
    describeTarget: 'Whose toy (defaults to yours)',
    badToy: (error: string) => `Can't buzz: ${error}.`,
    sent: (percent: number, sec: number, toys: string | null) =>
      `Sent: ${percent}% for ${sec}s${toys ? ` on ${toys}` : ''}. \`/stop\` ends it early.`,
  },

  // ---------------------------------------------------------------------------
  // /pattern — controller
  // ---------------------------------------------------------------------------
  pattern: {
    describe: 'Play a named pattern on a toy',
    describeName: 'Which pattern (from the patterns folder)',
    describeTarget: 'Whose toy (defaults to yours)',
    /** In the name suggestions, for a file that fails validation. */
    invalidSuggestion: 'invalid file — see /pattern',
    /** The pattern file is missing or invalid. */
    cannotPlay: (name: string, error: string) => `Can't play "${name}": ${error}.`,
    available: (names: string) => `Available: ${names}`,
    noPatterns: 'There are no patterns yet. Copy `patterns/_template.json` to add one.',
    badToy: (name: string, error: string) => `Can't play "${name}": ${error}.`,
    playing: (name: string, sec: number, toys: string | null) =>
      `Playing **${name}** for ${sec}s${toys ? ` on ${toys}` : ''}. \`/stop\` ends it early.`,
  },

  // ---------------------------------------------------------------------------
  // /status — controller
  // ---------------------------------------------------------------------------
  status: {
    describe: 'Show linked toys and which have tease on',
    noLinks: 'No toys are linked. Run `/connect` to link one.',
    embedTitle: 'Toy status',
    online: '🟢 Online',
    offline: '🔴 Offline',
    unknown: '⚪ Unknown',
    noHeartbeats: ' (no heartbeats — enable heartbeat in the Lovense dashboard)',
    app: (platform: string | null) => `App: ${platform ?? 'unknown'}`,
    lastCheckIn: (at: number) => `Last check-in: ${rel(at)}`,
    neverCheckedIn: 'Last check-in: never — QR not scanned yet',
    toyLine: (toy: string, battery: number | undefined, connected: boolean, tease: string) =>
      `• ${toy}${battery !== undefined ? ` ${battery}%` : ''}${connected ? '' : ' — disconnected'} — ${tease}`,
    toyGone: (toy: string, tease: string) => `• ${toy} — no longer reported by the app — ${tease}`,
    noToys: '• none reported yet',
    teaseOff: 'tease off',
    teaseOn: (detail: string, startedAt: number, by: string | null) =>
      `**tease on** at ${detail} · started ${rel(startedAt)}${by ? ` by ${userMention(by)}` : ''}`,
    teasePaused: (detail: string, startedAt: number, by: string | null) =>
      `**tease paused** (toy unreachable) at ${detail} · started ${rel(startedAt)}${by ? ` by ${userMention(by)}` : ''}`,
  },

  // ---------------------------------------------------------------------------
  // /disconnect — controller
  // ---------------------------------------------------------------------------
  disconnect: {
    describe: 'Unlink a toy and delete its record from the bot',
    describeTarget: 'Whose toy to unlink (defaults to yours)',
    nothingLinked: (self: boolean, name: string) =>
      self ? 'You have no toy linked.' : `${name} has no toy linked.`,
    done: (self: boolean, name: string) =>
      `Unlinked ${self ? 'your toy' : `${name}'s toy`} and turned tease off. ` +
      'For a full disconnect, also press **Stop** in Lovense Remote. `/connect` links again.',
  },

  // ---------------------------------------------------------------------------
  // Shared descriptions of a toy's tease
  // ---------------------------------------------------------------------------
  /** "50% / 1.5s · 12 buzz(es) · 2 missed" — used by /status and the board. */
  teaseDetail: (percent: number, sec: number, buzzes: number, missed: number) =>
    `${percent}% / ${sec}s · ${buzzes} buzz(es)${missed > 0 ? ` · ${missed} missed` : ''}`,

  // ---------------------------------------------------------------------------
  // The pinned status board in the command channel
  // ---------------------------------------------------------------------------
  board: {
    header: (updatedAt: number) => `**Shortwave — live status** · updated ${rel(updatedAt)}`,
    /** Shown above everything while a /stop lockout runs. */
    stoppedBanner: (by: string, until: number) =>
      `🛑 **Stopped by ${userMention(by)} — nothing can start ${rel(until)}.**`,
    noLinks: '*No toys linked. Run `/connect` to link one.*',
    /** One per person. */
    person: (displayName: string, userId: string) => `**${displayName}** · ${userMention(userId)}`,
    toyLine: (dot: string, toy: string, battery: number | undefined, connected: boolean, tease: string) =>
      `${dot} ${toy}${battery !== undefined ? ` · ${battery}%` : ''}${connected ? '' : ' · disconnected'} — ${tease}`,
    toyGone: (toy: string, tease: string) => `⚫ ${toy} · no longer reported — ${tease}`,
    noToys: (dot: string) => `${dot} no toys reported`,
    teaseOff: 'tease off',
    teaseOn: (detail: string, running: string) => `tease on at ${detail} · ${running}`,
    teasePaused: (detail: string, running: string) =>
      `tease paused (toy unreachable) at ${detail} · ${running}`,

    // The reachability line under each person's toys.
    reachableProbed: (at: number) => `reachable, checked ${rel(at)}`,
    reachableHeartbeat: 'reachable (app checking in)',
    /** Added when the app is checking in but the last command failed. */
    lastFailed: (at: number, meaning: string, code: number | undefined) =>
      ` · last command failed ${rel(at)}: ${meaning}${code !== undefined ? ` (${code})` : ''}`,
    unreachable: (since: number | null, meaning: string, code: number | undefined) =>
      `unreachable${since ? ` since ${rel(since)}` : ''} — ${meaning}${code !== undefined ? ` (${code})` : ''}`,
    unreachableSilent: (since: number | null) =>
      `unreachable${since ? ` since ${rel(since)}` : ''} — no check-in from the app`,
    /** On its own line under "unreachable", when there is a specific fix. */
    hint: (hint: string) => `⚠️ ${cap(hint)}`,
    notScanned: 'QR not scanned yet',
    notChecked: 'not checked yet',
  },

  // ---------------------------------------------------------------------------
  // Direct messages. Sent only when /test finds a toy not responding, to the
  // toy's owner, with the steps for that particular failure.
  // ---------------------------------------------------------------------------
  dm: {
    /** The app is open but iOS has suspended its connection. */
    backgrounded:
      "**Your toy isn't responding** — Lovense Remote looks like it's been put in the background.\n\n" +
      'To fix it:\n' +
      '1. **Force-quit** Lovense Remote: swipe up from the bottom, then swipe the app away. ' +
      'Just reopening it usually isn\'t enough.\n' +
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
      "**Your toy isn't connected** — Lovense Remote is running, but no toy is attached to it.\n\n" +
      'To fix it:\n' +
      '1. Make sure the toy is switched on and charged.\n' +
      '2. In Lovense Remote, connect the toy (it should show as connected).\n' +
      '3. Run `/test` to check.',
    /** Lovense no longer recognises the link. */
    unlinked:
      "**Your toy isn't linked any more** — Lovense doesn't recognise the connection.\n\n" +
      'To fix it: run `/connect` and scan the new QR code in Lovense Remote.',
    /** Lovense's servers couldn't be reached — not something she can fix. */
    network:
      "**Your toy couldn't be reached** — the Lovense servers didn't answer. " +
      "This usually isn't anything on your side. Try `/test` again in a few minutes.",
  },
};

export type DmKind = keyof typeof text.dm;
