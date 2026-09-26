import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config';
import { log } from '../logger';
import { deriveUserToken } from '../lovense/client';
import type { LovenseCallbackBody, LovenseToy } from '../lovense/types';
import { presence } from '../session/presence';
import { store } from '../store/store';

export type ToyStatusListener = (payload: {
  uid: string;
  toys: LovenseToy[];
  platform: string | null;
  /** True only for the pairing callback, false for every heartbeat after it. */
  firstConnect: boolean;
  /** Callbacks received so far, including this one. */
  callbackCount: number;
}) => void;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Lovense sometimes sends `toys` as an object, sometimes as a JSON string. */
function parseToys(raw: LovenseCallbackBody['toys']): LovenseToy[] {
  let obj: Record<string, LovenseToy>;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  } else {
    obj = raw ?? {};
  }
  return Object.values(obj).filter((t): t is LovenseToy => Boolean(t?.id));
}

export async function startCallbackServer(
  onToyStatus: ToyStatusListener,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.get('/healthz', async () => ({ ok: true, at: new Date().toISOString() }));

  app.post(config.CALLBACK_PATH, async (request, reply) => {
    const body = request.body as LovenseCallbackBody | undefined;

    if (!body?.uid) {
      return reply.code(400).send({ result: false, message: 'missing uid' });
    }

    // The uid is public-ish (it appears in the QR flow), so verify the utoken
    // Lovense echoes back before trusting anything in this payload.
    const expected = deriveUserToken(body.uid);
    if (!body.utoken || !safeEqual(body.utoken, expected)) {
      log.warn(`Rejected callback for ${body.uid}: bad utoken`);
      return reply.code(403).send({ result: false, message: 'invalid utoken' });
    }

    const link = store.getByUid(body.uid);
    if (!link) {
      log.warn(`Callback for unknown uid ${body.uid}`);
      return reply.code(404).send({ result: false, message: 'unknown uid' });
    }

    const toys = parseToys(body.toys);
    const firstConnect = link.lastSeen === null;

    store.recordCallback(body.uid, toys, body.platform ?? null);

    // Heartbeats arrive continuously once enabled, so only the pairing
    // callback gets an info line. The rest are debug-level noise.
    const line = `Callback: ${body.uid} reported ${toys.length} toy(s) via ${body.platform ?? 'unknown'}`;
    if (firstConnect) log.info(line);
    else log.debug(`${line} (heartbeat)`);

    // Recompute liveness immediately rather than waiting for the next sweep,
    // so a toy coming back online is reflected right away.
    presence.noteCallback(body.uid);

    try {
      onToyStatus({
        uid: body.uid,
        toys,
        platform: body.platform ?? null,
        firstConnect,
        callbackCount: (store.getByUid(body.uid)?.callbackCount ?? 1),
      });
    } catch (err) {
      log.error(`Toy status listener threw: ${(err as Error).message}`);
    }

    // Lovense expects an acknowledgement.
    return reply.send({ result: true, message: 'success' });
  });

  await app.listen({ port: config.CALLBACK_PORT, host: config.CALLBACK_BIND });
  log.info(
    `Callback server listening on http://${config.CALLBACK_BIND}:${config.CALLBACK_PORT}${config.CALLBACK_PATH}`,
  );

  return app;
}
