/**
 * SQL関数のリファレンス (アプリに持たせる辞書)。
 *
 * 「書き方を忘れてネットで調べる」を無くすのが目的なので、
 * 1件ずつに *そのまま実行できる例* と *その結果* を持たせる。
 * 例は接続なしでも読めるよう、NOW() などその場で変わる値は避けてある
 * (どうしても要るものは、結果を「実行時刻による」と書く)
 */

/** 関数1件 */
export interface SqlFunc {
  /** 関数名 (大文字。候補や検索の見出しになる) */
  name: string;
  /** 書式。引数は日本語の名前にして、何を渡すのか分かるようにする */
  signature: string;
  /** 何をする関数か (1行) */
  summary: string;
  /** そのまま実行できる例 */
  example: string;
  /** 例の結果 */
  result: string;
  /** 間違えやすい所の補足 (無ければ省く) */
  note?: string;
  /** 使えるようになった版 (「MySQL 8.0」など。古い版で使えないものだけ) */
  since?: string;
  /** 検索で引っかけたい別名・関連語 (「連結」「切り捨て」など) */
  keywords?: string[];
}

/** 分類ごとの並び */
export interface SqlFuncGroup {
  /** 分類名 (「文字列」「日付・時刻」など) */
  category: string;
  items: SqlFunc[];
}
