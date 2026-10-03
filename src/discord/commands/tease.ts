import { MessageFlags, SlashCommandBuilder, channelMention } from 'discord.js';
import { config } from '../../config';
import { makeUid } from '../../lovense/client';
import { sessions } from '../../session/manager';
import { presence } from '../../session/presence';
import { toyLabel } from '../../lovense/toys';
import { store } from '../../store/store';
import {
  TOY_OPTION,
  TOY_OPTION_DESCRIPTION,
  names,
  respondWithToys,
  toysFromOption,
} from '../toy-option';
import { refuseIfStopped } from '../lockout';
import type { BotCommand } from '../types';

/**
 * Tease mode: every message from someone other than the toy's owner, in the
 * main channel, sends a short buzz. Persistent until `/off` or `/stop`.
 *
 * Either person may start it on either toy — consent is the toy being on and
 * worn, not a command. That is also why /off and /stop are never gated: what
 * this starts, the wearer can always end.
 *
 * Without `toy` it covers every connected toy; with it, just that one, so
 * two toys can tease at different strengths. Running it again for a toy
 * already teasing retunes the strength and length in place rather than
 * starting over.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('tease')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription('Tease mode: messages from anyone else in the main channel buzz the toy')
    .addUserOption((o) => o.setName('user').setDescription('Whose toy (defaults to yours)'))
    .addStringOption((o) =>
      o.setName(TOY_OPTION).setDescription(TOY_OPTION_DESCRIPTION).setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName('intensity')
        .setDescription(`Buzz strength %, default ${config.BUZZ_INTENSITY_PERCENT}`)
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addNumberOption((o) =>
      o
        .setName('duration')
        .setDescription(`Buzz length in seconds, default ${config.BUZZ_DURATION_SEC}`)
        .setMinValue(1)
        .setMaxValue(30),
    ),

  async autocomplete(interaction) {
    await respondWithToys(interaction, 'user');
  },

  async execute(interaction) {
    if (!interaction.guildId) return;
    if (await refuseIfStopped(interaction)) return;

    const target = interaction.options.getUser('user') ?? interaction.user;
    const self = target.id === interaction.user.id;
    const whose = self ? 'Your' : `${target.displayName}'s`;

    const link = store.getByUser(interaction.guildId, target.id);
    if (!link) {
      await interaction.reply({
        content: self
          ? 'You have not linked a toy yet. Run `/connect` first.'
          : `${target.displayName} has no toy linked in this server.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (link.lastSeen === null) {
      await interaction.reply({
        content:
          `${whose} QR code has not been scanned yet — the bot has not heard from the Lovense app. ` +
          'Scan the code from `/connect`, then try again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const status = presence.statusFor(link);

    if (status.presence === 'offline') {
      await interaction.reply({
        content:
          `${whose} toy is unreachable, so tease would do nothing.\n` +
          'Check that Lovense Remote is running, the phone has data, and the toy is connected over Bluetooth.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const toys = toysFromOption(interaction, link);
    if (!toys.ok) {
      await interaction.reply({
        content: `Cannot start tease: ${toys.error}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const intensity = interaction.options.getInteger('intensity') ?? undefined;
    const duration = interaction.options.getNumber('duration') ?? undefined;

    const { added, updated } = sessions.arm({
      uid: makeUid(interaction.guildId, target.id),
      guildId: interaction.guildId,
      ownerId: target.id,
      toys: toys.toys.map((t) => ({ id: t.id, name: toyLabel(t) })),
      startedBy: interaction.user.id,
      intensityPercent: intensity,
      durationSec: duration,
    });

    const heartbeatWarning =
      presence.enabled && !status.heartbeatsWorking && !status.lastResult?.ok
        ? '\n\n*Not confirmed reachable yet — the first probe or buzz will tell.*'
        : '';

    const reminder =
      config.TEASE_REMINDER_MINUTES > 0
        ? ` No auto-off; a reminder posts every ${config.TEASE_REMINDER_MINUTES} minutes.`
        : ' No auto-off.';

    const whoseToys = self ? 'your' : `${target.displayName}'s`;
    const changes = [
      ...added.map((t) => `**Tease on**: ${t.toyName} at ${t.intensityPercent}% for ${t.durationSec}s`),
      ...updated.map((t) => `**Tease updated**: ${t.toyName} now ${t.intensityPercent}% for ${t.durationSec}s`),
    ];

    await interaction.reply({
      content:
        `${changes.join('\n')}\n` +
        `Messages from anyone else in ${channelMention(config.MAIN_CHANNEL_ID)} buzz ${whoseToys} ` +
        `${names([...added, ...updated])}.\n` +
        `\`/off\` turns it off, \`/stop\` halts everything.${reminder}` +
        heartbeatWarning,
    });
  },
};
