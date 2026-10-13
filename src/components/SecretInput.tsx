import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "./ConfirmDialog";

/** 保存済みの値を見せておく時間。過ぎたら伏せ、取り出した値も手放す */
const REVEAL_MS = 30_000;

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 読み上げ用の名前 (例: パスワード) */
  label: string;
  /**
   * 保存済みの値を取り出す (保存済みのときだけ渡す)。
   *
   * 欄が空 (= 保存済みのまま) のときに目のボタンを押すと、確認のあとでこれを呼ぶ
   */
  onReveal?: () => Promise<string>;
}

/**
 * 伏せ字の入力欄 (右の目のボタンで表示・非表示を切り替える)。
 *
 * 入力した文字は、そのまま表示・非表示を切り替える。
 * 保存済みの値は画面に読み込んでいないので、見るときだけ確認してから取り出し、
 * 30秒たつか伏せたら手放す (取り出したまま覚えておかない)。
 * 表示中に書き換えたら、それが新しい値になる
 */
export function SecretInput({
  value,
  onChange,
  placeholder,
  label,
  onReveal,
}: Props) {
  const [shown, setShown] = useState(false);
  /** 取り出した保存済みの値 (見せている間だけ持つ) */
  const [revealed, setRevealed] = useState<string | null>(null);
  /** 保存済みの値を見せるかの確認を出しているか */
  const [asking, setAsking] = useState(false);

  // 保存済みの値は、しばらくしたら伏せて手放す
  useEffect(() => {
    if (revealed === null) return;
    const t = window.setTimeout(() => {
      setRevealed(null);
      setShown(false);
    }, REVEAL_MS);
    return () => window.clearTimeout(t);
  }, [revealed]);

  const typed = value !== "";
  /** 欄に出す文字 (入力が無ければ、取り出した保存済みの値) */
  const text = typed ? value : (revealed ?? "");
  const visible = shown && text !== "";
  /** 保存済みの値を取り出せる状態か (まだ何も入力していないとき) */
  const canReveal = !typed && !!onReveal;

  const hide = () => {
    setShown(false);
    setRevealed(null);
  };

  const toggle = () => {
    if (visible) {
      hide();
      return;
    }
    if (typed) {
      setShown(true);
      return;
    }
    if (canReveal) setAsking(true);
  };

  const tip = visible
    ? `${label}を隠す`
    : typed
      ? `${label}を表示`
      : canReveal
        ? `保存済みの${label}を表示 (確認のあと30秒だけ)`
        : placeholder
          ? `保存済みの${label}を表示できません`
          : "入力すると表示できます";

  return (
    <span className="key-path-row secret-input">
      <input
        className="mono"
        type={visible ? "text" : "password"}
        value={visible ? text : value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          const next = e.target.value;
          // 書き換えたら、それが新しい値。取り出した保存済みの値は手放す
          setRevealed(null);
          if (next === "") setShown(false);
          onChange(next);
        }}
      />
      <button
        type="button"
        className="browse-btn secret-eye has-tooltip"
        data-tooltip={tip}
        aria-label={visible ? `${label}を隠す` : `${label}を表示`}
        aria-pressed={visible}
        disabled={!typed && !canReveal}
        onClick={toggle}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>

      {/*
        確認はラベルの外 (body 直下) に出す。
        ラベルの中に置くと、確認の中を押したときに欄へフォーカスが移ってしまう
      */}
      {asking &&
        onReveal &&
        createPortal(
          <ConfirmDialog
            title={`保存済みの${label}を表示します`}
            confirmLabel="表示する"
            defaultFocus="cancel"
            onConfirm={async () => {
              const secret = await onReveal();
              setRevealed(secret);
              setShown(true);
              setAsking(false);
            }}
            onCancel={() => setAsking(false)}
          >
            画面に{label}をそのまま表示します。周りから見えないか確かめてください。
            <br />
            30秒たつと自動で伏せます。
          </ConfirmDialog>,
          document.body
        )}
    </span>
  );
}

/** 目 (押すと表示する) */
function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** 斜線の入った目 (押すと隠す) */
function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3 4M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
