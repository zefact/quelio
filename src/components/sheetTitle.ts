/**
 * SQLシートの見出しをSQLから作る。
 *
 * 以前は最初のSQL行だけを見ていたが、書く人はたいてい
 * 「-- 月次の売上」のように用件をコメントで書く。
 * コメントがあればそれを見出しにする (何のSQLか一目で分かるようにする)
 */

/** 見出しの長さ (これを超えたら「…」で切る) */
const MAX = 24;

/** 行コメントの印 (`--` はSQL共通、`#` はMySQL) */
const LINE_COMMENT = /^(?:--+|#)\s*/;

/** ブロックコメントの始まり */
const BLOCK_OPEN = /^\/\*+\s*/;

/** 飾りだけの行 (`-----` や `=====` など) は中身が無いものとして飛ばす */
function isRule(text: string): boolean {
  return text === "" || /^[-=*#_~]+$/.test(text);
}

/** 1行から、コメントなら中身を取り出す (コメントでなければ null) */
function commentText(line: string): string | null {
  if (LINE_COMMENT.test(line)) {
    return line.replace(LINE_COMMENT, "").replace(/\s+$/, "");
  }
  if (BLOCK_OPEN.test(line)) {
    return line
      .replace(BLOCK_OPEN, "")
      .replace(/\*+\/\s*$/, "")
      .replace(/\s+$/, "");
  }
  return null;
}

/**
 * SQLの先頭から見出しを作る。
 *
 * 上から順に見て、最初に中身のある行を見出しにする。
 * コメント行なら、コメントの印を外した中身を使う
 */
export function autoTitle(sql: string): string {
  for (const raw of sql.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const comment = commentText(line);
    if (comment !== null) {
      // 区切り線だけの行は見出しにならないので次を見る
      if (isRule(comment)) continue;
      return clip(comment);
    }
    return clip(line);
  }
  return "新規";
}

/** 長すぎる見出しを切る */
function clip(text: string): string {
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}
