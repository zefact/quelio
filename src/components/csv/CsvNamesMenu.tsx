/**
 * ツールバーの「列名」から開くメニュー。
 *
 * 見出しの行が無いCSVは、開くたびに「1」「2」… の列になる。
 * 見出しをダブルクリックして付けた列名に名前を付けてお気に入りに残しておけば、
 * 同じ形のファイルを開いたときに、ここから選ぶだけで当てられる
 * (固定長の桁設定のお気に入りと同じ使い方)。
 * 列名は画面でだけ使い、ファイルには書き込まない。
 *
 * フォルダ分け・掴んでの並べ替え・バックアップと復元のボタンは、
 * 固定長のお気に入りと同じ部品 (CsvFavTree) を使う
 */
import { useMemo, useRef } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import type { CsvInfo, CsvNameNode, CsvNameSet } from "../../types";
import { CsvFavTree } from "./CsvFavTree";
import { CsvNameItemRow } from "./CsvNameItemRow";
import { NAME_CLOSED_KEY } from "./csvLayoutFold";
import { flatLayouts } from "./csvLayoutTree";
import { appliedNameSet, applyBlocked, saveBlocked } from "./csvNameSets";

interface Props {
  active: CsvInfo | null;
  /** お気に入り (フォルダ分けと並び順のまま) */
  nodes: CsvNameNode[];
  /** お気に入りの列名を今のファイルに当てる */
  onUse: (s: CsvNameSet) => void;
  /** 今の列名をお気に入りに保存する画面を開く */
  onSave: () => void;
  /** お気に入りを削除する (確認の画面を出す。その間もこのメニューは開いたまま) */
  onDelete: (s: CsvNameSet) => void;
  /** 削除の確認の画面を出しているか (出している間は、その画面の後ろへ下げる) */
  confirming: boolean;
  /** 並び順やフォルダ分けを変えた結果を残す */
  onSaveTree: (nodes: CsvNameNode[]) => void;
  /** 選んだお気に入りをファイルへ書き出す画面を開く */
  onBackup: () => void;
  /** ファイルから取り込む画面を開く */
  onRestore: () => void;
  onClose: () => void;
}

export function CsvNamesMenu({
  active,
  nodes,
  onUse,
  onSave,
  onDelete,
  confirming,
  onSaveTree,
  onBackup,
  onRestore,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  /*
   * 削除の確認の画面 (.modal-overlay) を押したときは閉じない。
   * どれを消そうとしているのかを見失わないよう、確認の間もメニューを残すため
   */
  useDismiss(true, onClose, { ref, escape: true, inside: ".modal-overlay" });

  const blocked = applyBlocked(active);
  const cantSave = saveBlocked(active);
  const flat = useMemo(() => flatLayouts(nodes), [nodes]);
  const applied =
    active && !active.hasHeader ? appliedNameSet(flat, active.labels) : null;

  return (
    <div
      className={"csv-fixed-menu csv-names-menu" + (confirming ? " behind" : "")}
      ref={ref}
    >
      <div className="csv-key-head csv-fav-head">列名のお気に入り</div>

      <CsvFavTree<CsvNameSet>
        nodes={nodes}
        closedKey={NAME_CLOSED_KEY}
        onSaveTree={onSaveTree}
        onBackup={onBackup}
        onRestore={onRestore}
        emptyHint="まだありません。見出しをダブルクリックして列に名前を付け、下の「今の列名をお気に入りに保存」で残せます"
        renderItem={(saved, { inFolder, mark, tap, hold }) => (
          <CsvNameItemRow
            saved={saved}
            inFolder={inFolder}
            applied={applied === saved.name}
            blocked={blocked}
            mark={mark}
            onUse={tap(() => onUse(saved))}
            onDelete={tap(() => onDelete(saved))}
            onHold={hold}
          />
        )}
      />
      {flat.length > 0 && blocked && active && (
        <div className="csv-empty-hint csv-fav-hint">{blocked}</div>
      )}

      <div className="context-sep" />
      <button
        className="context-item has-tooltip tooltip-left"
        disabled={!!cantSave}
        data-tooltip={cantSave ?? undefined}
        onClick={onSave}
      >
        今の列名をお気に入りに保存…
      </button>
      <div className="csv-empty-hint csv-fav-hint">
        見出しをダブルクリックすると、列に名前を付けられます。
        1行目を見出し行にしていないファイルでは、名前は画面にだけ出て、ファイルには書き込みません
      </div>
    </div>
  );
}
