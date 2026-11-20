/**
 * タブに出す名前と、マウスを乗せたときの説明。
 *
 * 未接続のタブがどれも「新しい接続」だと、どのタブで何を編集中なのか分からない。
 * 接続中 (つなぎに行っている途中) かどうかも、タブだけで分かるようにする。
 * 画面に触れない判定だけを置く
 */
import type { ConnectionProfile } from "./types";

/** 名前を決めるのに要るタブの中身 */
export interface TabLabelSource {
  connected: boolean;
  busy: "test" | "save" | "connect" | null;
  profile: ConnectionProfile;
  newConnForm?: boolean;
}

/** つなぎ先 (SQLite はファイル、それ以外はホスト:ポート) */
export function profileTarget(p: ConnectionProfile): string {
  if (p.dbType === "sqlite") return p.database || "(ファイル未設定)";
  return `${p.host}:${p.port}`;
}

/** タブの状態 (lost: 接続済みだが、操作が「接続が切れた」エラーで失敗した) */
export type TabState = "connected" | "lost" | "connecting" | "idle";

/** 接続が切れたときの説明 (タブの印のツールチップにも使う) */
export const LOST_HINT = "接続が切れました。クリックして接続し直す";

/** `lost` は、そのタブの操作が切断で失敗したか (connLost.ts が覚えている) */
export function tabState(t: TabLabelSource, lost = false): TabState {
  if (t.connected) return lost ? "lost" : "connected";
  if (t.busy === "connect") return "connecting";
  return "idle";
}

/**
 * タブに出す名前。
 *
 * 接続済み・接続中はその接続先の名前、
 * 未接続で接続先を編集しているときは編集中の名前、
 * 何も選んでいないときだけ「新しい接続」にする
 */
export function tabLabel(t: TabLabelSource): string {
  const name = t.profile.name.trim();
  if (t.connected) return name || "(無名)";
  const editing = !!t.profile.id || !!t.newConnForm || t.busy === "connect";
  if (editing && name) return name;
  return "新しい接続";
}

/**
 * マウスを乗せたときの説明 (タブの名前は幅で切れるので、全体をここで見せる)。
 * 「接続名 / つなぎ先」と、いまの状態を書く
 */
export function tabTitle(t: TabLabelSource, lost = false): string {
  const state = tabState(t, lost);
  const label = tabLabel(t);
  if (state === "idle" && !t.profile.id && !t.newConnForm) {
    return "接続先を選んでいます";
  }
  const head = `${label} / ${profileTarget(t.profile)}`;
  if (state === "connecting") return `${head}\n接続中…`;
  if (state === "idle") return `${head}\n未接続 (接続先を編集中)`;
  if (state === "lost") return `${head}\n${LOST_HINT}`;
  return head;
}
