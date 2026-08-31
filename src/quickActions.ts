/**
 * ⌘K で呼び出せるアクションの型と絞り込み。
 *
 * アクションそのもの (何をするか) は App が組み立てる。
 * ここは「探し方」だけを持ち、テストできるようにしておく
 */

export interface QuickAction {
  id: string;
  /** 一覧に出す名前 */
  label: string;
  /** 補足 (ショートカットキーなど) */
  hint?: string;
  /** 名前以外で引っかけたい言葉 (英語・ローマ字など。空白区切り) */
  keywords?: string;
  /** 選べない理由 (指定すると押せなくなる) */
  disabledReason?: string;
  run: () => void;
}

/** 打ち込んだ文字でアクションを絞る (名前・別名の部分一致) */
export function filterActions(
  actions: QuickAction[],
  query: string
): QuickAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return actions.filter((a) =>
    `${a.label} ${a.keywords ?? ""}`.toLowerCase().includes(q)
  );
}
