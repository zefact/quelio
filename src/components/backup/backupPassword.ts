/**
 * 接続一覧のバックアップに入れるパスワードの決まり (バックエンドの MIN_PASSWORD_LEN と同じ)
 */

/** バックアップのパスワードの最短の長さ */
export const MIN_BACKUP_PASSWORD = 8;

/** 入力の不足を返す (問題なければ null) */
export function backupPasswordProblem(
  password: string,
  confirm: string
): string | null {
  if ([...password].length < MIN_BACKUP_PASSWORD) {
    return `パスワードは${MIN_BACKUP_PASSWORD}文字以上にしてください`;
  }
  if (password !== confirm) return "確認用のパスワードが一致しません";
  return null;
}
