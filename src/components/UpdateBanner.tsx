import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate, checkUpdateRisk, installUpdate } from "../updater";
import type { UpdateRisk } from "../updater";
import { CloseMark } from "./CloseMark";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconButton } from "./IconButton";

/**
 * 更新して再起動する前の確認。
 *
 * 再起動で接続が切れると、確定していない変更はサーバー側で取り消される。
 * 窓を閉じるときと同じ確認を、更新の入口 (帯と設定画面) でも出す
 */
export function UpdateRiskConfirm({
  risk,
  onCancel,
  onConfirm,
}: {
  risk: UpdateRisk;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title={risk.busy ? "SQLの実行中です" : "未確定の変更が残っています"}
      target={risk.names.join(" / ")}
      confirmLabel="取り消して再起動"
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {risk.busy
        ? "SQLを実行中か、トランザクションが開いたままの接続があります。"
        : "トランザクションが開いたままの接続があります。"}
      再起動すると接続が切れ、確定していない変更はサーバー側で取り消されます。
      残したい場合は、いったんキャンセルして画面下の「確定」を押してから更新してください。
    </ConfirmDialog>
  );
}

/**
 * 起動時にアップデートを確認し、あればタブバーのすぐ下に帯で知らせる。
 * 「更新して再起動」でダウンロード→インストール→自動再起動する。
 *
 * 帯にするのは、浮かせて出すとツールバーのボタンに重なって押せなくなるため
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  /** 未確定の変更がある接続 (確認を出している間だけ入る) */
  const [risk, setRisk] = useState<UpdateRisk | null>(null);

  useEffect(() => {
    // 起動直後の確認は失敗しても静かに諦める (オフライン等)
    checkForUpdate()
      .then((u) => setUpdate(u))
      .catch(() => {});
  }, []);

  if (!update || dismissed) return null;

  const install = async () => {
    setDownloading(true);
    setError(null);
    try {
      await installUpdate(update, setPercent);
    } catch (e) {
      setDownloading(false);
      setError(`更新に失敗しました: ${e}`);
    }
  };

  /** 未確定の変更が残っていれば、先に確認を出す */
  const requestInstall = async () => {
    const found = await checkUpdateRisk();
    if (found.names.length > 0) {
      setRisk(found);
      return;
    }
    await install();
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-text">
        新しいバージョン <strong className="mono">v{update.version}</strong>{" "}
        が利用できます
      </span>
      {error && <span className="update-banner-error">{error}</span>}
      <span className="toolbar-spacer" />
      {downloading ? (
        <span className="update-banner-progress mono">
          <span className="spinner accent" />
          {percent === null ? "ダウンロード中…" : `ダウンロード中 ${percent}%`}
        </span>
      ) : (
        <>
          <button
            className="btn-primary update-banner-btn"
            onClick={() => void requestInstall()}
          >
            更新して再起動
          </button>
          <IconButton
            className="update-banner-close"
            label="閉じる (次に起動したときにまた知らせます)"
            onClick={() => setDismissed(true)}
          >
            <CloseMark size={12} />
          </IconButton>
        </>
      )}

      {risk && (
        <UpdateRiskConfirm
          risk={risk}
          onCancel={() => setRisk(null)}
          onConfirm={() => {
            setRisk(null);
            void install();
          }}
        />
      )}
    </div>
  );
}
