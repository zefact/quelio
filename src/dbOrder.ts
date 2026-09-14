/**
 * データベースの選択に出す並び。
 *
 * 使うのはたいてい自分たちで作ったDBなので、そちらを先に出す。
 * サーバーが自分のために持っているDB (information_schema など) は
 * 後ろへ回し、間に区切りを入れて見分けられるようにする
 */

/** 選択に出す1件 */
export interface DbOption {
  value: string;
  label: string;
  /** この項目の上に区切り線を引く */
  separator?: boolean;
}

/** サーバーが用意したDBか (大小は問わない) */
function isSystem(name: string, system: Set<string>): boolean {
  return system.has(name.toLowerCase());
}

/**
 * 選択の中身を作る。
 *
 * それぞれのかたまりの中では、受け取った並びをそのまま保つ
 * (サーバーが返した順を勝手に変えない)
 */
export function databaseOptions(all: string[], system: string[]): DbOption[] {
  const sys = new Set(system.map((s) => s.toLowerCase()));
  const mine = all.filter((d) => !isSystem(d, sys));
  const theirs = all.filter((d) => isSystem(d, sys));
  return [
    ...mine.map((d) => ({ value: d, label: d })),
    ...theirs.map((d, i) => ({
      value: d,
      label: d,
      // 先頭にだけ区切りを付ける (ユーザーのDBが1つも無ければ引かない)
      separator: i === 0 && mine.length > 0,
    })),
  ];
}
