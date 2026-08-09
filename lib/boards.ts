/** Server-facing board helpers. Do not import from client components — use boardMeta on ProjectSpec + board-types. */

export {
  BOARD_PROFILES,
  boardProfile,
  boardsCatalogForPrompt,
  ensureBoardCard,
  getBoardCard,
  listBoardCards,
  resolveBoardCard,
  resolveBoardId,
  toBoardProfile,
  type BoardCard,
  type BoardId,
  type BoardProfile,
} from "./board-registry.ts";

export {
  isPowerOrGroundPin,
} from "./board-types.ts";

import { boardProfile } from "./board-registry.ts";
import {
  boardPinCompatible as pinCompatible,
  isBoardSignalPin as signalPin,
  normalizeBoardPinForBoard as normalizePin,
  type BoardId,
} from "./board-types.ts";

export function normalizeBoardPinForBoard(board: BoardId, pin: unknown) {
  return normalizePin(boardProfile(board), pin);
}

export function boardPinCompatible(board: BoardId, allowed: readonly string[], boardPin: string) {
  return pinCompatible(boardProfile(board), allowed, boardPin);
}

export function isBoardSignalPin(board: BoardId, pin: string) {
  return signalPin(boardProfile(board), pin);
}
