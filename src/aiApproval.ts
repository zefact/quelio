/**
 * AIからの「更新してよいか」の待ち行列。
 *
 * 同じときに複数来ても、ダイアログは1件ずつ出す
 * (まとめて出すと、どれに答えたのか分からなくなる)。
 *
 * 画面とは関係のない並びの話なので、ここに分けて試せるようにしてある
 */

/** ダイアログに出す1件 (Rust側の PendingView と対) */
export interface AiApproval {
  requestId: string;
  /** 接続名 */
  connection: string;
  /** 環境ラベル ("prod" / "staging" / "dev"。未設定なら null) */
  env: string | null;
  /** 対象のデータベース (空なら既定) */
  database: string;
  /** 実行しようとしているSQL (全文) */
  sql: string;
  /** 取り返しのつかないSQLの判定 */
  dangerous: { kind: string; sql: string; definitionChange: boolean }[];
  /** 残り何秒待つか */
  remainingSecs: number;
}

/** 今出すもの (無ければ null) */
export function current(queue: AiApproval[]): AiApproval | null {
  return queue[0] ?? null;
}

/**
 * 待ち行列へ足す。
 *
 * 同じ目印のものは足さない。
 * イベントと「取り直し」(`mcp_pending_approvals`) の両方から来るので、
 * そのままだと同じ要求が二重に並ぶ
 */
export function add(queue: AiApproval[], item: AiApproval): AiApproval[] {
  if (queue.some((q) => q.requestId === item.requestId)) return queue;
  return [...queue, item];
}

/** 取り直した一覧を混ぜる (来た順は保ったまま、知らないものだけ足す) */
export function merge(queue: AiApproval[], items: AiApproval[]): AiApproval[] {
  return items.reduce(add, queue);
}

/** 答えた・時間切れになったものを外す */
export function remove(queue: AiApproval[], requestId: string): AiApproval[] {
  return queue.filter((q) => q.requestId !== requestId);
}

/**
 * 残り秒数を1つ減らす。
 *
 * 0になったものは呼び出し側が外す (ここでは減らすだけにして、
 * 「消えた理由」を画面側が知れるようにする)
 */
export function tick(queue: AiApproval[]): AiApproval[] {
  return queue.map((q) =>
    q.remainingSecs > 0 ? { ...q, remainingSecs: q.remainingSecs - 1 } : q,
  );
}

/** 時間切れになったもの (残り0) */
export function expired(queue: AiApproval[]): AiApproval[] {
  return queue.filter((q) => q.remainingSecs <= 0);
}
