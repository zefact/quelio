/**
 * SSH踏み台のホスト鍵の確認 (初回接続・鍵が変わったとき) の扱い。
 *
 * バックエンドは、記録の無いホスト鍵や記録と違うホスト鍵に出会うと接続を中止し、
 * エラーの1行目にしるしを入れて返す。ここではその1行を読み解く
 */

/** エラーの1行目に入るしるし (known_hosts.rs と合わせる) */
const UNKNOWN_MARK = "SSH_HOST_UNKNOWN";
const CHANGED_MARK = "SSH_HOST_CHANGED";

export interface SshHostAsk {
  /** 初めて見た鍵か、記録と違う鍵か */
  kind: "unknown" | "changed";
  host: string;
  port: number;
  /** 今回の鍵 (SHA256:… の形) */
  fingerprint: string;
  /** 記録済みの鍵 (鍵が変わったときだけ) */
  stored: string | null;
  /** 画面に出す本文 (しるしの行を除いたもの) */
  message: string;
}

/**
 * ホスト鍵の確認が要るエラーなら中身を取り出す。
 * それ以外のエラーなら null
 */
export function parseHostAsk(error: string): SshHostAsk | null {
  const [head, ...rest] = error.split("\n");
  const parts = head.split("\t");
  const kind =
    parts[0] === UNKNOWN_MARK
      ? "unknown"
      : parts[0] === CHANGED_MARK
        ? "changed"
        : null;
  if (!kind) return null;
  // 鍵が変わったときは、記録済みの値も入っていなければならない
  if (parts.length < (kind === "changed" ? 5 : 4)) return null;
  const port = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(port)) return null;
  return {
    kind,
    host: parts[1],
    port,
    fingerprint: parts[3],
    stored: kind === "changed" ? parts[4] : null,
    message: rest.join("\n").trim(),
  };
}

/** 画面に出すとき用に、しるしの行を取り除く */
export function stripHostMark(error: string): string {
  const found = parseHostAsk(error);
  return found ? found.message : error;
}
