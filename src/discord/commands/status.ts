import { EmbedBuilder, SlashCommandBuilder, time, userMention } from 'discord.js';
import { sessions } from '../../session/manager';
import { isToyConnected, presence } from '../../session/presence';
import { store } from '../../store/store';
import type { BotCommand } from '../types';

function sessionLine(session: ReturnType<typeof sessions.get>): string {
  if (!session) return 'Disarmed';

  const label = session.state === 'suspended' ? '**Paused** (toy offline)' : '**Armed**';
  const missed = session.missedCount > 0 ? ` · ${session.missedCount} missed` : '';

  return (
    `${label} at ${session.intensityPercent}% / ${session.durationSec}s · ` +
    `${session.triggerCount} buzz(es)${missed} · ` +
    `auto-off ${time(Math.floor(session.expiresAt / 1000), 'R')}`
  );
}

export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show linked toys and which sessions are armed'),

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

      const toyNames =
        link.toys.length > 0
          ? link.toys
              .map((t) => {
                const battery = t.battery !== undefined ? ` ${t.battery}%` : '';
                const mark = isToyConnected(t) ? '' : ' — disconnected';
                return `${t.nickName || t.name}${battery}${mark}`;
              })
              .join(', ')
          : 'none reported yet';

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
        `Toys: ${toyNames}`,
        `App: ${link.platform ?? 'unknown'}`,
        link.lastSeen
          ? `Last heartbeat: ${time(Math.floor(link.lastSeen / 1000), 'R')}`
          : 'Last heartbeat: never — QR not scanned yet',
        sessionLine(session),
      ];

      embed.addFields({
        name: link.displayName,
        value: [userMention(link.discordUserId), ...lines].join('\n'),
      });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
