/**
 * ピン留めしたテーブルの読み書き。
 *
 * 接続プロファイルとデータベースの組ごとに覚えているので、
 * DBを切り替えたら読み直す
 */
import { useCallback, useEffect, useState } from "react";
import { listPinnedTables, setPinnedTable } from "../api";

export interface PinnedTables {
  /** ピン留めしているテーブルのキー */
  pinned: Set<string>;
  /** ピンを付け外しする */
  toggle: (table: string) => void;
  /** まとめて付け外しする (複数選択したとき) */
  toggleMany: (tables: string[], pinned: boolean) => void;
}

export function usePinnedTables(
  profileId: string,
  database: string | null
): PinnedTables {
  const [pinned, setPinned] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!profileId || !database) {
      setPinned(new Set());
      return;
    }
    let alive = true;
    listPinnedTables(profileId, database)
      .then((list) => {
        if (alive) setPinned(new Set(list));
      })
      .catch(() => {
        // 読めなくてもピンが出ないだけなので、画面は止めない
      });
    return () => {
      alive = false;
    };
  }, [profileId, database]);

  const apply = useCallback(
    async (tables: string[], next: boolean) => {
      if (!profileId || !database || tables.length === 0) return;
      // 画面はすぐ反映し、保存は順番に行う (最後の結果を正とする)
      setPinned((prev) => {
        const out = new Set(prev);
        for (const t of tables) {
          if (next) out.add(t);
          else out.delete(t);
        }
        return out;
      });
      try {
        let last: string[] = [];
        for (const t of tables) {
          last = await setPinnedTable(profileId, database, t, next);
        }
        setPinned(new Set(last));
      } catch {
        // 保存に失敗したら、覚えている内容へ戻す
        listPinnedTables(profileId, database)
          .then((list) => setPinned(new Set(list)))
          .catch(() => {});
      }
    },
    [profileId, database]
  );

  const toggle = useCallback(
    (table: string) => {
      void apply([table], !pinned.has(table));
    },
    [apply, pinned]
  );

  const toggleMany = useCallback(
    (tables: string[], next: boolean) => {
      void apply(tables, next);
    },
    [apply]
  );

  return { pinned, toggle, toggleMany };
}
