import { EmbedBuilder, SlashCommandBuilder, userMention } from 'discord.js';
import { toyLabel } from '../../lovense/toys';
import { focusLabel, getFocus, type Focus } from '../../session/focus';
import { sessions, type Session } from '../../session/manager';
import { isToyConnected, presence } from '../../session/presence';
import { store, type ToyLink } from '../../store/store';
import { text } from '../../text';
import { describeTease } from '../toy-option';
import type { BotCommand } from '../types';

/** One line per toy: battery, connection, and whether it is the focus. */
function toyLines(link: ToyLink, focus: Focus): string[] {
  const lines = link.toys.map((t) =>
    text.status.toyLine(
      toyLabel(t),
      t.battery,
      isToyConnected(t),
      focus.kind === 'toy' && focus.id === t.id,
    ),
  );
  return lines.length > 0 ? lines : [text.status.noToys];
}

function teaseText(session: Session | undefined): string {
  if (!session) return text.status.teaseOff;
  const by = session.startedBy === session.ownerId ? null : session.startedBy;
  return session.state === 'suspended'
    ? text.status.teasePaused(describeTease(session), session.armedAt, by)
    : text.status.teaseOn(describeTease(session), session.armedAt, by);
}

export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    // Controller only: hidden from, and refused to, anyone but admins.
    .setDefaultMemberPermissions(0)
    .setDescription(text.status.describe),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const links = store.listByGuild(interaction.guildId);

    if (links.length === 0) {
      await interaction.reply(text.status.noLinks);
      return;
    }

    const embed = new EmbedBuilder().setTitle(text.status.embedTitle).setColor(0x5865f2);

    for (const link of links) {
      const session = sessions.get(interaction.guildId, link.discordUserId);
      const status = presence.statusFor(link);
      const focus = getFocus(interaction.guildId, link.discordUserId);
      const noHeartbeats =
        status.presence === 'unknown' && presence.enabled && link.lastSeen
          ? text.status.noHeartbeats
          : '';

      const lines = [
        text.status[status.presence] + noHeartbeats,
        text.status.app(link.platform),
        link.lastSeen ? text.status.lastCheckIn(link.lastSeen) : text.status.neverCheckedIn,
        text.status.focus(focusLabel(focus, link)),
        ...toyLines(link, focus),
        teaseText(session),
      ];

      embed.addFields({
        name: link.displayName,
        value: [userMention(link.discordUserId), ...lines].join('\n'),
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
