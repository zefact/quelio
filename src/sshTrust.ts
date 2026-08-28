/**
 * SSH踏み台の初回接続 (ホスト鍵の確認) の扱い。
 *
 * バックエンドは、記録の無いホスト鍵に出会うと接続を中止し、
 * エラーの1行目にしるしを入れて返す。ここではその1行を読み解く
 */

/** エラーの1行目に入るしるし (known_hosts.rs と合わせる) */
const MARK = "SSH_HOST_UNKNOWN";

export interface UnknownSshHost {
  host: string;
  port: number;
  /** SHA256:… の形 */
  fingerprint: string;
  /** 画面に出す本文 (しるしの行を除いたもの) */
  message: string;
}

/**
 * 初回接続のエラーなら中身を取り出す。
 * それ以外のエラーなら null
 */
export function parseUnknownHost(error: string): UnknownSshHost | null {
  const [head, ...rest] = error.split("\n");
  const parts = head.split("\t");
  if (parts[0] !== MARK || parts.length < 4) return null;
  const port = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(port)) return null;
  return {
    host: parts[1],
    port,
    fingerprint: parts[3],
    message: rest.join("\n").trim(),
  };
}

/** 画面に出すとき用に、しるしの行を取り除く */
export function stripHostMark(error: string): string {
  const found = parseUnknownHost(error);
  return found ? found.message : error;
}
