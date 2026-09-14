/**
 * 並びの中で1つだけ場所を移す。
 *
 * タブの並べ替えは、DB・ER図・CSVのどの画面でも同じ動きをする。
 * 配列を作り直すだけの話なので、画面から切り離してここに置く
 */

/**
 * from 番目を抜いて、to 番目へ差し込んだ新しい配列を返す。
 *
 * 動かす必要がないとき (同じ位置・範囲の外) は、元の配列をそのまま返す。
 * 参照が変わらないので、受け取った側は描き直さずに済む
 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to) return list;
  if (from < 0 || from >= list.length) return list;
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  return next;
}
