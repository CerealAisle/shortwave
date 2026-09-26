/**
 * Types for the Lovense Standard API (server / "cloud" variant).
 * Docs: https://developer.lovense.com  and  github.com/lovense/Standard_solutions
 */

/** Raw toy record as reported by Lovense Remote in the callback payload. */
export interface LovenseToy {
  id: string;
  name: string;
  nickName?: string;
  /** "1" / 1 = connected */
  status: string | number;
  battery?: number;
  version?: string;
}

/** Body Lovense Remote POSTs to your callback URL after a successful scan. */
export interface LovenseCallbackBody {
  uid: string;
  utoken: string;
  toys: Record<string, LovenseToy> | string;
  appVersion?: string;
  appType?: string;
  platform?: string;
  domain?: string;
  httpPort?: string | number;
  httpsPort?: string | number;
  wsPort?: string | number;
  wssPort?: string | number;
  version?: string | number;
}

export interface QrCodeResult {
  /** URL of a PNG/JPG QR image hosted by Lovense. */
  qr: string;
  /** Short code, used by Lovense Remote for PC where scanning isn't possible. */
  code: string;
}

/**
 * Every toy instruction in this bot is expressed as one of these.
 * Adding a new capability means adding a variant here plus a builder in
 * actions.ts — no changes to the transport or the session layer.
 */
export type ToyAction =
  | {
      kind: 'function';
      /** e.g. "Vibrate:10", "Vibrate:5,Rotate:12", "Stop" */
      action: string;
      timeSec: number;
      loopRunningSec?: number;
      loopPauseSec?: number;
      stopPrevious?: 0 | 1;
    }
  | {
      kind: 'pattern';
      /** e.g. "V:1;F:v;S:1000#" */
      rule: string;
      /** e.g. "20;20;5;20;10" (max 50 values) */
      strength: string;
      timeSec: number;
    }
  | {
      kind: 'preset';
      name: PresetName;
      timeSec: number;
    };

export const PRESET_NAMES = ['pulse', 'wave', 'fireworks', 'earthquake'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** Human-readable label used in logs and Discord replies. */
export function describeAction(a: ToyAction): string {
  switch (a.kind) {
    case 'function':
      return a.action === 'Stop' ? 'stop' : `${a.action} for ${a.timeSec}s`;
    case 'pattern':
      return `pattern [${a.strength}] for ${a.timeSec}s`;
    case 'preset':
      return `preset "${a.name}" for ${a.timeSec}s`;
  }
}
