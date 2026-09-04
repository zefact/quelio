/**
 * 保存する形 (文字コード・改行・区切り・引用符) と、
 * 1行目をヘッダとして扱うかを切り替えるメニュー。
 *
 * 開いたときの形をそのまま保存の既定にしているので、
 * 変えたいときだけここから触る
 */
import { useEffect, useRef } from "react";
import type { CsvFormat, CsvFormatPatch, CsvNewline, CsvQuoting } from "../../types";
import { SelectMenu } from "../SelectMenu";
import { ENCODINGS, DELIMITERS } from "./csvFormat";

/** 改行コードの選択肢 */
const NEWLINES = [
  { value: "lf", label: "LF (macOS / Linux)" },
  { value: "crlf", label: "CRLF (Windows)" },
];

/** 引用符の付け方の選択肢 */
const QUOTINGS = [
  { value: "necessary", label: "必要なときだけ" },
  { value: "always", label: "全項目を囲む" },
];

/**
 * 文字コードの選択肢。
 *
 * 一覧に無い文字コードで開いているときは、その名前も足す
 * (選び直せなくならないように)
 */
function encodingOptions(current: string) {
  const names = ENCODINGS.includes(current)
    ? ENCODINGS
    : [current, ...ENCODINGS];
  return names.map((n) => ({ value: n, label: n }));
}

interface Props {
  format: CsvFormat;
  hasHeader: boolean;
  /** ファイルから開いたタブか (読み方を変えるには読み直しが要る) */
  fromFile: boolean;
  onChange: (patch: CsvFormatPatch) => void;
  onHeader: (on: boolean) => void;
  /** 固定長の桁を決める画面を開く */
  onFixed: () => void;
  /** 下の情報バーから開くときは上へ向けて出す */
  up?: boolean;
  onClose: () => void;
}

export function CsvFormatMenu({
  format,
  hasHeader,
  fromFile,
  onChange,
  onHeader,
  onFixed,
  up = false,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // メニューの外を触ったら閉じる
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <div className={"csv-format-menu" + (up ? " up" : "")} ref={ref}>
      <div className="csv-form-row">
        <span>文字コード</span>
        <SelectMenu
          popFixed
          value={format.encoding}
          options={encodingOptions(format.encoding)}
          onChange={(encoding) => onChange({ encoding })}
        />
      </div>

      <div className="csv-form-row">
        <span>改行</span>
        <SelectMenu
          popFixed
          value={format.newline}
          options={NEWLINES}
          onChange={(v) => onChange({ newline: v as CsvNewline })}
        />
      </div>

      {/* 区切りと引用符は固定長では使わないので出さない */}
      {!format.fixed && (
        <>
          <div className="csv-form-row">
            <span>区切り</span>
            <SelectMenu
              popFixed
              value={format.delimiter}
              options={DELIMITERS}
              onChange={(delimiter) => onChange({ delimiter })}
            />
          </div>

          <div className="csv-form-row">
            <span>引用符</span>
            <SelectMenu
              popFixed
              value={format.quoting}
              options={QUOTINGS}
              onChange={(v) => onChange({ quoting: v as CsvQuoting })}
            />
          </div>
        </>
      )}

      <div className="context-sep" />

      <button
        className="context-item"
        disabled={!fromFile}
        title={
          fromFile ? undefined : "ファイルから開いたタブでのみ読み方を変えられます"
        }
        onClick={onFixed}
      >
        {format.fixed ? "固定長の桁を変える..." : "固定長として読み直す..."}
      </button>

      <div className="context-sep" />

      <label className="csv-check">
        <input
          type="checkbox"
          checked={format.bom}
          onChange={(e) => onChange({ bom: e.target.checked })}
        />
        BOMを付ける
      </label>
      <label className="csv-check">
        <input
          type="checkbox"
          checked={hasHeader}
          onChange={(e) => onHeader(e.target.checked)}
        />
        1行目をヘッダとして扱う
      </label>
    </div>
  );
}
