export type ConversationStatus =
  | "needs_reply"
  | "awaiting_them"
  | "numbers_on_table"
  | "confirmed"
  | "parked";

export type StatusInputs = {
  /** Both sides have agreed to a booking in principle. */
  isAgreed: boolean;
  /** Under about $1,000, a door split, or a rental. */
  isSmall: boolean;
  /** A live figure named by either side, if there is one. */
  feeAmount: number | null;
  /** Who wrote last. */
  lastDirection: "inbound" | "outbound" | null;
};

/** Anything at or below this is small enough that Jayme does not want it in
 * his eyeline -- his own examples were Awendaw Green ($100-250), Trinity
 * Alps (door split only) and Springfield JCC ($300-500). */
export const SMALL_DEAL_CEILING = 1000;

/** Resolves one conversation's stage.
 *
 * The precedence is the opinionated part, so the reasoning is written down
 * rather than left in the ordering:
 *
 * - `confirmed` outranks `parked`. A small deal that has actually been
 *   agreed still needs a contract sent, and hiding an agreed booking
 *   because of its size would lose a commitment already made. Size
 *   determines what is worth *chasing*, not what is worth *honouring*.
 * - `parked` outranks the money and direction states, which is the whole
 *   point of it: "if this whole thing gets too long, it becomes just like
 *   my inbox."
 * - A named figure outranks who wrote last, because the figure is the more
 *   useful thing to see first. Who is waiting on whom is not lost -- it
 *   stays available as last_direction, so a "needs reply" view can still
 *   include a thread sitting at numbers_on_table.
 */
export function computeStatus(input: StatusInputs): ConversationStatus {
  if (input.isAgreed) return "confirmed";
  if (input.isSmall || (input.feeAmount !== null && input.feeAmount <= SMALL_DEAL_CEILING)) return "parked";
  if (input.feeAmount !== null) return "numbers_on_table";
  return input.lastDirection === "outbound" ? "awaiting_them" : "needs_reply";
}

/** Days of silence after which a conversation with no money attached drops
 * off the board. Measured against the live corpus when chosen: only 2 of
 * 333 threads were past it, so it is a rule for three months' time rather
 * than a cull of what is there now. */
export const STALE_AFTER_DAYS = 30;

/** Whether a conversation still belongs on the board.
 *
 * A thread with a number on it never goes stale regardless of age -- those
 * are worth money and a quiet month does not change that. Everything else
 * leaves after 30 days of silence in both directions. Jayme asked for no
 * "dead" column at all, so this is expressed as dropping off rather than
 * as a status someone has to look at and dismiss.
 */
export function computeIsLive(args: {
  lastMessageAt: string | null;
  feeAmount: number | null;
  isAgreed: boolean;
  now?: Date;
}): boolean {
  if (args.isAgreed) return true;
  if (args.feeAmount !== null) return true;
  if (!args.lastMessageAt) return false;
  const now = args.now ?? new Date();
  const ageDays = (now.getTime() - new Date(args.lastMessageAt).getTime()) / 86_400_000;
  return ageDays <= STALE_AFTER_DAYS;
}
