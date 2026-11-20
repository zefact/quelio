/**
 * ユーザー一覧の画面で使う、見た目に関わらない計算。
 *
 * 絞り込みと、権限の並べ方・まとめ方だけをここに置いて試験できるようにする
 */
import type {
  DbGrant,
  DbGrantScope,
  DbGrantSpec,
  DbGrantTarget,
  DbUser,
  DbUserRef,
} from "../../types";

/** 権限の範囲を、広いものから順に並べるための重み */
const SCOPE_ORDER: DbGrantScope[] = [
  "server",
  "database",
  "schema",
  "table",
  "column",
  "default",
];

/** 画面に出す範囲の名前 */
export const SCOPE_LABEL: Record<DbGrantScope, string> = {
  server: "サーバー全体",
  database: "データベース",
  schema: "スキーマ",
  table: "テーブル",
  column: "列",
  default: "今後作る物の既定",
};

/** 同じ対象への権限をひとまとめにしたもの */
export interface GrantGroup {
  scope: DbGrantScope;
  target: string;
  /** その対象に付いている権限の名前 (並べ替え済み) */
  privileges: string[];
  /** 他人に渡せる権限があるか */
  grantable: boolean;
}

/**
 * 権限を、範囲と対象でまとめる。
 *
 * 1行1権限のまま出すと、テーブル1つに8行並んで読めなくなる。
 * 対象ごとに1行へまとめ、権限の名前を横に並べる
 */
export function groupGrants(grants: DbGrant[]): GrantGroup[] {
  const map = new Map<string, GrantGroup>();
  for (const g of grants) {
    const id = `${g.scope} ${g.target}`;
    const found = map.get(id);
    if (found) {
      if (!found.privileges.includes(g.privilege)) {
        found.privileges.push(g.privilege);
      }
      found.grantable = found.grantable || g.grantable;
      continue;
    }
    map.set(id, {
      scope: g.scope,
      target: g.target,
      privileges: [g.privilege],
      grantable: g.grantable,
    });
  }
  const out = [...map.values()];
  for (const g of out) g.privileges.sort();
  out.sort((a, b) => {
    const d = SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope);
    return d !== 0 ? d : a.target.localeCompare(b.target);
  });
  return out;
}

/**
 * 一覧を絞り込む。
 *
 * 名前・接続元・所属ロール・印のどれかに当たれば残す。
 * `withSystem` が false のときは、サーバーが用意したものを外す
 * (ただし今接続しているユーザーは、どんなときでも残す)
 */
export function filterUsers(
  users: DbUser[],
  query: string,
  withSystem: boolean
): DbUser[] {
  const q = query.trim().toLowerCase();
  return users.filter((u) => {
    if (u.system && !withSystem && !u.isSelf) return false;
    if (!q) return true;
    return [u.name, u.host, ...u.memberOf, ...u.badges].some((v) =>
      v.toLowerCase().includes(q)
    );
  });
}

/** 一覧に出す1行の見出し (MySQLは接続元も付ける) */
export function userLabel(u: DbUser): string {
  return u.host ? `${u.name}@${u.host}` : u.name;
}

/** 画面から指定できる範囲 (列と既定は付け外しの対象にしない) */
export const EDITABLE_SCOPES: DbGrantTarget[] = [
  "server",
  "database",
  "schema",
  "table",
];

/**
 * 今ある権限を取り消すための指定に直す。
 *
 * 列単位と「今後作る物の既定」は、この画面では外せない (null を返す)。
 * どちらも対象の書き方が違い、取り違えると別の権限を消しかねない
 */
export function revokeSpec(
  group: GrantGroup,
  /** PostgreSQL か */
  pg = false
): DbGrantSpec | null {
  if (!EDITABLE_SCOPES.includes(group.scope as DbGrantTarget)) return null;
  /*
   * MySQL の USAGE は「権限が無い」という印で、外しても何も起きない。
   * ただし「他人に渡せる」印は権限を外しても残るので、
   * それが付いているあいだは外す先がある
   */
  if (onlyUsage(group, pg) && !group.grantable) return null;
  return {
    scope: group.scope as DbGrantTarget,
    // サーバー全体は対象を書かない (`*.*` は組み立て側で付ける)
    target: group.scope === "server" ? "" : group.target,
    privileges: group.privileges,
    /*
     * 外すときの `grantable` は「渡せるようにする」ではなく
     * 「渡せる印も外す」という意味で使う
     */
    grantable: group.grantable,
  };
}

/** MySQL の「権限が無い」印だけの行か */
function onlyUsage(group: GrantGroup, pg: boolean): boolean {
  return (
    !pg &&
    group.scope === "server" &&
    group.privileges.every((p) => p === "USAGE")
  );
}

/**
 * 取り消しの確認に出す断り書き。
 *
 * MySQLのサーバー全体は USAGE (権限が無い印) しか残らないので、
 * 「何が外れるのか」を言葉で分けて書く
 */
export function revokeNote(group: GrantGroup, pg = false): string {
  const tail = "データそのものは消えません";
  const mark = "「他人に渡せる」印";
  if (onlyUsage(group, pg)) {
    return `${mark}だけを外します。${tail}`;
  }
  const also = group.grantable ? ` (${mark}も外します)` : "";
  return `${privilegeSummary(group.privileges)} を外します${also}。${tail}`;
}

/**
 * 権限の名前を、断り書きに収まる長さでつなぐ。
 *
 * MySQL のサーバー全体は 60 個ほど付いていることがあり、
 * 全部並べると画面が名前で埋まる。
 * 数が多いときは頭の何個かと残りの件数にする
 * (中身は次の画面のSQLでそのまま見られる)
 */
export function privilegeSummary(privileges: string[], max = 6): string {
  if (privileges.length <= max) return privileges.join(" / ");
  const rest = privileges.length - max;
  return `${privileges.slice(0, max).join(" / ")} ほか${rest}件`;
}

/** そのユーザーを指す、やり取り用の値 */
export function userRef(u: DbUser): DbUserRef {
  return { name: u.name, host: u.host };
}

/**
 * 変えてよい相手か (変えられないなら、その理由)。
 *
 * サーバーが用意したものと、今接続している自分自身は変えさせない。
 * バックエンドでも同じことを確かめるが、
 * 押せないことが先に分かるほうが迷わない
 */
export function blockedReason(u: DbUser): string | null {
  if (u.isSelf) {
    return "今接続しているユーザー自身は変更できません";
  }
  if (u.system) {
    return "サーバーが用意したユーザーなので変更できません";
  }
  return null;
}

/** 権限のまとめ選び (SQL の権限名を知らなくても選べるように) */
export type GrantPreset = "read" | "write" | "all";

export const GRANT_PRESETS: { value: GrantPreset; label: string; hint: string }[] = [
  {
    value: "read",
    label: "読むだけ",
    hint: "行を読む権限と、入れ物 (データベース・スキーマ) に入る権限",
  },
  {
    value: "write",
    label: "読み書き",
    hint: "読むだけに加えて、行を足す・書き換える・消す権限",
  },
  { value: "all", label: "すべて", hint: "その範囲でできることを全部 (ALL PRIVILEGES)" },
];

/** 読むのに要る権限 (範囲によって無いものは使わない) */
const READ_PRIVS = ["SELECT", "SHOW VIEW", "CONNECT", "USAGE"];
/** 書くのに足す権限 */
const WRITE_PRIVS = ["INSERT", "UPDATE", "DELETE"];

/**
 * まとめ選びに当たる権限を、その範囲で選べるものの中から選ぶ。
 *
 * 「すべて」は ALL PRIVILEGES があればそれ1つにする
 * (1つずつ並べるより、流すSQLが短く読みやすい)
 */
export function presetPrivileges(preset: GrantPreset, available: string[]): string[] {
  if (preset === "all") {
    const all = available.find((p) => p.toUpperCase() === "ALL PRIVILEGES");
    return all ? [all] : [...available];
  }
  const want = preset === "read" ? READ_PRIVS : [...READ_PRIVS, ...WRITE_PRIVS];
  return available.filter((p) => want.includes(p.toUpperCase()));
}

/** 選んでいる権限が、どのまとめ選びと同じか (どれでもなければ null) */
export function matchPreset(picked: string[], available: string[]): GrantPreset | null {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((p) => b.includes(p));
  for (const p of GRANT_PRESETS) {
    const list = presetPrivileges(p.value, available);
    if (list.length > 0 && same(list, picked)) return p.value;
  }
  return null;
}
