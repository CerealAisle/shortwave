import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type User } from 'discord.js';
import { config } from '../../config';
import * as actions from '../../lovense/actions';
import { makeUid } from '../../lovense/client';
import { resolveToys, toyLabel } from '../../lovense/toys';
import { sessions } from '../../session/manager';
import { presence } from '../../session/presence';
import { store, type ToyLink } from '../../store/store';
import { text } from '../../text';
import { refuseIfStopped } from '../lockout';
import {
  TOY_OPTION,
  TOY_OPTION_DESCRIPTION,
  names,
  respondWithToys,
  toysFromOption,
} from '../toy-option';
import type { BotCommand } from '../types';

/**
 * Tease mode: every message from someone other than the toy's owner, in the
 * main channel, sends a short buzz. Persistent until turned off or /stop.
 *
 * Without `toy` it covers every connected toy; with it, just that one, so
 * two toys can tease at different strengths. Running it again for a toy
 * already teasing retunes the strength and length in place.
 *
 * `off:True` turns it off instead — for the user, or just the toy given.
 * That path is never refused by a /stop lockout (it only ever stops things),
 * and it always sends a Stop, so it also ends a buzz or pattern in progress.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('tease')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.tease.describe)
    .addUserOption((o) => o.setName('user').setDescription(text.tease.describeUser))
    .addStringOption((o) =>
      o.setName(TOY_OPTION).setDescription(TOY_OPTION_DESCRIPTION).setAutocomplete(true),
    )
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

  async autocomplete(interaction) {
    await respondWithToys(interaction, 'user');
  },

  async execute(interaction) {
    if (!interaction.guildId) return;

    const target = interaction.options.getUser('user') ?? interaction.user;
    const self = target.id === interaction.user.id;
    const link = store.getByUser(interaction.guildId, target.id);

    if (!link) {
      await interaction.reply({
        content: text.common.noToy(self, target.displayName),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.options.getBoolean('off')) {
      await turnOff(interaction, target, self, link);
      return;
    }

    if (await refuseIfStopped(interaction)) return;

    if (link.lastSeen === null) {
      await interaction.reply({
        content: text.common.notScanned(self, target.displayName),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const status = presence.statusFor(link);
    if (status.presence === 'offline') {
      await interaction.reply({
        content: text.tease.unreachable(self, target.displayName),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const toys = toysFromOption(interaction, link);
    if (!toys.ok) {
      await interaction.reply({
        content: text.tease.badToy(toys.error),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const { added, updated } = sessions.arm({
      uid: makeUid(interaction.guildId, target.id),
      guildId: interaction.guildId,
      ownerId: target.id,
      toys: toys.toys.map((t) => ({ id: t.id, name: toyLabel(t) })),
      startedBy: interaction.user.id,
      intensityPercent: interaction.options.getInteger('intensity') ?? undefined,
      durationSec: interaction.options.getNumber('duration') ?? undefined,
    });

    const lines = [
      ...added.map((t) => text.tease.started(t.toyName, t.intensityPercent, t.durationSec)),
      ...updated.map((t) => text.tease.retuned(t.toyName, t.intensityPercent, t.durationSec)),
      text.tease.explainer(self, target.displayName, names([...added, ...updated]), config.MAIN_CHANNEL_ID),
    ];
    const notConfirmed =
      presence.enabled && !status.heartbeatsWorking && !status.lastResult?.ok
        ? text.tease.notConfirmed
        : '';

    await interaction.reply({ content: lines.join('\n') + notConfirmed });
  },
};

async function turnOff(
  interaction: ChatInputCommandInteraction,
  target: User,
  self: boolean,
  link: ToyLink,
): Promise<void> {
  const guildId = interaction.guildId!;
  const query = interaction.options.getString(TOY_OPTION);

  let toyIds: string[] | undefined;
  if (query) {
    const resolved = resolveToys(link.toys, query);
    if (!resolved.ok) {
      await interaction.reply({
        content: text.tease.badToyOff(resolved.error),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    toyIds = resolved.toys.map((t) => t.id);
  }

  // disarm() sends a Stop for every toy it turns off.
  const result = sessions.disarm(guildId, target.id, { toyIds });

  if (!result || result.removed.length === 0) {
    // Nothing was teasing, but a /buzz or /pattern may be. Stop it anyway.
    const uid = makeUid(guildId, target.id);
    for (const toyId of toyIds ?? [undefined]) {
      void sessions.sendNow(uid, actions.stop(), 'tease-off', { toyId }).catch(() => {});
    }
    await interaction.reply(text.tease.wasNotOn(self, target.displayName));
    return;
  }

  const { session, removed, ended } = result;
  const buzzes = removed.reduce((n, t) => n + t.triggerCount, 0);
  const missed = removed.reduce((n, t) => n + t.missedCount, 0);
  const minutes = Math.max(
    1,
    Math.round((Date.now() - Math.min(...removed.map((t) => t.armedAt))) / 60_000),
  );

  await interaction.reply(
    text.tease.turnedOff(names(removed), buzzes, missed, minutes) +
      (ended ? '' : text.tease.stillOn(names([...session.toys.values()]))),
  );
}
