import { createHmac } from 'node:crypto';
import { config } from '../config';
import { log } from '../logger';
import { text } from '../text';
import { describeAction, type QrCodeResult, type ToyAction } from './types';

const QR_URL = 'https://api.lovense.com/api/lan/getQrCode';
/**
 * The cloud command endpoint. Note: the Standard_solutions README shows the
 * LAN URL in its "By server" section by mistake — this is the correct one,
 * documented in lovense/Cam-Solutions.
 */
const COMMAND_URL = 'https://api.lovense.com/api/lan/v2/command';

const REQUEST_TIMEOUT_MS = 8000;

/** Server-side error codes from the Lovense API. */
const SERVER_ERRORS: Record<number, string> = {
  400: 'Invalid command',
  404: 'Invalid parameter',
  501: 'Invalid developer token',
  502: 'This developer token is not permitted to use the server API',
  503: 'Unknown user ID — the toy is not linked to this bot',
  507: 'The Lovense Remote app is offline',
};

/**
 * What a command result means, for people. Shown on the status board, in
 * /test and in the outage notice, so the numbers never need looking up.
 */
export function explainCode(code: number | undefined): string {
  if (code === undefined) return text.codes.network;
  return (text.codes as Record<number, string>)[code] ?? text.codes.unknown;
}

export class LovenseError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LovenseError';
  }
}

/**
 * Per-user token. Lovense echoes this back in the callback, so we can verify
 * a callback really belongs to the uid it claims. Derived rather than stored
 * so it survives a database wipe.
 */
export function deriveUserToken(uid: string): string {
  return createHmac('sha256', config.USER_TOKEN_SALT).update(uid).digest('hex').slice(0, 32);
}

/** Lovense uid namespaced per guild, so the same person can link separately elsewhere. */
export function makeUid(guildId: string, discordUserId: string): string {
  return `${guildId}:${discordUserId}`;
}

async function postJson(url: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LovenseError(
      `Could not reach Lovense (${(err as Error).message})`,
      undefined,
      true,
    );
  }

  if (!res.ok) {
    throw new LovenseError(`Lovense returned HTTP ${res.status}`, res.status, res.status >= 500);
  }

  try {
    return await res.json();
  } catch {
    throw new LovenseError('Lovense returned a non-JSON response', undefined, true);
  }
}

export class LovenseClient {
  constructor(private readonly token: string = config.LOVENSE_TOKEN) {}

  /**
   * Ask Lovense for a pairing QR code for this uid. The user scans it in the
   * Lovense Remote app; the app then POSTs toy details to our callback URL.
   */
  async getQrCode(uid: string, displayName: string): Promise<QrCodeResult> {
    const data = await postJson(QR_URL, {
      token: this.token,
      uid,
      uname: displayName.slice(0, 32),
      utoken: deriveUserToken(uid),
      v: 2,
    });

    // Success on this endpoint is code: 0 (unlike /command, which uses 200).
    if (data?.code !== 0 || !data?.data?.qr) {
      const msg = data?.message ?? 'unknown error';
      throw new LovenseError(`Could not generate a QR code: ${msg}`, data?.code, false);
    }

    return { qr: data.data.qr, code: data.data.code ?? '' };
  }

  /**
   * Send an action to every toy linked to `uid`, routed through Lovense's
   * servers — no LAN access to the toy required.
   */
  async send(uid: string, action: ToyAction, toyId?: string): Promise<void> {
    const payload: Record<string, unknown> = {
      token: this.token,
      uid,
      apiVer: 1,
      ...toPayload(action),
    };
    if (toyId) payload.toy = toyId;

    const data = await postJson(COMMAND_URL, payload);

    if (data?.code !== 200) {
      const code = typeof data?.code === 'number' ? data.code : undefined;
      const msg = (code && SERVER_ERRORS[code]) || data?.message || 'unknown error';
      // 507 (app offline) is transient; token/permission problems are not.
      throw new LovenseError(msg, code, code === 507 || code === undefined);
    }

    log.debug(`Lovense OK: ${describeAction(action)} -> ${uid}`);
  }

  /** Send several uids at once — Lovense accepts a comma-separated list. */
  async sendMany(uids: string[], action: ToyAction): Promise<void> {
    if (uids.length === 0) return;
    await this.send(uids.join(','), action);
  }
}

function toPayload(action: ToyAction): Record<string, unknown> {
  switch (action.kind) {
    case 'function':
      return {
        command: 'Function',
        action: action.action,
        timeSec: action.timeSec,
        ...(action.loopRunningSec ? { loopRunningSec: action.loopRunningSec } : {}),
        ...(action.loopPauseSec ? { loopPauseSec: action.loopPauseSec } : {}),
        ...(action.stopPrevious !== undefined ? { stopPrevious: action.stopPrevious } : {}),
      };
    case 'pattern':
      return {
        command: 'Pattern',
        rule: action.rule,
        strength: action.strength,
        timeSec: action.timeSec,
      };
    case 'preset':
      return { command: 'Preset', name: action.name, timeSec: action.timeSec };
  }
}

export const lovense = new LovenseClient();
