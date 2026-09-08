/**
 * 固定長のヘッダ行・トレーラ行を、データ行の表とは別の小さな表で出す。
 *
 * 項目の分け方がデータ行と違うので同じ表には混ぜられないが、
 * 見た目と操作はデータ行と同じにしたいので、表そのものは `CsvGrid` を使い回す。
 * 中身は1行だけなので、行はここが持っているものをそのまま返す
 */
import { useMemo, useState } from "react";
import type { CsvRows } from "../../hooks/useCsvRows";
import type { CsvFixedColumn } from "../../types";
import { CsvGrid, HEAD_H, ROW_H } from "./CsvGrid";
import { thinGap } from "./csvScrollbar";
import type { CsvCursor } from "./csvSelection";

interface Props {
  /** 「ヘッダ」か「トレーラ」 */
  label: string;
  /** その行の桁 (項目名はここから取る) */
  columns: CsvFixedColumn[];
  /** 今の値 */
  values: string[];
  /** 書き換えた値を渡す */
  onCommit: (cells: string[]) => void;
  /**
   * 外から指定された横位置。
   *
   * データ行の表と横スクロールを合わせるために使う
   * (自分が動かした側には渡ってこない)
   */
  syncLeft?: number;
  /** 横に動いたことを外へ伝える */
  onScrollLeft?: (left: number) => void;
}

/** どちらの行かを出す見出しの高さ */
const LABEL_H = 16;

/**
 * 見出し・列見出し・1行ぶんが収まる高さ。
 *
 * 下には横スクロールバーのぶんを空けておく。
 * 少ないと、行がバーに隠れてしまう (縦には送らない作りなので逃げ場がない)
 */
function boxHeight(): number {
  return LABEL_H + HEAD_H + ROW_H + thinGap();
}

export function CsvEdgeRow({
  label,
  columns,
  values,
  onCommit,
  syncLeft,
  onScrollLeft,
}: Props) {
  const [cursor, setCursor] = useState<CsvCursor | null>({ row: 0, col: 0 });

  /*
   * 列名と行は、同じ中身なら同じものを返す。
   *
   * 毎回作り直すと `CsvGrid` が列幅を測り直し続けてしまう
   */
  const names = useMemo(
    () => columns.map((c, i) => c.name || `${i + 1}`),
    [columns]
  );
  const rows: CsvRows = useMemo(
    () => ({
      row: (index) => (index === 0 ? values : null),
      // 1行しかないので、行番号は数えるまでもなく1
      number: () => 1,
      // 種別を見分ける表ではないので、ヘッダ行の色分けは使わない
      isHeadRow: () => false,
      // 全行が手元にあるので、取りに行くことも捨てることもしない
      ensure: () => {},
      clear: () => {},
      error: null,
      version: 0,
    }),
    [values]
  );

  return (
    <div className="csv-edge" style={{ height: boxHeight() }}>
      {/*
        見出しは表の上に出す。
        横に並べると表そのものが右へずれて、下のデータ行と列がそろわなくなる
      */}
      <div className="csv-edge-label" style={{ height: LABEL_H }}>
        {label}
      </div>
      <div className="csv-edge-grid">
        <CsvGrid
          columns={names}
          rowCount={1}
          rows={rows}
          cursor={cursor}
          onCursor={setCursor}
          onEdit={(_row, col, value) => {
            const next = [...values];
            next[col] = value;
            onCommit(next);
          }}
          syncLeft={syncLeft}
          onScrollPos={(_top, left) => onScrollLeft?.(left)}
        />
      </div>
    </div>
  );
}
