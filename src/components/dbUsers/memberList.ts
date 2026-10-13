/**
 * ロールのメンバーまわりの計算 (画面から切り離して試験できるようにする)
 */
import type { DbUser } from "../../types";

/** そのロールに属しているユーザー */
export function roleMembers(role: DbUser, users: DbUser[]): DbUser[] {
  return users.filter((u) => u.key !== role.key && u.memberOf.includes(role.name));
}

/**
 * そのロールに足せるユーザー。
 *
 * まだ属していないもの。サーバーが用意したものは出さないが、
 * 今つないでいるユーザー自身は出す (自分を足す使い方があるため)。
 * 自分自身を一番上に置く
 */
export function memberCandidates(role: DbUser, users: DbUser[]): DbUser[] {
  const list = users.filter(
    (u) =>
      u.key !== role.key &&
      !u.memberOf.includes(role.name) &&
      (u.isSelf || !u.system)
  );
  return [...list.filter((u) => u.isSelf), ...list.filter((u) => !u.isSelf)];
}
