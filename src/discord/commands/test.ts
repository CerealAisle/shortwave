import { SlashCommandBuilder, time } from 'discord.js';
import { explainCode, makeUid } from '../../lovense/client';
import { isToyConnected, toyLabel } from '../../lovense/toys';
import { sessions } from '../../session/manager';
import { diagnose, presence } from '../../session/presence';
import { store } from '../../store/store';
import type { BotCommand } from '../types';

/**
 * Is it working? Sends Vibrate:0 — nothing moves — to each connected toy and
 * reports, in the channel it was run in, what Lovense said for each.
 *
 * Zero strength, so it is allowed during a /stop lockout and can never
 * surprise anyone. A success also counts as the command that ends an outage.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('test')
    .setDescription('Check whether toys are responding (nothing will move)')
    .addUserOption((o) =>
      o.setName('target').setDescription('Whose toys (defaults to yours)'),
    ),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const target = interaction.options.getUser('target') ?? interaction.user;
    const self = target.id === interaction.user.id;
    const link = store.getByUser(interaction.guildId, target.id);

    if (!link) {
      await interaction.reply(
        self
          ? 'You have no toy linked yet. Run `/connect` first.'
          : `${target.displayName} has no toy linked.`,
      );
      return;
    }
    if (link.lastSeen === null) {
      await interaction.reply(
        `${self ? 'Your' : `${target.displayName}'s`} QR code has not been scanned yet, ` +
          'so there is nothing to test. Scan the code from `/connect` first.',
      );
      return;
    }

    await interaction.deferReply();

    const uid = makeUid(interaction.guildId, target.id);
    const connected = link.toys.filter(isToyConnected);
    const lines: string[] = [];

    if (connected.length === 0) {
      // Nothing reports connected: test the app itself, so the answer still
      // says whether the phone is reachable.
      const result = await sessions.test(uid, { source: `test:${interaction.user.id}` });
      lines.push(
        result.ok
          ? '🟡 The Lovense app answered, but it reports no toy connected. Check Bluetooth.'
          : `🔴 Not responding — ${explainCode(result.code)}`,
      );
    } else {
      for (const toy of connected) {
        const result = await sessions.test(uid, {
          toyId: toy.id,
          source: `test:${interaction.user.id}`,
        });
        const battery = toy.battery !== undefined ? ` · ${toy.battery}%` : '';
        lines.push(
          result.ok
            ? `🟢 ${toyLabel(toy)}${battery} — responding`
            : `🔴 ${toyLabel(toy)}${battery} — not responding: ${explainCode(result.code)}` +
                (result.code !== undefined ? ` (${result.code})` : ''),
        );
      }
    }

    const disconnected = link.toys.filter((t) => !isToyConnected(t));
    for (const toy of disconnected) {
      lines.push(`⚫ ${toyLabel(toy)} — not connected to the app (Bluetooth)`);
    }

    const hint = diagnose(presence.statusFor(link))?.hint;
    const checkedIn = time(Math.floor(link.lastSeen / 1000), 'R');

    await interaction.editReply(
      `**Test: ${self ? 'your' : `${target.displayName}'s`} toys**\n` +
        lines.join('\n') +
        (hint ? `\n⚠️ ${hint[0]!.toUpperCase()}${hint.slice(1)}.` : '') +
        `\n-# Nothing moved: the test sends a 0% command. App last checked in ${checkedIn}.`,
    );
  },
};
