/**
 * ⌘/Ctrl と Shift による複数選択。
 *
 * テーブル一覧と結果グリッドで同じ操作を別々に書いていたため、
 * 片方だけ直すと動きが食い違っていた。
 * 「基準 (anchor) をキーで覚える」「範囲は今の並びから取る」という
 * 決まりごとをここに集める
 */
import { useCallback, useRef, useState } from "react";

export interface MultiSelectOptions {
  /**
   * 選択が1つだけのときに同じものをクリックしたら、選択を外すか。
   *
   * 結果グリッドは「選んだ行だけコピー」なので外せると便利だが、
   * テーブル一覧は選択とテーブルの表示が連動しているため外さない
   */
  toggleOnRepeat?: boolean;
}

export interface MultiSelect {
  /** 選択中のキー */
  selected: Set<string>;
  /** 選択を直接置き換える (絞り込みで消えたぶんを外すときなど) */
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  /**
   * クリックを反映する。
   *
   * 戻り値は「修飾キー無しの、ふつうのクリックだったか」。
   * 呼び出し側はこれを見て、選択に連動した表示 (定義を出す等) を行う
   */
  click: (e: React.MouseEvent, key: string) => boolean;
  /** 右クリック時の選択合わせ (選択の外を押したら、その1つだけにする) */
  rightClick: (key: string) => void;
  /** 1つだけ選んだ状態にする (検索や作成の直後に、その1つへ揃える) */
  select: (key: string) => void;
  /** 表示中のものを全部選ぶ (⌘/Ctrl+A) */
  selectAll: () => void;
  /** 選択を空にする */
  clear: () => void;
}

/**
 * @param keys 今表示している順のキー (Shift の範囲はこの並びで決まる)
 */
export function useMultiSelect(
  keys: string[],
  options: MultiSelectOptions = {}
): MultiSelect {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /*
   * Shift の基準はキーで覚える。
   * 位置で覚えると、絞り込みや並べ替えで別のものが基準になってしまう
   */
  const [anchor, setAnchor] = useState<string | null>(null);
  /*
   * 並びは描画のたびに作り直されるので、
   * 関数の同一性を保つために ref 経由で最新を見る
   */
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const toggleOnRepeat = options.toggleOnRepeat ?? false;

  const click = useCallback(
    (e: React.MouseEvent, key: string): boolean => {
      if (e.metaKey || e.ctrlKey) {
        setSelected((cur) => {
          const next = new Set(cur);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        setAnchor(key);
        return false;
      }
      const list = keysRef.current;
      const from = anchor === null ? -1 : list.indexOf(anchor);
      const to = list.indexOf(key);
      // 基準が表示から外れていたら範囲選択はせず、1つだけ選び直す
      if (e.shiftKey && from >= 0 && to >= 0) {
        // Shift+クリックで伸びた文字列選択が残らないようにする
        window.getSelection()?.removeAllRanges();
        const [a, b] = [Math.min(from, to), Math.max(from, to)];
        setSelected(new Set(list.slice(a, b + 1)));
        return false;
      }
      setSelected((cur) =>
        toggleOnRepeat && cur.size === 1 && cur.has(key)
          ? new Set()
          : new Set([key])
      );
      setAnchor(key);
      return true;
    },
    [anchor, toggleOnRepeat]
  );

  const rightClick = useCallback(
    (key: string) => {
      /*
       * 選択の外を右クリックしたら、そこだけの選択に直す。
       * そうしないと「押したもの」と「効く対象」がずれる。
       * 選択の中を押したときは、まとめて操作したいので触らない
       */
      if (selected.has(key)) return;
      setSelected(new Set([key]));
      setAnchor(key);
    },
    [selected]
  );

  const select = useCallback((key: string) => {
    setSelected(new Set([key]));
    setAnchor(key);
  }, []);

  const selectAll = useCallback(() => {
    const list = keysRef.current;
    setSelected(new Set(list));
    setAnchor(list[0] ?? null);
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  return { selected, setSelected, click, rightClick, select, selectAll, clear };
}
