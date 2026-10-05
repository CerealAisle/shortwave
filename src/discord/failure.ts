import { LovenseError, explainCode } from '../lovense/client';
import { StopLockoutError } from '../session/manager';
import { text } from '../text';

/** The reply for a command whose send to a toy failed. */
export function failureText(err: unknown): string {
  if (err instanceof StopLockoutError) return text.common.stopped(err.lockout.by, err.lockout.until);
  if (err instanceof LovenseError) return text.common.commandFailed(explainCode(err.code), err.code);
  return text.common.somethingWentWrong;
}
