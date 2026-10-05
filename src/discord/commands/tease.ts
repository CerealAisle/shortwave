import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { config } from '../../config';
import * as actions from '../../lovense/actions';
import { makeUid } from '../../lovense/client';
import { focusLabel, focusTargets, getFocus } from '../../session/focus';
import { sessions } from '../../session/manager';
import { presence } from '../../session/presence';
import { text } from '../../text';
import { refuseIfStopped } from '../lockout';
import { requireTarget } from '../target';
import type { BotCommand } from '../types';

/**
 * Tease mode: every message from someone other than her, in the main
 * channel, buzzes her focused toys — decided at each message, so with focus
 * on all, any toy connected at that moment. Persistent until turned off or
 * /stop. Running it again while on changes the strength or length in place.
 *
 * `off:True` turns it off instead. That path is never refused by a /stop
 * lockout (it only ever stops things), and it always sends a Stop, so it
 * also ends a buzz or pattern in progress.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('tease')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.tease.describe)
    .addIntegerOption((o) =>
      o
        .setName('intensity')
        .setDescription(text.tease.describeIntensity(config.BUZZ_INTENSITY_PERCENT))
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addNumberOption((o) =>
      o
        .setName('duration')
        .setDescription(text.tease.describeDuration(config.BUZZ_DURATION_SEC))
        .setMinValue(1)
        .setMaxValue(30),
    )
    .addBooleanOption((o) => o.setName('off').setDescription(text.tease.describeOff)),

  async execute(interaction) {
    if (!interaction.guildId) return;
    const guildId = interaction.guildId;

    const target = await requireTarget(interaction);
    if (!target) return;
    const uid = makeUid(guildId, target.userId);

    // --- off ---
    if (interaction.options.getBoolean('off')) {
      // disarm() sends a Stop to every toy.
      const session = sessions.disarm(guildId, target.userId);
      if (!session) {
        // Nothing was teasing, but a /buzz or /pattern may be. Stop it anyway.
        void sessions.sendNow(uid, actions.stop(), 'tease-off').catch(() => {});
        await interaction.reply(text.tease.wasNotOn(target.name));
        return;
      }
      const minutes = Math.max(1, Math.round((Date.now() - session.armedAt) / 60_000));
      await interaction.reply(
        text.tease.turnedOff(target.name, session.triggerCount, session.missedCount, minutes),
      );
      return;
    }

    // --- on ---
    if (await refuseIfStopped(interaction)) return;

    if (target.link.lastSeen === null) {
      await interaction.reply({
        content: text.common.notScanned(target.self, target.name),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const status = presence.statusFor(target.link);
    if (status.presence === 'offline') {
      await interaction.reply({
        content: text.tease.unreachable(target.name),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const { session, created } = sessions.arm({
      uid,
      guildId,
      ownerId: target.userId,
      startedBy: interaction.user.id,
      intensityPercent: interaction.options.getInteger('intensity') ?? undefined,
      durationSec: interaction.options.getNumber('duration') ?? undefined,
    });

    const focus = getFocus(guildId, target.userId);
    const label = focusLabel(focus, target.link);
    const reachable = focusTargets(target.link, focus);

    const reply = created
      ? text.tease.started(target.name, session.intensityPercent, session.durationSec, label, config.MAIN_CHANNEL_ID)
      : text.tease.retuned(target.name, session.intensityPercent, session.durationSec, label);
    const problem = reachable.ok ? '' : text.tease.focusProblem(reachable.error);
    const notConfirmed =
      presence.enabled && !status.heartbeatsWorking && !status.lastResult?.ok
        ? text.tease.notConfirmed
        : '';

    await interaction.reply(reply + problem + notConfirmed);
  },
};
