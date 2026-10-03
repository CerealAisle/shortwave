import { EmbedBuilder, SlashCommandBuilder, userMention } from 'discord.js';
import { toyLabel } from '../../lovense/toys';
import { sessions, type Session, type ToyTease } from '../../session/manager';
import { isToyConnected, presence } from '../../session/presence';
import { store, type ToyLink } from '../../store/store';
import { text } from '../../text';
import { describeTease } from '../toy-option';
import type { BotCommand } from '../types';

/** One line per toy: battery, connection, and its tease if any. */
function toyLines(link: ToyLink, session: Session | undefined): string[] {
  const lines = link.toys.map((t) =>
    text.status.toyLine(toyLabel(t), t.battery, isToyConnected(t), teaseText(session?.toys.get(t.id), session)),
  );

  // A toy still teasing that its app no longer lists (removed in the app).
  for (const tease of session?.toys.values() ?? []) {
    if (!link.toys.some((t) => t.id === tease.toyId)) {
      lines.push(text.status.toyGone(tease.toyName, teaseText(tease, session)));
    }
  }

  return lines.length > 0 ? lines : [text.status.noToys];
}

function teaseText(tease: ToyTease | undefined, session: Session | undefined): string {
  if (!tease || !session) return text.status.teaseOff;
  const by = tease.startedBy === session.ownerId ? null : tease.startedBy;
  return session.state === 'suspended'
    ? text.status.teasePaused(describeTease(tease), tease.armedAt, by)
    : text.status.teaseOn(describeTease(tease), tease.armedAt, by);
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
      const noHeartbeats =
        status.presence === 'unknown' && presence.enabled && link.lastSeen
          ? text.status.noHeartbeats
          : '';

      const lines = [
        text.status[status.presence] + noHeartbeats,
        text.status.app(link.platform),
        link.lastSeen ? text.status.lastCheckIn(link.lastSeen) : text.status.neverCheckedIn,
        ...toyLines(link, session),
      ];

      embed.addFields({
        name: link.displayName,
        value: [userMention(link.discordUserId), ...lines].join('\n'),
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
