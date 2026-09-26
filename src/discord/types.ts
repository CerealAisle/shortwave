import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

export type CommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

/**
 * Every slash command is a file in ./commands exporting one of these.
 * The registry picks them up automatically — adding a command means adding
 * a file and re-running `npm run deploy-commands`.
 */
export interface BotCommand {
  data: CommandData;
  /** Only the person who linked a toy may run it (checked before execute). */
  ownerOnly?: boolean;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
