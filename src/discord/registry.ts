import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../logger';
import type { BotCommand } from './types';

/**
 * Loads every command module in ./commands. Files are compiled to .js, so
 * that's what we look for at runtime.
 */
export function loadCommands(): Map<string, BotCommand> {
  const dir = join(__dirname, 'commands');
  const commands = new Map<string, BotCommand>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;

    const mod = require(join(dir, file));
    const command: BotCommand | undefined = mod.command ?? mod.default;

    if (!command?.data || typeof command.execute !== 'function') {
      log.warn(`Skipping ${file}: no valid command export`);
      continue;
    }

    commands.set(command.data.name, command);
    log.debug(`Loaded command /${command.data.name}`);
  }

  log.info(`Loaded ${commands.size} commands`);
  return commands;
}
