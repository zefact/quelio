/**
 * ユーザー (PostgreSQL ではロール) を新しく作る画面。
 *
 * 入れられる項目はDBの種類で違う。
 * MySQL は「どこから接続してよいか」まで決めて1人になり、
 * PostgreSQL は「ログインできるか」「何を作れるか」を属性で決める
 */
import { useState } from "react";
import type { NewDbUser } from "../../types";
import { ModalFrame } from "../ModalFrame";

interface Props {
  /** PostgreSQL か */
  pg: boolean;
  /** 決まった内容を渡す (実行はしない。次の確認でSQLを見せる) */
  onDecide: (spec: NewDbUser) => void;
  onCancel: () => void;
}

const EMPTY: NewDbUser = {
  name: "",
  host: "%",
  password: "",
  canLogin: true,
  createRole: false,
  createDb: false,
  connLimit: "",
  expires: "",
};

export function UserForm({ pg, onDecide, onCancel }: Props) {
  const [spec, setSpec] = useState<NewDbUser>(EMPTY);

  const put = (v: Partial<NewDbUser>) => setSpec((s) => ({ ...s, ...v }));
  const word = pg ? "ロール" : "ユーザー";

  const go = () => {
    if (!spec.name.trim()) return;
    onDecide({ ...spec, name: spec.name.trim() });
  };

  return (
    <ModalFrame
      title={`${word}を作成`}
      onClose={onCancel}
      className="dbusers-form"
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel}>
            キャンセル
          </button>
          <button
            className="btn-primary has-tooltip"
            onClick={go}
            disabled={!spec.name.trim()}
            data-tooltip={!spec.name.trim() ? "名前を入れてください" : undefined}
          >
            次へ
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="span2">
          <span className="field-label">名前</span>
          <input
            className="text-field"
            autoFocus
            value={spec.name}
            spellCheck={false}
            onChange={(e) => put({ name: e.target.value })}
          />
        </label>

        {!pg && (
          <label className="span2">
            <span className="field-label">接続元</span>
            <input
              className="text-field mono"
              value={spec.host}
              spellCheck={false}
              placeholder="%"
              onChange={(e) => put({ host: e.target.value })}
            />
            <span className="field-note">
              どこから接続してよいか。`%` はどこからでも、
              `localhost` はサーバー上からだけ。名前と合わせて1人になります
            </span>
          </label>
        )}

        <label className="span2">
          <span className="field-label">パスワード</span>
          <input
            className="text-field"
            type="password"
            value={spec.password}
            spellCheck={false}
            onChange={(e) => put({ password: e.target.value })}
          />
          <span className="field-note">
            空のままにすると、パスワード無しで作成します。
            入力した値はSQLの記録には残しません
          </span>
        </label>
      </div>

      {/* ふだんは既定のままでよい項目は畳んでおく */}
      <details className="dbusers-more">
        <summary className="dbusers-more-summary">詳細設定</summary>
        <div className="form-grid">
          {pg && (
            <div className="form-field span2">
              <span className="field-label">できること</span>
              <div className="dbusers-checks">
                <label className="dbusers-check">
                  <input
                    type="checkbox"
                    checked={spec.canLogin}
                    onChange={(e) => put({ canLogin: e.target.checked })}
                  />
                  ログインできる
                </label>
                <label className="dbusers-check">
                  <input
                    type="checkbox"
                    checked={spec.createDb}
                    onChange={(e) => put({ createDb: e.target.checked })}
                  />
                  データベースを作成できる
                </label>
                <label className="dbusers-check">
                  <input
                    type="checkbox"
                    checked={spec.createRole}
                    onChange={(e) => put({ createRole: e.target.checked })}
                  />
                  ロールを作成できる
                </label>
              </div>
              <span className="field-note">
                ログインできないロールは、権限をまとめるグループとして使えます
              </span>
            </div>
          )}

          <label className="span2">
            <span className="field-label">同時接続の上限</span>
            <input
              className="text-field mono"
              value={spec.connLimit}
              spellCheck={false}
              placeholder="決めない"
              onChange={(e) => put({ connLimit: e.target.value })}
            />
          </label>

          {pg && (
            <label className="span2">
              <span className="field-label">有効期限</span>
              <input
                className="text-field mono"
                value={spec.expires}
                spellCheck={false}
                placeholder="2027-01-01 (決めない場合は空)"
                onChange={(e) => put({ expires: e.target.value })}
              />
            </label>
          )}
        </div>
      </details>
    </ModalFrame>
  );
}
