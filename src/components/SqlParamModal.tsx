import { useEffect, useState } from "react";
import {
  PARAM_KINDS,
  ParamKind,
  ParamValue,
} from "../sqlParams";
import { checkDangerousFilled, previewSql } from "../api";
import type { DangerousStatement, DbType } from "../types";
import { SelectMenu } from "./SelectMenu";

interface Props {
  /** パラメータ名 (SQL中の出現順) */
  params: string[];
  /** 前回使用した値・スキーマから推測した型などの初期値 */
  initial: Record<string, ParamValue>;
  /** 実行するSQL (置換後のプレビューに使う) */
  sql: string;
  /** プレビューを組み立てる接続 */
  sessionId: string;
  dbType: DbType;
  onCancel: () => void;
  onSubmit: (values: Record<string, ParamValue>) => void;
}

/** SQL実行前のパラメータ入力モーダル */
export function SqlParamModal({
  params,
  initial,
  sql,
  sessionId,
  dbType,
  onCancel,
  onSubmit,
}: Props) {
  const [values, setValues] = useState<Record<string, ParamValue>>(() => ({
    ...initial,
  }));

  const set = (name: string, patch: Partial<ParamValue>) =>
    setValues((prev) => {
      const cur = prev[name] ?? { value: "", kind: "auto" as ParamKind };
      return { ...prev, [name]: { ...cur, ...patch } };
    });

  /**
   * 値を入れて初めて「確認の要るSQL」になったもの。
   *
   * 「そのまま」「数値」の値はクォートされずに入るので、
   * `WHERE :cond` に `1=1` を入れると全件更新に変わる。
   * プレースホルダのままの判定では気づけないため、置換後にもう一度見る
   */
  const [danger, setDanger] = useState<DangerousStatement[]>([]);
  /*
   * 確認済みの警告の中身。
   * 「確認した」という真偽値だけで覚えると、値を書き換えて
   * 別の警告に変わったときにチェックが付いたままになる
   */
  const dangerKey = danger.map((d) => `${d.kind}\u0000${d.sql}`).join("\u0001");
  const [agreedFor, setAgreedFor] = useState("");
  const agreed = danger.length > 0 && agreedFor === dangerKey;

  const blocked = danger.length > 0 && !agreed;
  const submit = () => {
    if (blocked) return;
    onSubmit(values);
  };

  /**
   * 実際に実行されるSQL。
   *
   * 埋め込みはバックエンドで行うため、プレビューも同じ処理に組み立てさせる
   * (画面側で作り直すと、見えている内容と実際に走る内容がずれる)
   */
  const [preview, setPreview] = useState(sql);
  useEffect(() => {
    let alive = true;
    // 入力のたびに投げないよう少し待つ
    const timer = window.setTimeout(() => {
      previewSql(sessionId, sql, dbType, values)
        .then((s) => {
          if (alive) setPreview(s);
        })
        .catch(() => {});
      // 値しだいで内容が変わるので、警告も同じ間隔で見直す
      checkDangerousFilled(sessionId, sql, dbType, values)
        .then((found) => {
          if (alive) setDanger(found);
        })
        .catch(() => {});
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [sessionId, sql, dbType, values]);

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div
        className="modal sqlp-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 日本語入力の変換中のEnter/Escは拾わない (確定・取り消しの操作のため)
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="modal-head">
          <span className="modal-title">パラメータの入力</span>
          <button className="modal-close" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="sqlp-grid">
          {params.map((p, i) => {
            const v = values[p] ?? { value: "", kind: "auto" as ParamKind };
            return (
              <div className="sqlp-row" key={p}>
                <span className="sqlp-name mono" title={p}>
                  {p}
                </span>
                <input
                  className="mono"
                  value={v.value}
                  autoFocus={i === 0}
                  onChange={(e) => set(p, { value: e.target.value })}
                />
                <div className="sqlp-kind">
                  <SelectMenu
                    value={v.kind}
                    popFixed
                    options={PARAM_KINDS.map(([kind, label]) => ({
                      value: kind,
                      label,
                    }))}
                    onChange={(kind) => set(p, { kind: kind as ParamKind })}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {/* 埋め込みは文字列置換なので、実行前に必ず結果を見せる */}
        <div className="sqlp-preview">
          <div className="sqlp-preview-head">実行されるSQL</div>
          <pre className="mono sqlp-preview-body">{preview}</pre>
        </div>
        {danger.length > 0 && (
          <div className="sqlp-danger">
            <div className="sqlp-danger-head">
              入力した値によって、取り返しのつかないSQLになっています
            </div>
            <ul className="sqlp-danger-list">
              {danger.map((d, i) => (
                <li key={i}>
                  <span className="sqlp-danger-kind">{d.kind}</span>
                  <span className="mono sqlp-danger-sql">{d.sql}</span>
                </li>
              ))}
            </ul>
            <label className="sqlp-danger-agree">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreedFor(e.target.checked ? dangerKey : "")}
              />
              内容を確認しました
            </label>
          </div>
        )}
        <div className="sqlp-hint">
          型はカラム定義から自動判定されます (右のプルダウンで変更可能)。
          「文字列」は常に ' ' 付き、「数値」「そのまま」は入力どおりに
          埋め込まれます。値と型は保存され、次回から初期値になります。
        </div>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel}>
            キャンセル
          </button>
          <button
            className={danger.length > 0 ? "btn-danger" : "btn-primary"}
            disabled={blocked}
            title={blocked ? "上の内容を確認してください" : undefined}
            onClick={submit}
          >
            実行
          </button>
        </div>
      </div>
    </div>
  );
}
