import { EmbedBuilder, SlashCommandBuilder, time, userMention } from 'discord.js';
import { toyLabel } from '../../lovense/toys';
import { sessions, type Session, type ToyTease } from '../../session/manager';
import { isToyConnected, presence } from '../../session/presence';
import { store, type ToyLink } from '../../store/store';
import { describeTease } from '../toy-option';
import type { BotCommand } from '../types';

/** One line per toy: battery, connection, and its tease if any. */
function toyLines(link: ToyLink, session: Session | undefined): string[] {
  const paused = session?.state === 'suspended';
  const lines = link.toys.map((t) => {
    const battery = t.battery !== undefined ? ` ${t.battery}%` : '';
    const mark = isToyConnected(t) ? '' : ' — disconnected';
    const tease = session?.toys.get(t.id);
    return `• ${toyLabel(t)}${battery}${mark} — ${teaseText(tease, session, paused)}`;
  });

  // A toy still teasing that its app no longer lists (removed in the app).
  for (const tease of session?.toys.values() ?? []) {
    if (!link.toys.some((t) => t.id === tease.toyId)) {
      lines.push(`• ${tease.toyName} — not reported by the app — ${teaseText(tease, session, paused)}`);
    }
  }

  return lines.length > 0 ? lines : ['• none reported yet'];
}

function teaseText(tease: ToyTease | undefined, session: Session | undefined, paused: boolean): string {
  if (!tease || !session) return 'tease off';
  const by = tease.startedBy === session.ownerId ? '' : ` by ${userMention(tease.startedBy)}`;
  return (
    `${paused ? '**tease paused** (toy offline)' : '**tease on**'} at ${describeTease(tease)} · ` +
    `started ${time(Math.floor(tease.armedAt / 1000), 'R')}${by}`
  );
}

export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show linked toys and which have tease on'),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const links = store.listByGuild(interaction.guildId);

    if (links.length === 0) {
      await interaction.reply('No toys are linked in this server. Run `/connect` to link one.');
      return;
    }

    const embed = new EmbedBuilder().setTitle('Toy status').setColor(0x5865f2);

    for (const link of links) {
      const session = sessions.get(interaction.guildId, link.discordUserId);
      const status = presence.statusFor(link);

      const presenceLabel = {
        online: '🟢 Online',
        offline: '🔴 Offline',
        unknown: '⚪ Unknown',
      }[status.presence];

      const lines = [
        `${presenceLabel}${
          status.presence === 'unknown' && presence.enabled && link.lastSeen
            ? ' (no heartbeats — enable heartbeat in the Lovense dashboard)'
            : ''
        }`,
        `App: ${link.platform ?? 'unknown'}`,
        link.lastSeen
          ? `Last heartbeat: ${time(Math.floor(link.lastSeen / 1000), 'R')}`
          : 'Last heartbeat: never — QR not scanned yet',
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
