/**
 * AIが書いたSQLを、どのタブのシートへ置くかを決める待ち行列。
 *
 * イベントが来た時点では、その接続のタブが開いていないことがある
 * (これから繋ぐ場合・実行中で触れない場合)。
 * 置けるようになるまで預かっておき、置ける状態になったら渡す。
 *
 * 画面から切り離して試せるよう、判断だけをここに置く
 */

/** Rust から届く中身 (`mcp-open-sql`) */
export interface OpenSqlEvent {
  /** 要求ごとの番号 (同じものを二度置かないため) */
  id: string;
  /** 置き先の接続 (保存済みプロファイルのID) */
  profileId: string;
  /** 接続名 (画面に出す用) */
  connection: string;
  /** AIが想定しているDB (無ければ null) */
  database: string | null;
  sql: string;
  /** シート名 */
  title: string;
}

/** 預かっている要求 */
export interface Queued {
  req: OpenSqlEvent;
  /** 受け取った時刻 (epoch ms) */
  at: number;
  /**
   * この接続へ繋ぎにいったか。
   *
   * 繋ぎにいった後で「繋がっても繋ぎ中でもない」状態に戻っていたら、
   * その試みは失敗している。覚えておく場所を要求そのものにすることで、
   * 要求を捨てたときに一緒に忘れられる
   * (画面の外に覚えておくと、失敗した接続が二度と試されなくなる)
   */
  tried: boolean;
}

/** 預かる数の上限 (溜め込んでも古いものは使われない) */
export const MAX_QUEUED = 5;

/**
 * 預かったままにする時間。
 *
 * 繋がらないまま忘れられた要求が、何時間も経ってから
 * 突然シートに現れないようにする
 */
export const EXPIRE_MS = 10 * 60 * 1000;

/** タブの状態 (置けるかどうかの判断に要るぶんだけ) */
export interface TabRef {
  key: string;
  profileId: string;
  connected: boolean;
  /** 実行中 (シートを動かせない) */
  running: boolean;
  /**
   * 接続の手続きの最中か。
   *
   * 本番の確認ダイアログ・SSHホスト鍵の確認で止まっている間も含む。
   * ここを見ないと、利用者が手で繋いでいるタブに重ねて繋ぎにいってしまう
   */
  connecting: boolean;
}

/** 置き先が決まった要求 */
export interface Ready {
  key: string;
  req: OpenSqlEvent;
}

/** 置けずに捨てた要求 (利用者へ知らせる) */
export type Dropped = OpenSqlEvent;

/** 受け取ったものを預かる (同じ番号は足さない・古いものから捨てる) */
export function add(
  queue: Queued[],
  req: OpenSqlEvent,
  now: number,
): Queued[] {
  if (queue.some((q) => q.req.id === req.id)) return queue;
  return [...queue, { req, at: now, tried: false }].slice(-MAX_QUEUED);
}

/** その接続のタブがあるか (繋がっている / 繋ぎにいっている最中) */
function busyWith(tabs: TabRef[], profileId: string): boolean {
  return tabs.some(
    (t) => t.profileId === profileId && (t.connected || t.connecting),
  );
}

/**
 * 置けるものを取り出す。
 *
 * - 繋がっていて実行中でないタブがあれば、そこへ置く
 * - 繋ぎにいっている最中・実行中なら預かったまま待つ
 * - 繋ぎにいったのに繋がらなかったものと、時間切れのものは捨てる
 *   (黙って消すと、AIには「置いた」と返っているので誰も気づけない)
 *
 * 待つ判定を先に置く。本番の確認ダイアログを長く開いたままにしてから
 * 「接続する」を押すと、接続中なのに時間切れが先に立ってしまう
 */
export function drain(
  queue: Queued[],
  tabs: TabRef[],
  now: number,
): { ready: Ready[]; rest: Queued[]; dropped: Dropped[] } {
  const ready: Ready[] = [];
  const rest: Queued[] = [];
  const dropped: Dropped[] = [];
  for (const q of queue) {
    const tab = tabs.find(
      (t) => t.profileId === q.req.profileId && t.connected && !t.running,
    );
    if (tab) {
      ready.push({ key: tab.key, req: q.req });
      continue;
    }
    // 手続きの最中なら、終わるまで待つ (期限は延ばさず、ただ待つ)
    if (busyWith(tabs, q.req.profileId)) {
      rest.push(q);
      continue;
    }
    if (now - q.at >= EXPIRE_MS) {
      dropped.push(q.req);
      continue;
    }
    // 繋ぎにいった後に手が空いているなら、その試みは失敗している
    if (q.tried) {
      dropped.push(q.req);
      continue;
    }
    rest.push(q);
  }
  return { ready, rest, dropped };
}

/**
 * これから繋ぐ必要がある接続 (重複なし)。
 *
 * 繋がっているタブも繋ぎ中のタブも無く、まだ繋ぎにいっていないものだけ。
 * 一度試したものは `drain` が捨てるので、ここでは返さない
 */
export function needsConnect(queue: Queued[], tabs: TabRef[]): string[] {
  const ids: string[] = [];
  for (const q of queue) {
    const id = q.req.profileId;
    if (ids.includes(id) || q.tried) continue;
    if (busyWith(tabs, id)) continue;
    ids.push(id);
  }
  return ids;
}

/** その接続へ繋ぎにいったことを控える */
export function markTried(queue: Queued[], profileId: string): Queued[] {
  return queue.map((q) =>
    q.req.profileId === profileId && !q.tried ? { ...q, tried: true } : q,
  );
}

/** その接続の要求を捨てる (保存済み接続が見つからないときなど) */
export function forget(queue: Queued[], profileId: string): Queued[] {
  return queue.filter((q) => q.req.profileId !== profileId);
}

/**
 * AIが指定してきたDBを、SQLの先頭に控えておく。
 *
 * タブのDBを切り替えられたかどうかに関わらず、
 * 「どのDBのつもりで書かれたSQLか」を人が読めるようにする
 */
export function withDatabaseNote(
  sql: string,
  database: string | null,
  switched: boolean,
): string {
  if (!database) return sql;
  const note = switched
    ? `-- 対象DB: ${database}`
    : `-- 対象DB: ${database} (このタブでは選べませんでした)`;
  return `${note}\n${sql}`;
}
