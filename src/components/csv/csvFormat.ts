import type { CsvFormat } from "../../types";
import { fixedLabel } from "./csvFixed";

/** 保存で選べる文字コード (よく使うものだけ出す) */
export const ENCODINGS = [
  "UTF-8",
  "Shift_JIS",
  "EUC-JP",
  "ISO-2022-JP",
  "UTF-16LE",
  "UTF-16BE",
  "windows-1252",
];

/** 区切り文字の候補 (Rust側の判定と同じ並び) */
export const DELIMITERS = [
  { value: ",", label: "カンマ" },
  { value: "\t", label: "タブ" },
  { value: ";", label: "セミコロン" },
  { value: "|", label: "パイプ" },
];

/** 区切り文字を読める名前にする */
export function delimiterLabel(d: string): string {
  return DELIMITERS.find((x) => x.value === d)?.label ?? d;
}

/**
 * ファイルの形を1行にまとめる。
 *
 * 文字コードと改行コードは「保存したときに何が起きるか」に直結するので、
 * ツールバーに出しっぱなしにする
 */
export function formatLabel(f: CsvFormat): string {
  const parts = [
    f.encoding + (f.bom ? " (BOM付き)" : ""),
    f.newline === "crlf" ? "CRLF" : "LF",
  ];
  // 固定長のときは区切り文字と引用符は使わない
  if (f.fixed) {
    parts.push(fixedLabel(f.fixed));
    return parts.join(" · ");
  }
  parts.push(delimiterLabel(f.delimiter));
  if (f.quoting === "always") parts.push("全項目を引用符で囲む");
  return parts.join(" · ");
}
