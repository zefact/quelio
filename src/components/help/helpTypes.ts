/**
 * ヘルプの話題の形。
 *
 * 話題そのもの (照合順序・実行計画…) はファイルを分けてあるので、
 * ここには「どういう形で書くか」だけを置く
 */
import type { DbType } from "../../types";

/**
 * 言葉と意味の一覧を並べる表。
 *
 * 「○○ … こういう意味」を並べるだけの説明は、
 * 文章にすると目が滑るので表で出す
 */
export interface HelpTable {
  /** 見出しの行 */
  head: string[];
  /** 中身。1つが1行で、head と同じ数だけ並べる */
  rows: string[][];
}

/** 見出しと中身のひとまとまり */
export interface HelpSection {
  title: string;
  /**
   * 文章の段落。
   *
   * 画面は1行を1段落として出し、行そのものを並びの目印に使うので、
   * 同じ見出しの中で同じ行を2回書かない
   */
  lines?: string[];
  /** 表 (段落のあとに出る) */
  table?: HelpTable;
}

/** 左の一覧に並ぶ話題1つ */
export interface HelpTopic {
  /** 覚えておく目印 */
  id: string;
  /** 一覧に出す名前 */
  label: string;
  /** 一覧の名前の下に出す一言 */
  note: string;
  /** この話が当てはまるDB (空なら、どのDBでも出す) */
  dbTypes?: DbType[];
  /** 右に出す中身 */
  sections: (dbType: DbType) => HelpSection[];
}
