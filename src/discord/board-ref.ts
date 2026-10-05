import type { StatusBoard } from './status-board';

/**
 * The running status board. index.ts creates it (it needs the store, presence
 * and sessions wired together); /status reaches it through here.
 */
let current: StatusBoard | null = null;

export function setBoard(board: StatusBoard): void {
  current = board;
}

export function getBoard(): StatusBoard | null {
  return current;
}
