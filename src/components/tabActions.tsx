/**
 * 表示中のタブに対する操作のまとめ。
 *
 * 画面 (SessionView) からは「今のタブに対して〇〇する」としか呼ばないので、
 * 20個近くのコールバックをpropsで1段ずつ渡すのをやめ、
 * Contextで直接受け取れるようにする。
 * 実体を作るのは App だけ (タブのキーを閉じ込めた関数を入れる)
 */
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { EditorOptions, TableInfo, TableTab } from "../types";

export interface TabActions {
  /** データベースを選び直す */
  onSelectDb: (db: string) => void;
  /** 設定画面を開く (外部ツールが見つからないときの案内から) */
  onOpenSettings: () => void;
  /** テーブル一覧の再読み込み (選択中のテーブルは維持する) */
  onReloadTables: () => Promise<void> | void;
  /** データベースを作成・削除したあとの一覧 */
  onDatabasesChanged: (list: string[]) => void;
  /** 選択中テーブルの定義を取得し直す (DDL実行後) */
  onReloadDetail: () => void;
  /** 生成したSQLをSQLエディタへ送る */
  onSendToEditor: (sql: string) => void;
  onSelectTable: (table: TableInfo) => void;
  /** 定義ビューとSQLエディタを行き来する */
  onToggleQuery: () => void;
  onChangeSql: (sql: string) => void;
  /** SQLエディタの実行設定 (トランザクション等) の変更 */
  onChangeEditorOpts: (patch: Partial<EditorOptions>) => void;
  onRunQuery: (
    offset: number,
    sqlOverride?: string,
    transaction?: boolean,
    explain?: "explain" | "analyze"
  ) => void;
  /** 実行中SQLのキャンセル */
  onCancelQuery: () => void;
  /** 結果タブ単位のページ送り */
  onPageQuery: (index: number, offset: number) => void;
  /** サーバーサイドソートの変更 */
  onSortQuery: (
    index: number,
    orderBy: string | null,
    orderDir: "asc" | "desc"
  ) => void;
  /** 定義 / データ タブの切替 */
  onChangeTableTab: (view: TableTab) => void;
}

/**
 * 中身を毎回作り直しても、外へ渡す関数の同一性は変えない。
 *
 * Appは1文字入力するたびに描き直されるので、
 * そのたびに新しい関数を渡すと、受け取り側の React.memo が
 * ことごとく素通りになる (テーブル一覧の再描画など)。
 * 呼び出しは常に最新の実装へ転送するので、
 * 中で参照している状態は最新のまま
 */
export function useStableActions(impl: TabActions): TabActions {
  const ref = useRef(impl);
  ref.current = impl;
  return useMemo(() => {
    const stable = {} as Record<string, (...args: never[]) => unknown>;
    for (const key of Object.keys(ref.current) as (keyof TabActions)[]) {
      stable[key] = (...args: never[]) =>
        (ref.current[key] as (...a: never[]) => unknown)(...args);
    }
    return stable as unknown as TabActions;
  }, []);
}

const TabActionsContext = createContext<TabActions | null>(null);

export function TabActionsProvider({
  value,
  children,
}: {
  value: TabActions;
  children: ReactNode;
}) {
  return (
    <TabActionsContext.Provider value={value}>
      {children}
    </TabActionsContext.Provider>
  );
}

/** 表示中のタブへの操作を受け取る (Providerの外で呼んだら組み立ての誤り) */
export function useTabActions(): TabActions {
  const actions = useContext(TabActionsContext);
  if (!actions) {
    throw new Error("TabActionsProvider の中で使ってください");
  }
  return actions;
}
