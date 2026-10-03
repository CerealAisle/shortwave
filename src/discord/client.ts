import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
} from 'discord.js';
import { config } from '../config';
import { log } from '../logger';
import { text } from '../text';
import { channelRole } from './channels';
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
    if (interaction.isAutocomplete()) {
      // Suggestions only. Nothing runs, so the channel check waits for the
      // real command; an empty list is the quiet answer elsewhere.
      const command = commands.get(interaction.commandName);
      if (interaction.guildId !== config.DISCORD_GUILD_ID || !command?.autocomplete) {
        await interaction.respond([]).catch(() => {});
        return;
      }
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        log.warn(`/${interaction.commandName} autocomplete threw: ${(err as Error).message}`);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.guildId !== config.DISCORD_GUILD_ID) {
      await interaction.reply({
        content: text.common.wrongServer,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!channelRole(interaction.channelId)) {
      await interaction.reply({
        content: text.common.wrongChannel,
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
      const content = text.common.somethingWentWrong;
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
