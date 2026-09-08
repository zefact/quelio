/**
 * 正規表現の書き方の早見表。
 *
 * 検索バーの「?」から出す。
 * 探すのはRust側 (regex) なので、そこで使える書き方だけを並べてある
 */
import { Fragment, useEffect, useRef } from "react";
import { CloseIcon } from "./CsvFindIcons";

/** 書き方とその意味 */
type Row = [pattern: string, means: string];

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: "文字",
    rows: [
      [".", "任意の1文字"],
      ["\\d", "数字 (\\D は数字以外)"],
      ["\\w", "英数字と下線 (\\W はそれ以外)"],
      ["\\s", "空白 (\\S は空白以外)"],
      ["[abc]", "a か b か c のどれか1文字"],
      ["[^abc]", "a b c 以外の1文字"],
      ["[a-z]", "a から z のどれか1文字"],
      ["\\.", "記号そのもの (. * + ? ( ) [ ] の前に \\ を付ける)"],
    ],
  },
  {
    title: "繰り返し",
    rows: [
      ["*", "0回以上"],
      ["+", "1回以上"],
      ["?", "0回か1回"],
      ["{3}", "ちょうど3回"],
      ["{2,}", "2回以上"],
      ["{2,4}", "2回から4回"],
      ["*? +?", "できるだけ短く取る"],
    ],
  },
  {
    title: "位置と組み合わせ",
    rows: [
      ["^", "セルの先頭"],
      ["$", "セルの末尾"],
      ["\\b", "単語の切れ目"],
      ["ABC|DEF", "どちらか"],
      ["(ABC)", "ひとまとまりにする (置換で取り出せる)"],
      ["(?i)", "そこから先は英字の大小を区別しない"],
    ],
  },
  {
    title: "置換で使う",
    rows: [
      ["$1", "1つめの ( ) に当たった文字"],
      ["${1}", "続けて書くとき (${1}円)"],
      ["$$", "ドル記号そのもの"],
    ],
  },
];

/** そのまま試せる例 */
const EXAMPLES: Row[] = [
  ["^\\d+$", "数字だけのセル"],
  ["^\\s*$", "空白だけのセル"],
  ["\\d{4}-\\d{2}-\\d{2}", "2026-09-07 のような日付"],
  ["^(?:東京|大阪)", "東京か大阪で始まるセル"],
];

interface Props {
  onClose: () => void;
}

export function CsvRegexHelp({ onClose }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  /*
   * 閉じる係は毎回作り直されるので、覚えておいて中身だけ差し替える。
   * そうしないと、外を押したかを見る係を付け直し続けることになる
   */
  const close = useRef(onClose);
  close.current = onClose;

  // 外を押したら閉じる (開くきっかけになった押下は数えない)
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close.current();
    };
    const id = window.setTimeout(
      () => document.addEventListener("mousedown", down),
      0
    );
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", down);
    };
  }, []);

  const list = (rows: Row[]) => (
    <dl className="csv-regex-list">
      {rows.map(([pattern, means]) => (
        <Fragment key={pattern}>
          <dt>
            <code>{pattern}</code>
          </dt>
          <dd>{means}</dd>
        </Fragment>
      ))}
    </dl>
  );

  return (
    <div
      className="csv-regex-help"
      ref={boxRef}
      role="dialog"
      aria-label="正規表現の書き方"
    >
      <div className="csv-regex-head">
        <strong>正規表現の書き方</strong>
        <span className="toolbar-spacer" />
        <button className="csv-find-step" title="閉じる" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      {/* 縦に長くなりすぎないよう、2列に分けて並べる */}
      <div className="csv-regex-cols">
        {SECTIONS.map((s) => (
          <section key={s.title}>
            <h4>{s.title}</h4>
            {list(s.rows)}
          </section>
        ))}

        <section>
          <h4>例</h4>
          {list(EXAMPLES)}
        </section>
      </div>

      <p className="csv-regex-note">
        先読み <code>(?=…)</code> と後方参照 <code>\1</code> は使えません。
        「セル丸ごと」を入れているときは、書いたものが
        セルの中身と端から端まで一致するかを見ます。
      </p>
    </div>
  );
}
