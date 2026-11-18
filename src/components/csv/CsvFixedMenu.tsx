/**
 * ツールバーの「固定長」から開くメニュー。
 *
 * 固定長のファイルは、同じ桁設定を繰り返し使う。
 * 一度お気に入りに登録しておけば、ここから選ぶだけで読み直せる
 * (桁設定のダイアログを開く必要がない)。
 *
 * フォルダ分け・掴んでの並べ替え・バックアップと復元のボタンは、
 * 列名のお気に入りと同じ部品 (CsvFavTree) を使う。
 * ここで描くのは、桁設定のお気に入り1件の行 (CsvFavItemRow) と、下の操作だけ
 */
import { useRef } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import type { CsvLayoutNode, CsvSavedLayout } from "../../types";
import { CsvFavItemRow } from "./CsvFavItemRow";
import { CsvFavTree } from "./CsvFavTree";
import { LAYOUT_CLOSED_KEY } from "./csvLayoutFold";

interface Props {
  /**
   * 開いているタブを読み直せるか (ファイルから開いたタブのときだけ)。
   *
   * 読み直せないときも、お気に入りの整理 (並べ替え・変更・バックアップ) はできる
   */
  canApply: boolean;
  /** 今このファイルを固定長として読んでいるか */
  fixed: boolean;
  /** お気に入り (フォルダ分けと並び順のまま) */
  nodes: CsvLayoutNode[];
  /** 今このファイルに使われているお気に入りの名前 (無ければ null) */
  applied: string | null;
  /** お気に入りの桁設定で読み直す */
  onUse: (s: CsvSavedLayout) => void;
  /** お気に入りの名前・桁設定を直す画面を開く */
  onEditItem: (s: CsvSavedLayout) => void;
  /** お気に入りを削除する (確認の画面を出す。その間もこのメニューは開いたまま) */
  onDelete: (s: CsvSavedLayout) => void;
  /** 削除の確認の画面を出しているか (出している間は、その画面の後ろへ下げる) */
  confirming: boolean;
  /** 並び順やフォルダ分けを変えた結果を残す */
  onSaveTree: (nodes: CsvLayoutNode[]) => void;
  /** 桁設定のダイアログを開く */
  onEdit: () => void;
  /** 選んだお気に入りをファイルへ書き出す画面を開く */
  onBackup: () => void;
  /** ファイルから取り込む画面を開く */
  onRestore: () => void;
  /** 区切り文字として読み直す */
  onUseDelimiter: () => void;
  onClose: () => void;
}

export function CsvFixedMenu({
  canApply,
  fixed,
  nodes,
  applied,
  onUse,
  onEditItem,
  onDelete,
  confirming,
  onSaveTree,
  onEdit,
  onBackup,
  onRestore,
  onUseDelimiter,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  /*
   * メニューの外を触ったら閉じる。
   *
   * タブバーの空いている所は「窓をつかむ場所」なので、
   * ふつうの監視では押されたことが届かない。
   * 共通のフックがそこまで見てくれる
   */
  /*
   * 削除の確認の画面 (.modal-overlay) を押したときは閉じない。
   * どれを消そうとしているのかを見失わないよう、確認の間もメニューを残すため。
   * 確認中の Escape は確認の画面が先に受け取って処理済みにするので、ここまでは来ない
   */
  useDismiss(true, onClose, { ref, escape: true, inside: ".modal-overlay" });

  return (
    <div
      className={"csv-fixed-menu" + (confirming ? " behind" : "")}
      ref={ref}
    >
      <div className="csv-key-head csv-fav-head">お気に入り</div>

      <CsvFavTree<CsvSavedLayout>
        nodes={nodes}
        closedKey={LAYOUT_CLOSED_KEY}
        onSaveTree={onSaveTree}
        onBackup={onBackup}
        onRestore={onRestore}
        emptyHint="登録されていません。桁設定のダイアログから保存できます"
        renderItem={(saved, { inFolder, mark, tap, hold }) => (
          <CsvFavItemRow
            saved={saved}
            inFolder={inFolder}
            applied={applied === saved.name}
            canApply={canApply}
            mark={mark}
            // 読み直す相手が無いときは、押したら直す画面を開く
            onUse={tap(() => (canApply ? onUse(saved) : onEditItem(saved)))}
            onEdit={tap(() => onEditItem(saved))}
            onDelete={tap(() => onDelete(saved))}
            onHold={hold}
          />
        )}
      />

      <div className="context-sep" />

      <button className="context-item" onClick={onEdit}>
        {!canApply
          ? "桁設定を新しく登録..."
          : fixed
            ? "桁設定を変更..."
            : "固定長の桁を設定..."}
      </button>
      {!canApply && (
        <div className="csv-empty-hint csv-fav-hint">
          ファイルから開いたタブでは、お気に入りを選んで読み直せます
        </div>
      )}
      {fixed && (
        <button className="context-item" onClick={onUseDelimiter}>
          区切り文字として読み直す
        </button>
      )}
    </div>
  );
}
