import { SlashCommandBuilder } from 'discord.js';
import { config } from '../../config';
import { explainCode, makeUid } from '../../lovense/client';
import { socketMonitor } from '../../lovense/socket';
import { isToyConnected, toyLabel } from '../../lovense/toys';
import { sessions, type TestResult } from '../../session/manager';
import { diagnose, presence } from '../../session/presence';
import { text, type FixStepsKind } from '../../text';
import { post } from '../notify';
import { store } from '../../store/store';
import { requireTarget } from '../target';
import type { BotCommand } from '../types';

/**
 * Which fix-it steps a failed test calls for, or null when there is nothing
 * she can do (a bad developer token, a bot bug).
 */
export function fixStepsFor(
  result: TestResult,
  backgrounded: boolean,
  /** The app used to check in and has stopped. */
  silent = false,
): Exclude<FixStepsKind, 'bluetooth'> | null {
  if (result.ok) return null;
  switch (result.code) {
    case 507:
      if (backgrounded) return 'backgrounded';
      return silent ? 'notCheckingIn' : 'appClosed';
    case 503:
      return 'unlinked';
    case undefined:
      return 'network';
    default:
      return null;
  }
}

/**
 * Is it working? Sends Vibrate:0 — nothing moves — to each of her connected
 * toys (all of them, whatever the focus) and reports, in the channel it was
 * run in, what Lovense said for each. Always tests her, whoever runs it.
 *
 * Zero strength, so it is allowed during a /stop lockout and can never
 * surprise anyone. A success also counts as the command that ends an outage.
 * It does replace whatever is running, though, so while a buzz or pattern is
 * still going it sends nothing and says so instead.
 *
 * When it fails for a reason she can fix, the steps are posted in the shared
 * channel with an @mention. The bot sends no DMs.
 */
export const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('test')
    .setDescription(text.test.describe),

  async execute(interaction) {
    if (!interaction.guildId) return;

    const target = await requireTarget(interaction, { scanned: true });
    if (!target) return;
    const { link, self } = target;
    const lastSeen = link.lastSeen!;

    const uid = makeUid(interaction.guildId, target.userId);
    const runningUntil = sessions.busyUntil(uid);
    if (runningUntil > Date.now()) {
      const last = presence.lastResult(uid);
      await interaction.reply({
        content: [text.test.busy(runningUntil), ...(last?.ok ? [text.test.busyLastOk(last.at)] : [])].join('\n'),
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply();

    const source = `test:${interaction.user.id}`;
    const connected = link.toys.filter(isToyConnected);
    const lines: string[] = [];
    let firstFailure: TestResult | null = null;
    let bluetoothOnly = false;

    if (connected.length === 0) {
      // Nothing reports connected: test the app itself, so the answer still
      // says whether the phone is reachable.
      const result = await sessions.test(uid, { source });
      if (result.ok) {
        bluetoothOnly = true;
        lines.push(text.test.appOnlyNoToy);
      } else {
        firstFailure = result;
        lines.push(text.test.appNotResponding(explainCode(result.code)));
      }
    } else {
      for (const toy of connected) {
        const result = await sessions.test(uid, { toyId: toy.id, source });
        const label = `${toyLabel(toy)}${toy.battery !== undefined ? ` · ${toy.battery}%` : ''}`;
        if (result.ok) {
          lines.push(text.test.responding(label));
        } else {
          firstFailure ??= result;
          lines.push(text.test.notResponding(label, explainCode(result.code), result.code));
        }
      }
    }

    for (const toy of link.toys.filter((t) => !isToyConnected(t))) {
      lines.push(text.test.disconnected(toyLabel(toy)));
    }

    const status = presence.statusFor(store.getByUid(uid) ?? link);
    const why = diagnose(status);
    if (why?.hint) lines.push(text.test.hint(why.hint));
    if (status.checkInsStopped && !why?.silent && status.lastSeen !== null) {
      lines.push(text.test.checkInsStopped(status.lastSeen));
    }

    const socketLine = socketMonitor.describe(uid);
    const report = [
      text.test.heading(self, target.name),
      ...lines,
      text.test.footer(lastSeen),
      ...(socketLine ? [text.test.socket(socketLine)] : []),
    ];

    // The steps for this failure go to the shared channel, @-ing her: in this
    // reply if /test was run there, otherwise as a post of their own.
    const kind: FixStepsKind | null = bluetoothOnly
      ? 'bluetooth'
      : firstFailure
        ? fixStepsFor(firstFailure, why?.backgrounded ?? false, status.checkInsStopped)
        : null;
    const steps = kind ? text.fixSteps[kind](target.userId) : null;
    const mainId = config.MAIN_CHANNEL_ID;

    if (steps && interaction.channelId === mainId) {
      await interaction.editReply({
        content: `${report.join('\n')}\n\n${steps}`,
        allowedMentions: { users: [target.userId] },
      });
      return;
    }

    if (steps) {
      const posted = await post(interaction.client, mainId, steps, { mention: [target.userId] });
      report.push(posted ? text.test.fixStepsPosted(target.userId, mainId) : text.test.fixStepsFailed(mainId));
    }
    await interaction.editReply({ content: report.join('\n'), allowedMentions: { parse: [] } });
  },
};
