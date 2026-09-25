/**
 * お気に入りの保存・編集ダイアログで使う判断と文言。
 *
 * ダイアログは「名前・フォルダ・中身 (SQL)」を1画面で直せる。
 * どれも画面に触れない判断なので、ここに置いてそのまま試す
 */
import { parentOf } from "./savedTree";

/**
 * 新しく作るフォルダのパス (選んでいるフォルダの中に作る)。
 * 名前が空なら、選んでいるフォルダのまま
 */
export function newFolderPath(parent: string, name: string): string {
  const n = name.trim();
  if (!n) return parent;
  return parent ? `${parent}/${n}` : n;
}

/**
 * 新しいフォルダ名の誤り (問題なければ null)。
 *
 * 空のうちは誤りにしない (打ち始める前から赤く出さない)。
 * 「/」は階層の区切りなので名前には使えない
 */
export function folderNameError(name: string): string | null {
  if (name.includes("/")) return "フォルダ名に「/」は使えません";
  return null;
}

/** フォルダの選択肢に出す文字 (階層の区切りを読みやすくする) */
export function folderLabel(path: string): string {
  return path ? path.split("/").join(" / ") : "(フォルダなし)";
}

/**
 * パスを階層ごとに比べる (親のすぐ後ろに子が来る並びにする)。
 *
 * 文字列のまま比べると、「集計 A」のように区切りより先に並ぶ文字を含む
 * フォルダが、「集計」と「集計/月次」の間に割り込んでしまう
 */
function comparePath(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = x[i].localeCompare(y[i], "ja", { numeric: true });
    if (c !== 0) return c;
  }
  return x.length - y.length;
}

/**
 * フォルダの選択肢 (階層順に並べる)。
 *
 * 保存側の並びは作った順なので、親の直後に子が来るとは限らない。
 * 選ぶときは階層で探すので、階層ごとに名前の順へ並べ直す
 */
export function folderOptions(
  folders: string[]
): { value: string; label: string }[] {
  const sorted = [...folders].sort(comparePath);
  return [
    { value: "", label: folderLabel("") },
    ...sorted.map((f) => ({ value: f, label: folderLabel(f) })),
  ];
}

/** 更新日時 (YYYY/MM/DD HH:mm)。記録が無ければ空 */
export function fmtUpdated(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/**
 * 「エディタの内容を取り込む」を押せるか。
 * エディタが空のときと、いま入っている中身と同じときは押しても変わらない
 */
export function canImport(editorSql: string, draft: string): boolean {
  return editorSql.trim() !== "" && editorSql !== draft;
}

/** 保存したあと、その項目が見えるように開いておくフォルダ (祖先を含む) */
export function foldersToOpen(folder: string): string[] {
  const out: string[] = [];
  for (let p = folder; p; p = parentOf(p)) out.unshift(p);
  return out;
}

/** 新しく作るフォルダが、既にあるフォルダと同じ名前か */
export function folderExists(folders: string[], path: string): boolean {
  return folders.includes(path);
}
