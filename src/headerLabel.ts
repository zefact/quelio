/**
 * 結果グリッドのヘッダに出す文字の決め方。
 *
 * 英語名 (DBのカラム名) と日本語名 (コメントの論理名) のどちらを出すかは
 * 設定で選べる。画面とは関係のない文字の話なのでここに分けてある
 */
import type { HeaderLabelMode } from "./types";

/** ヘッダに出す文字 */
export interface HeaderText {
  /** 1段目 */
  main: string;
  /** 2段目 (1段だけのときは undefined) */
  sub?: string;
  /** 1段目が日本語名か (英語名向けの大文字化・字間を外すため) */
  mainJa: boolean;
}

/** 列幅の下限・上限 (px) */
const MIN_W = 90;
const MAX_W = 260;

/** 文字の幅の見積り (px)。半角と全角で1文字ぶんの幅が違う */
const HALF_W = 10;
const FULL_W = 13;

/** 文字の左右に取る余白 (px。並び替えの矢印や幅つまみのぶん) */
const PAD_W = 40;

/**
 * 英語名と日本語名から、ヘッダに出す文字を決める。
 *
 * 日本語名が無いカラム (コメント未設定、式や関数の結果) は、
 * どの設定でも英語名を出す。出す文字が無くなると
 * どの列なのか分からなくなってしまう
 */
export function headerText(
  name: string,
  logical: string | undefined,
  mode: HeaderLabelMode
): HeaderText {
  const ja = (logical ?? "").trim();
  if (!ja || mode === "name") return { main: name, mainJa: false };
  if (mode === "logical") return { main: ja, mainJa: true };
  return { main: name, sub: ja, mainJa: false };
}

/** その文字を出すのに要る幅 (px) */
function textWidth(s: string): number {
  let w = PAD_W;
  for (const ch of s) w += /[ -~]/.test(ch) ? HALF_W : FULL_W;
  return w;
}

/**
 * ヘッダの文字から決める列の初期幅 (px)。
 *
 * 2段のときは広いほうに合わせる。
 * 中身に合わせた幅はグリッドが描画後に測り直すので、ここは目安でよい
 */
export function headerWidth(...texts: (string | undefined)[]): number {
  const w = Math.max(0, ...texts.map((t) => textWidth(t ?? "")));
  return Math.min(MAX_W, Math.max(MIN_W, w));
}

/**
 * コピー・書き出しの見出しに使う名前。
 *
 * 「日本語名」を選んでいるときだけ日本語名にする。
 * 「両方」のときは画面にも英語名が出ているので、英語名のままにする
 */
export function exportName(
  name: string,
  logical: string | undefined,
  mode: HeaderLabelMode
): string {
  return mode === "logical" ? headerText(name, logical, mode).main : name;
}

/**
 * 表の見出しをまとめて作る。
 *
 * 変えるところが無ければ undefined を返す
 * (「元のままでよい」の合図。書き出しの指定を余計に送らずに済む)
 */
export function exportNames(
  names: string[],
  labels: Record<string, string>,
  mode: HeaderLabelMode
): string[] | undefined {
  if (mode !== "logical") return undefined;
  const out = names.map((n) => exportName(n, labels[n.toLowerCase()], mode));
  return out.some((v, i) => v !== names[i]) ? out : undefined;
}
