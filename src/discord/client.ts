import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
} from 'discord.js';
import { config } from '../config';
import { log } from '../logger';
import { loadCommands } from './registry';
import { registerMessageTrigger } from './events/message-create';

export function createClient(): Client {
  const client = new Client({
    // Deliberately no MessageContent intent: the bot reacts to the fact that
    // a message was sent, never to what it says. That keeps this off the
    // privileged-intent list entirely. If you later add keyword triggers,
    // add GatewayIntentBits.MessageContent here and enable it in the
    // Discord developer portal.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  const commands = loadCommands();

  client.once(Events.ClientReady, (c) => {
    log.info(`Logged in as ${c.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.guildId !== config.DISCORD_GUILD_ID) {
      await interaction.reply({
        content: 'This bot only works in its configured server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const command = commands.get(interaction.commandName);
    if (!command) {
      log.warn(`Unknown command: ${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      log.error(`/${interaction.commandName} threw: ${(err as Error).message}`);
      const content = 'Something went wrong running that command.';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  registerMessageTrigger(client);

  return client;
}
