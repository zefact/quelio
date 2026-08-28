/** 進捗の取得・中止に使うIDを作る (同時に走らせても衝突しない程度の乱数) */
export function newJobId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
