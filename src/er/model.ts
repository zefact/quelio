/**
 * ER図の「何を描くか」を決める部分。
 * スキーマからノード (テーブル) とエッジ (リレーション) を組み立てる。
 * 画面に依存しない純関数だけを置く
 */

import { parseComment } from "../comment";
import type { FkInfo, SchemaEntry } from "../types";

export const NODE_HEAD_H = 26;
export const ROW_H = 17;
export const NODE_PAD_B = 6;

/** ER図のノードに表示するカラム */
export interface ErColumn {
  name: string;
  isPk: boolean;
  /** NOT NULL制約があるか */
  notNull: boolean;
  /** 型・サイズ (表示オプションOFFなら空) */
  type: string;
  /** 日本語名 (コメントの論理名。表示オプションOFFなら空) */
  logical: string;
}

/** カラム先頭のマーク (● = NOT NULL / ○ = NULL許容。PKは色で区別) */
export function colMarker(c: ErColumn): string {
  return c.isPk || c.notNull ? "● " : "○ ";
}

/** ER図のノード (テーブル) */
export interface ErNode {
  name: string;
  /** テーブルの日本語名 (コメントの論理名。表示オプションOFFなら空) */
  logical: string;
  /** 表示するカラム (PKのみ or 全カラム) */
  columns: ErColumn[];
  w: number;
  h: number;
}

/** ER図のエッジ (リレーション)。from(参照元/子) → to(参照先/親) */
export interface ErEdge {
  from: string;
  to: string;
  /** 参照元テーブル側の代表カラム (線の出発位置) */
  fromColumn: string;
  /** 参照先テーブル側の代表カラム (線の到達位置) */
  toColumn: string;
  label: string;
  /** FK制約ではなく命名からの推測か */
  guessed: boolean;
  /** 手動で追加した線か */
  manual?: boolean;
}

/** エッジの識別キー (削除の記憶に使う) */
export function edgeKey(e: {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}): string {
  return `${e.from}.${e.fromColumn}->${e.to}.${e.toColumn}`;
}

/** スキーマ+表示オプションからノード一覧を組み立てる */
export function buildNodes(
  entries: SchemaEntry[],
  allCols: boolean,
  showTypes: boolean,
  showLogical: boolean,
  delim: string
): ErNode[] {
  return entries.map((e) => {
    const all: ErColumn[] = e.detail.columns.map((c) => ({
      name: c.name,
      isPk: c.key === "PRI",
      notNull: !c.nullable,
      type: showTypes ? c.colType : "",
      logical: showLogical ? parseComment(c.comment ?? "", delim)[0] : "",
    }));
    const columns = allCols ? all : all.filter((c) => c.isPk);
    // テーブルの日本語名 (テーブルコメントの論理名)
    const tableComment =
      e.detail.info.find(([label]) => label === "コメント")?.[1] ?? "";
    const logical = showLogical ? parseComment(tableComment, delim)[0] : "";
    return {
      name: e.table.name,
      logical,
      columns,
      w: nodeWidth(e.table.name, logical, columns),
      h: NODE_HEAD_H + columns.length * ROW_H + NODE_PAD_B,
    };
  });
}

/**
 * カラム欄のグリッド列。
 * 最後の列だけノードの右端まで伸ばす (列の数は増やさない)。
 * 伸ばさないと右側に隙間ができ、行のホバー域が右の●ハンドルまで届かない
 */
export function colTracks(showTypes: boolean, showLogical: boolean): string {
  const tracks = ["max-content"];
  if (showTypes) tracks.push("max-content");
  if (showLogical) tracks.push("max-content");
  tracks[tracks.length - 1] = "minmax(max-content, 1fr)";
  return tracks.join(" ");
}

/** 全角文字を2文字ぶんとして数える概算幅 */
export function charUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return units;
}

/** カラム表示内容の概算幅からノード幅を決める (等幅11px想定)。
 * 名前・型・日本語名は縦列で揃えるため、それぞれの最大幅の合計で見積もる */
export function nodeWidth(name: string, logical: string, cols: ErColumn[]): number {
  const maxName = Math.max(
    charUnits(name) + (logical ? charUnits(logical) + 2 : 0) + 2,
    ...cols.map((c) => charUnits(c.name) + 3)
  );
  const maxType = Math.max(0, ...cols.map((c) => charUnits(c.type)));
  const maxLogical = Math.max(0, ...cols.map((c) => charUnits(c.logical)));
  const units =
    maxName + (maxType > 0 ? maxType + 2 : 0) + (maxLogical > 0 ? maxLogical + 2 : 0);
  // 日本語名が「...」で切れないよう上限は広めに取る
  return Math.min(760, Math.max(140, 18 + units * 7.2));
}

/** FK + 命名推測からエッジ一覧を作る */
export function buildEdges(entries: SchemaEntry[], fks: FkInfo[]): ErEdge[] {
  const tableNames = new Set(entries.map((e) => e.table.name));
  const edges: ErEdge[] = [];
  const seen = new Set<string>();
  const pairHasFk = new Set<string>();

  const push = (e: ErEdge) => {
    const key = `${e.from}->${e.to}:${e.label}`;
    if (e.from === e.to || seen.has(key)) return;
    seen.add(key);
    edges.push(e);
  };

  // FK制約
  for (const fk of fks) {
    if (!tableNames.has(fk.table) || !tableNames.has(fk.refTable)) continue;
    push({
      from: fk.table,
      to: fk.refTable,
      fromColumn: fk.column,
      toColumn: fk.refColumn,
      label: `${fk.column} → ${fk.refColumn}`,
      guessed: false,
    });
    pairHasFk.add(`${fk.table}->${fk.refTable}`);
  }

  // 命名からの推測
  const colsOf = new Map<string, Set<string>>();
  const pkOf = new Map<string, string[]>();
  for (const e of entries) {
    colsOf.set(e.table.name, new Set(e.detail.columns.map((c) => c.name)));
    pkOf.set(
      e.table.name,
      e.detail.columns.filter((c) => c.key === "PRI").map((c) => c.name)
    );
  }

  for (const target of entries) {
    const t = target.table.name;
    const pk = pkOf.get(t) ?? [];
    // ルール1: 参照先のPKカラム一式(1〜3個・"id"単独は除く)を全て持つテーブルを子とみなす
    const pkDistinctive =
      pk.length >= 1 && pk.length <= 3 && !(pk.length === 1 && pk[0] === "id");
    if (pkDistinctive) {
      for (const src of entries) {
        const u = src.table.name;
        if (u === t || pairHasFk.has(`${u}->${t}`)) continue;
        const cols = colsOf.get(u)!;
        if (pk.every((p) => cols.has(p))) {
          push({
            from: u,
            to: t,
            fromColumn: pk[pk.length - 1],
            toColumn: pk[pk.length - 1],
            label: pk.join(", "),
            guessed: true,
          });
        }
      }
    }
    // ルール2: 「xxx_id」カラム → PKが(id)のテーブル xxx / m_xxx / t_xxx / xxxs
    if (pk.length === 1 && pk[0] === "id") {
      const bases = [t, t.replace(/^m_/, ""), t.replace(/^t_/, ""), t.replace(/s$/, "")];
      for (const src of entries) {
        const u = src.table.name;
        if (u === t || pairHasFk.has(`${u}->${t}`)) continue;
        for (const col of colsOf.get(u)!) {
          if (!col.endsWith("_id")) continue;
          const base = col.slice(0, -3);
          if (bases.includes(base)) {
            push({
              from: u,
              to: t,
              fromColumn: col,
              toColumn: "id",
              label: `${col} → id`,
              guessed: true,
            });
          }
        }
      }
    }
  }
  return edges;
}
