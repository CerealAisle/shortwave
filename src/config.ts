import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const fields = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  // Two channels, two jobs. Messages in MAIN drive the triggers; everything
  // the bot says on its own initiative goes to COMMAND. Slash commands are
  // accepted in both and answer wherever they were run.
  MAIN_CHANNEL_ID: z.string().min(1),
  COMMAND_CHANNEL_ID: z.string().min(1),
  // The person commands act on — the wearer. /tease, /buzz, /pattern, /focus
  // and /test all target them, whoever runs the command. Optional: unset, it
  // is whoever is linked, as long as that is exactly one person.
  TARGET_USER_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),

  LOVENSE_TOKEN: z.string().min(1),
  USER_TOKEN_SALT: z.string().min(16, 'must be at least 16 chars'),

  CALLBACK_PORT: z.coerce.number().int().positive().default(4000),
  CALLBACK_PATH: z.string().startsWith('/').default('/lovense/callback'),
  CALLBACK_BIND: z.string().default('127.0.0.1'),

  DATABASE_PATH: z.string().default('./data/bot.db'),
  // One JSON file per /pattern. Read when the command runs, so new files
  // need no restart. See patterns/README.md.
  PATTERNS_DIR: z.string().default('./patterns'),

  BUZZ_INTENSITY_PERCENT: z.coerce.number().min(0).max(100).default(50),
  BUZZ_DURATION_SEC: z.coerce.number().min(0).default(1.5),
  MAX_INTENSITY_PERCENT: z.coerce.number().min(1).max(100).default(100),

  MIN_COMMAND_INTERVAL_MS: z.coerce.number().int().min(0).default(1500),
  MAX_COMMANDS_PER_MINUTE: z.coerce.number().int().min(1).default(25),
  // Tease has no expiry. Instead, while it is on, a reminder posts to the
  // command channel this often, carrying the buzz count and whether the toy
  // is reachable. Set to 0 to disable.
  TEASE_REMINDER_MINUTES: z.coerce.number().min(0).default(30),

  // After /stop, nothing that moves may start for this long — no buzz,
  // pattern or tease, from anyone. /stop's `duration` overrides it per use,
  // and a later /stop replaces it, so `duration:0` lifts it early.
  STOP_LOCKOUT_MINUTES: z.coerce.number().min(0).max(120).default(30),

  // Liveness. Requires "heartbeat" to be enabled in the Lovense developer
  // dashboard — without it, Lovense Remote only calls back once at pairing
  // time and every link would look stale. Set to 0 to disable the check.
  //
  // 300s is deliberately generous: iOS suspends background apps, so heartbeats
  // arrive in clusters with long gaps rather than on a clean interval.
  HEARTBEAT_TIMEOUT_SEC: z.coerce.number().min(0).default(300),
  PRESENCE_POLL_SEC: z.coerce.number().min(5).default(15),

  // Active liveness probe, and the primary presence signal. Each linked toy
  // is sent Vibrate:0 for ~1.1s — nothing moves — and Lovense's answer says
  // whether a real command would land right now: 200 reachable, 507 app
  // offline, 501/503 link or token problem. While a toy is unreachable the
  // interval backs off to PROBE_OFFLINE_INTERVAL_SEC so a dead link doesn't
  // fill the log. Set PROBE_INTERVAL_SEC to 0 to disable probing.
  PROBE_INTERVAL_SEC: z.coerce.number().min(0).default(300),
  PROBE_OFFLINE_INTERVAL_SEC: z.coerce.number().min(0).default(900),

  // When a toy goes offline mid-session the session is SUSPENDED, not ended,
  // and resumes by itself if the toy comes back within this window. Only
  // after the window closes is it disarmed for real. Set to 0 to disarm
  // immediately on the first blip.
  OFFLINE_GRACE_SEC: z.coerce.number().min(0).default(300),

  // iOS may drop the first command sent to a freshly-woken app. Retry a
  // retryable failure (507 / network) this many times before giving up.
  WAKE_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
  WAKE_RETRY_DELAY_MS: z.coerce.number().int().min(100).default(700),

  // When /test finds a toy not responding, DM its owner how to fix it. The
  // bot sends no other DMs: iOS can't be automated into restarting the
  // Lovense app, so the fix is a person, and a DM is a push notification
  // that reaches them. Set to false to keep it to the /test reply.
  DM_ON_FAILED_TEST: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  TRIGGER_ON_BOT_MESSAGES: bool,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const schema = fields.refine((c) => c.MAIN_CHANNEL_ID !== c.COMMAND_CHANNEL_ID, {
  // One channel doing both jobs would put every bot notice in front of the
  // person the command channel exists to keep them from.
  message: 'must differ from MAIN_CHANNEL_ID',
  path: ['COMMAND_CHANNEL_ID'],
});

/**
 * `dotenv/config` fails silently: a missing .env, an unreadable one and an
 * empty one all leave process.env untouched, and the only symptom is every
 * required key reporting "Required". That sends you looking for a quoting
 * problem in a file the process never opened. Work out which it actually is.
 */
function diagnoseEnvFile(): string | null {
  const envPath = resolve(process.cwd(), '.env');

  if (!existsSync(envPath)) {
    return (
      `No .env file found at ${envPath}\n` +
      `  Either it was never created (cp .env.example .env), or this command\n` +
      `  is running from the wrong directory — dotenv looks in the current\n` +
      `  working directory, not next to the script.`
    );
  }

  try {
    accessSync(envPath, constants.R_OK);
  } catch {
    return (
      `${envPath} exists but this process cannot read it.\n` +
      `  Running as uid ${process.getuid?.() ?? '?'}. Check owner and mode:\n` +
      `      ls -l ${envPath}\n` +
      `  It must be owned by the user the bot runs as. To fix:\n` +
      `      sudo chown lovensebot:lovensebot ${envPath} && sudo chmod 600 ${envPath}`
    );
  }

  if (statSync(envPath).size === 0) {
    return `${envPath} is empty. Copy .env.example over it and fill in the credentials.`;
  }

  return null;
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');

  const fileProblem = diagnoseEnvFile();

  console.error(
    fileProblem
      ? `Configuration could not be loaded.\n\n${fileProblem}\n\nMissing or invalid:\n${issues}`
      : `Invalid configuration. Check your .env file:\n${issues}`,
  );
  process.exit(1);
}

export const config = parsed.data;

/** Every setting the bot reads. .env.test must pin each one; see config.test.ts. */
export const CONFIG_KEYS = Object.keys(fields.shape);
export type Config = typeof config;
