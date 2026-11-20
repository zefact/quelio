/**
 * 「接続が切れた」ことを、操作の失敗から見分けて覚えておく。
 *
 * バックエンドは操作の入口で接続を確かめ、切れていれば黙って張り直す。
 * それでも、DB が止まっている・ネットワークが切れているときは操作が失敗する。
 * その失敗が「接続が切れた」種類なら、タブに印を付けて「接続し直す」を出す。
 *
 * 定期的な問い合わせ (ping) は足さない。
 * バックエンドがすでに120秒ごとに ping を送っており、
 * 画面からも送ると本番の DB へ余計な往復が増えるため。
 * 印は「実際の操作が切断で失敗した」ときだけ付き、次に成功すれば消える
 */

/** 見分けるときに使う、エラーの文言の一部 (小文字にして比べる) */
const LOST_MARKS: readonly string[] = [
  /*
   * Quelio 自身が付ける前置き。
   * 接続の張り直しに失敗したとき・通信が切れたときに付く
   * (db.rs の format_db_error、kv.rs の connect、ssh_tunnel.rs)
   */
  "接続できません",
  "接続できませんでした",
  "db接続がタイムアウト",
  "valkey接続がタイムアウト",
  "ssh接続がタイムアウト",
  "ssh接続に失敗",
  // 通信路そのものが切れた (OS が返す文言。MySQL / PostgreSQL / Valkey 共通)
  "broken pipe",
  "connection reset",
  "connection refused",
  "connection aborted",
  "connection closed",
  "connection dropped",
  "unexpected end of file",
  "unexpectedeof",
  "network is unreachable",
  "no route to host",
  "host is down",
  "socket is not connected",
  "operation timed out",
  "connection timed out",
  // MySQL: サーバーが落ちた・止まった
  "server has gone away",
  "lost connection to mysql server",
  "server shutdown in progress",
  // PostgreSQL: サーバーが接続を切った (英語と日本語のメッセージ)
  "terminating connection",
  "server closed the connection",
  "the database system is shutting down",
  "the database system is starting up",
  "the database system is in recovery mode",
  "接続を終了しています",
  "シャットダウンしています",
  // Valkey: 送受信のタスクが止まった (サーバーが接続を切ったとき)
  "unexpectedly terminated",
];

/**
 * 「切断」とはみなさないもの。
 * 文言の中に上の言葉を含んでいても、接続し直して直るものではない
 */
const NOT_LOST_MARKS: readonly string[] = [
  // 自分で押した「中止」
  "中止しました",
  // 接続そのものが開いていない (タブから接続し直す必要があり、ここでは直せない)
  "接続されていません",
  // 保存したパスワードが読めない (設定の問題)
  "パスワード",
];

/**
 * MySQL の SQLSTATE が 08 (接続の異常) で始まるか。
 * sqlx は「1053 (08S01): Server shutdown in progress」の形で出す
 */
const MYSQL_CONN_STATE = /\(08[0-9a-z]{3}\)/i;

/** そのエラーが「接続が切れた」種類か */
export function isConnectionLost(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if (NOT_LOST_MARKS.some((w) => m.includes(w))) return false;
  if (MYSQL_CONN_STATE.test(message)) return true;
  return LOST_MARKS.some((w) => m.includes(w));
}

/*
 * ---------- タブごとの「切断」の印 ----------
 * 画面のどこからでも読めるように、React の外に1つだけ持つ
 */

/** 切断の印 (どのエラーで切れたと判断したか) */
export interface LostInfo {
  /** 失敗したときのエラー */
  message: string;
  /** 「接続し直す」を押して確かめている最中か */
  checking: boolean;
}

let lost: ReadonlyMap<string, LostInfo> = new Map();
const listeners = new Set<() => void>();

function update(next: Map<string, LostInfo>) {
  lost = next;
  listeners.forEach((f) => f());
}

/** 変わったら呼んでもらう (戻り値で解除) */
export function subscribeLost(f: () => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** 今の印の一覧 (変わるたびに別の Map になる) */
export function lostSnapshot(): ReadonlyMap<string, LostInfo> {
  return lost;
}

/** 切断の印を付ける */
export function markLost(sessionId: string, message: string) {
  const cur = lost.get(sessionId);
  if (cur && cur.message === message && !cur.checking) return;
  const next = new Map(lost);
  next.set(sessionId, { message, checking: false });
  update(next);
}

/** 切断の印を消す (操作が成功した・タブを閉じた) */
export function clearLost(sessionId: string) {
  if (!lost.has(sessionId)) return;
  const next = new Map(lost);
  next.delete(sessionId);
  update(next);
}

/** 「接続し直す」を押して確かめている最中にする */
export function markChecking(sessionId: string) {
  const cur = lost.get(sessionId);
  if (!cur || cur.checking) return;
  const next = new Map(lost);
  next.set(sessionId, { ...cur, checking: true });
  update(next);
}

/**
 * 成功したら印を消すコマンド。
 * 実際に接続を使うものだけにする (接続を使わずに答えるコマンドが
 * 成功しても、接続が戻ったことにはならない)
 */
const CLEAR_ON_SUCCESS: ReadonlySet<string> = new Set([
  "check_connection",
  "connect_session",
  "disconnect_session",
  "run_query",
  "list_tables",
  "table_detail",
  "count_table_rows",
  "schema_columns",
  "list_schemas",
  "kv_scan",
  "kv_key_detail",
  "kv_exec",
  "kv_apply",
]);

/** 印を付けないコマンド (接続する前の操作・中止) */
const NEVER_MARK: ReadonlySet<string> = new Set([
  "connect_session",
  "test_connection",
  "disconnect_session",
  "cancel_query",
  "kv_cancel",
]);

/** 結果の中にエラーを入れて返すコマンド (SQL・Valkey の実行) の、そのエラー */
function errorInResult(value: unknown): string | null {
  if (value && typeof value === "object" && "error" in value) {
    const e = (value as { error?: unknown }).error;
    return typeof e === "string" ? e : null;
  }
  return null;
}

/**
 * コマンドの結果を見て、切断の印を付けたり消したりする。
 * 呼び出しの結果はそのまま返す (見るだけで変えない)
 */
export function watchSession<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  pending: Promise<T>,
): Promise<T> {
  const sessionId = args?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return pending;
  return pending.then(
    (value) => {
      const err = errorInResult(value);
      if (err && isConnectionLost(err)) {
        if (!NEVER_MARK.has(name)) markLost(sessionId, err);
      } else if (err?.includes("中止しました")) {
        // 中止しただけでは、接続が生きているかは分からない (印はそのまま)
      } else if (CLEAR_ON_SUCCESS.has(name)) {
        clearLost(sessionId);
      }
      return value;
    },
    (e: unknown) => {
      const msg = String(e);
      if (!NEVER_MARK.has(name) && isConnectionLost(msg)) {
        markLost(sessionId, msg);
      } else if (name === "check_connection") {
        // 「接続し直す」が切断以外の理由で失敗したときも、押せる状態に戻す
        const cur = lost.get(sessionId);
        if (cur) markLost(sessionId, msg);
      }
      throw e;
    },
  );
}
