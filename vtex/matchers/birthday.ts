import { type MatchContext } from "@deco/deco/blocks";

/**
 * @title {{{match}}}
 */
export interface Props {
  /**
   * @title Match mode
   * @description "day" matches exact birthday, "week" matches the calendar week (Sun-Sat) containing the birthday, "month" matches entire birth month
   * @default day
   */
  match?: "day" | "month" | "week";
}

/**
 * @title Birthday
 * @description Target users based on their birth date
 * @icon calendar-event
 */
const MatchBirthday = (_props: Props, _ctx: MatchContext): boolean => {
  // TODO: re-enable using ctx.invoke once VTEX user loader exposes birthDate
  return false;
};

export default MatchBirthday;
