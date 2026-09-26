import { REST, Routes } from 'discord.js';
import { config } from '../config';
import { log } from '../logger';
import { loadCommands } from './registry';

/**
 * Registers slash commands against the single private guild. Guild commands
 * update instantly, unlike global ones which can take up to an hour.
 *
 * Run this after adding or changing a command:  npm run deploy-commands
 */
async function main() {
  const commands = [...loadCommands().values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
    { body: commands },
  );

  log.info(`Registered ${commands.length} commands to guild ${config.DISCORD_GUILD_ID}`);
}

main().catch((err) => {
  log.error(`Command deployment failed: ${(err as Error).message}`);
  process.exit(1);
});
