import type { ReactNode } from "react";
import { envColor, envLabel } from "../types";

/**
 * 「本番」のバッジ。
 *
 * 色は `envColor` の本番色をそのまま使う (色を増やさない)。
 * 確認ダイアログの見出しに足して、どの環境に対する操作なのかを示す
 */
export function ProdBadge() {
  return (
    <span className="env-badge" style={{ background: envColor("prod") }}>
      {envLabel("prod")}
    </span>
  );
}

/**
 * 確認ダイアログの本文に出す、本番の1行 (バッジ + 短い文)。
 * 何をどこに対して行うのかが1行で分かるようにする
 */
export function ProdNote({ children }: { children: ReactNode }) {
  return (
    <span className="prod-note">
      <ProdBadge />
      {children}
    </span>
  );
}
