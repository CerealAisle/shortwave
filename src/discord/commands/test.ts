import { SlashCommandBuilder } from 'discord.js';
import { config } from '../../config';
import { explainCode, makeUid } from '../../lovense/client';
import { isToyConnected, toyLabel } from '../../lovense/toys';
import { sessions, type TestResult } from '../../session/manager';
import { diagnose, presence } from '../../session/presence';
import { text, type DmKind } from '../../text';
import { dm } from '../dm';
import { requireTarget } from '../target';
import type { BotCommand } from '../types';

/**
 * Which fix-it DM a failed test calls for, or null when there is nothing the
 * toy's owner can do (a bad developer token, a bot bug).
 */
export function dmKindFor(
  result: TestResult,
  backgrounded: boolean,
): Exclude<DmKind, 'bluetooth'> | null {
  if (result.ok) return null;
  switch (result.code) {
    case 507:
      return backgrounded ? 'backgrounded' : 'appClosed';
    case 503:
      return 'unlinked';
    case undefined:
      return 'network';
    default:
      return null;
  }
}

/**
 * Is it working? Sends Vibrate:0 — nothing moves — to each of her connected
 * toys (all of them, whatever the focus) and reports, in the channel it was
 * run in, what Lovense said for each. Always tests her, whoever runs it.
 *
 * Zero strength, so it is allowed during a /stop lockout and can never
 * surprise anyone. A success also counts as the command that ends an outage.
 *
 * When it fails for a reason the toy's owner can fix, they get a DM with the
 * steps. That is the only DM the bot sends.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('test')
    .setDescription(text.test.describe),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const target = await requireTarget(interaction, { scanned: true });
    if (!target) return;
    const { link, self } = target;
    const lastSeen = link.lastSeen!;

    await interaction.deferReply();

    const uid = makeUid(interaction.guildId, target.userId);
    const source = `test:${interaction.user.id}`;
    const connected = link.toys.filter(isToyConnected);
    const lines: string[] = [];
    let firstFailure: TestResult | null = null;
    let bluetoothOnly = false;

    if (connected.length === 0) {
      // Nothing reports connected: test the app itself, so the answer still
      // says whether the phone is reachable.
      const result = await sessions.test(uid, { source });
      if (result.ok) {
        bluetoothOnly = true;
        lines.push(text.test.appOnlyNoToy);
      } else {
        firstFailure = result;
        lines.push(text.test.appNotResponding(explainCode(result.code)));
      }
    } else {
      for (const toy of connected) {
        const result = await sessions.test(uid, { toyId: toy.id, source });
        const label = `${toyLabel(toy)}${toy.battery !== undefined ? ` · ${toy.battery}%` : ''}`;
        if (result.ok) {
          lines.push(text.test.responding(label));
        } else {
          firstFailure ??= result;
          lines.push(text.test.notResponding(label, explainCode(result.code), result.code));
        }
      }
    }

    for (const toy of link.toys.filter((t) => !isToyConnected(t))) {
      lines.push(text.test.disconnected(toyLabel(toy)));
    }

    const why = diagnose(presence.statusFor(link));
    if (why?.hint) lines.push(text.test.hint(why.hint));

    // A DM to whoever has to fix it, with the steps for this failure.
    const kind: DmKind | null = bluetoothOnly
      ? 'bluetooth'
      : firstFailure
        ? dmKindFor(firstFailure, why?.backgrounded ?? false)
        : null;
    if (kind && config.DM_ON_FAILED_TEST) {
      const delivered = await dm(interaction.client, target.userId, text.dm[kind]);
      lines.push(delivered ? text.test.dmSent(target.userId) : text.test.dmFailed(target.userId));
    }

    await interaction.editReply(
      [text.test.heading(self, target.name), ...lines, text.test.footer(lastSeen)].join('\n'),
    );
  },
};
