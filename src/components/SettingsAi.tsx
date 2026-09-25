import { useEffect, useState } from "react";
import type { Notify } from "../notify";
import {
  listConnections,
  mcpApply,
  mcpEndpoint,
  mcpExePath,
  mcpRegenerateToken,
  mcpStatus,
  mcpToken,
  saveConnection,
} from "../api";
import {
  claudeCodeSnippet,
  claudeDesktopSnippet,
  CONFIG_PATHS,
  httpClientSnippet,
  maskToken,
} from "../mcpSnippets";
import type { AiAccess, ConnectionProfile, DbType, McpStatus } from "../types";
import { AI_ACCESS, envColor, envLabel } from "../types";
import { SelectMenu } from "./SelectMenu";
import { useAppSettings } from "../hooks/useAppSettings";
import { SettingRow } from "./SettingRow";
import { ConfirmDialog } from "./ConfirmDialog";
import { writeClipboard } from "../gridCopy";
import { imeBusy } from "../ime";

interface Props {
  notify: Notify;
}

/** ポートとして受け付ける範囲 (よく使われる1024未満は避ける) */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/**
 * 設定 > AI連携 (MCPサーバー)。
 *
 * Quelio自身をMCPサーバーにして、利用者が使っているAIクライアントから
 * 「Quelio経由で」DBを触れるようにする。
 * AI側に接続情報は渡さない (AIが知るのは接続名だけ) ので、
 * ここで渡すのはエンドポイントとトークンだけになる
 */
export function SettingsAi({ notify }: Props) {
  const { app, setApp, saveApp } = useAppSettings(notify);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState("");
  const [endpoint, setEndpoint] = useState("");
  /** トークンを伏せ字から出しているか */
  const [shown, setShown] = useState(false);
  /** 作り直しの確認中 */
  const [confirming, setConfirming] = useState(false);
  /** ポートの入力中の値 (確定は「適用」で行う) */
  const [portDraft, setPortDraft] = useState<string | null>(null);
  /** 接続の一覧 (公開レベルをここからも変えられるようにする) */
  const [conns, setConns] = useState<ConnectionProfile[]>([]);
  /** このアプリの実行ファイルのパス (Claude Desktop の設定に書く) */
  const [exePath, setExePath] = useState("");

  const loadConns = () => {
    listConnections()
      .then((store) => setConns(store.connections))
      .catch((e) => notify(`接続一覧を読めません: ${e}`, "error"));
  };

  const reload = () => {
    mcpStatus()
      .then(setStatus)
      .catch((e) => notify(`AI連携の状態を読めません: ${e}`, "error"));
    mcpEndpoint()
      .then(setEndpoint)
      .catch(() => {});
  };

  useEffect(() => {
    reload();
    loadConns();
    mcpExePath()
      .then(setExePath)
      .catch(() => {
        /* 取れなくても、他のスニペットは出せる */
      });
    mcpToken()
      .then(setToken)
      .catch((e) => notify(`トークンを読めません: ${e}`, "error"));
    // 開いたときに1回だけ読む (通知の関数は毎回作り直されるので依存に入れない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 設定を保存してから待受を張り直す */
  const applyWith = async (patch: Partial<typeof app>) => {
    const next = { ...app, ...patch };
    setApp(next);
    await saveApp(next);
    try {
      setStatus(await mcpApply());
      setEndpoint(await mcpEndpoint());
    } catch (e) {
      notify(`AI連携を切り替えられません: ${e}`, "error");
    }
  };

  const copy = async (text: string, what = "設定") => {
    try {
      await writeClipboard(text);
      notify(`${what}をコピーしました`);
    } catch (e) {
      notify(`コピーできません: ${e}`, "error");
    }
  };

  /** 入力されたポートを確定する */
  const applyPort = async () => {
    if (portDraft === null) return;
    const n = Number(portDraft);
    if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
      notify(`ポートは ${MIN_PORT}〜${MAX_PORT} で指定してください`, "error");
      return;
    }
    setPortDraft(null);
    await applyWith({ mcpPort: n });
  };

  /**
   * 公開レベルを変えて保存する。
   *
   * 既存の接続保存の経路をそのまま使う
   * (パスワードは伏せたまま往復し、バックエンドが補う)
   */
  const changeAccess = async (c: ConnectionProfile, aiAccess: AiAccess) => {
    try {
      await saveConnection({ ...c, aiAccess });
      loadConns();
      notify(`「${c.name}」の公開を変更しました`);
    } catch (e) {
      notify(`変更できません: ${e}`, "error");
    }
  };

  /** Valkeyは第1弾の対象外 (SQLを書くDBだけを公開する) */
  const canExpose = (dbType: DbType) => dbType !== "valkey";

  const exposed = conns.filter(
    (c) => canExpose(c.dbType) && (c.aiAccess ?? "none") !== "none",
  ).length;

  /** 状態の1行説明 */
  const state = !app.mcpEnabled
    ? { label: "停止", cls: "off" }
    : status?.running
      ? { label: "待受中", cls: "on" }
      : { label: "エラー", cls: "ng" };

  return (
    <>
      <section className="set-section">
        <h3 className="set-section-title">AI連携 (MCPサーバー)</h3>
        <p className="set-section-note">
          Quelio を MCP サーバーにして、お使いのAIクライアント (Claude Code /
          Claude Desktop / Cursor など) から Quelio
          経由でDBを参照・操作できるようにします。
          <b>AI側には接続情報・パスワード・SSHの設定を一切渡しません</b>
          (AIが知るのは接続名だけです)。
          公開するのは、接続ごとに「AIへ公開」を設定したものだけです。
          待受は同じPCの中 (127.0.0.1)
          のみで、アプリを起動している間だけ動きます。
        </p>

        <SettingRow
          title="AI連携を有効にする"
          desc="有効にすると、下のエンドポイントで待ち受けます。AIクライアントには、エンドポイントとトークンだけを設定してください。"
        >
          <label className="switch">
            <input
              type="checkbox"
              checked={app.mcpEnabled}
              onChange={(e) => void applyWith({ mcpEnabled: e.target.checked })}
            />
            <span className="track" aria-hidden />
          </label>
        </SettingRow>

        <SettingRow
          title="状態"
          desc={
            status?.error ??
            (app.mcpEnabled
              ? "AIクライアントからの接続を待っています。"
              : "止まっています。")
          }
        >
          <span className={"mcp-state " + state.cls}>{state.label}</span>
        </SettingRow>

        <SettingRow
          title="エンドポイント"
          desc="AIクライアントの設定に書くURLです。127.0.0.1 以外からは接続できません。"
          stack
        >
          <div className="mcp-field">
            <input className="filter-input mono" readOnly value={endpoint} />
            <button
              className="btn-secondary"
              onClick={() => void copy(endpoint, "エンドポイント")}
            >
              コピー
            </button>
          </div>
        </SettingRow>

        <SettingRow
          title="ポート"
          desc="他のアプリと重なると待ち受けできません。変えたら「適用」を押してください。"
          stack
        >
          <div className="mcp-field">
            <input
              className="filter-input mono mcp-port"
              type="number"
              min={MIN_PORT}
              max={MAX_PORT}
              value={portDraft ?? String(app.mcpPort)}
              onChange={(e) => setPortDraft(e.target.value)}
              onKeyDown={(e) => {
                if (imeBusy(e)) return;
                if (e.key === "Enter") void applyPort();
              }}
            />
            <button
              className="btn-primary"
              disabled={portDraft === null}
              onClick={() => void applyPort()}
            >
              適用
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">トークン</h3>
        <p className="set-section-note">
          AIクライアントは、このトークンを <code>Authorization: Bearer</code>{" "}
          ヘッダで送ります。<b>DBのパスワードではありません</b>が、
          これを持っていれば公開した接続を触れるので、扱いは同じにしてください。
        </p>
        <SettingRow
          title="Bearer トークン"
          desc="作り直すと、古いトークンはその場で使えなくなります (AIクライアント側の設定も直してください)。"
          stack
        >
          <div className="mcp-field">
            <input
              className="filter-input mono"
              readOnly
              type={shown ? "text" : "password"}
              value={token}
            />
            <button
              className="btn-secondary"
              onClick={() => setShown((v) => !v)}
            >
              {shown ? "隠す" : "表示"}
            </button>
            <button
              className="btn-secondary"
              onClick={() => void copy(token, "トークン")}
            >
              コピー
            </button>
            <button className="btn-danger" onClick={() => setConfirming(true)}>
              作り直す
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">AIクライアントの設定</h3>
        <p className="set-section-note">
          お使いのクライアントに合わせて、下の設定をコピーして貼ってください。
          <b>ポートとトークンは埋め込んであります</b>ので、書き換えは要りません
          (画面上は伏せてありますが、コピーされるのは実物です)。
        </p>
        {!status?.running && (
          <div className="mcp-snippet-warn">
            AI連携を有効にしてから設定してください
            (止まっている間は、クライアントから接続できません)。
          </div>
        )}

        <SettingRow
          title="Claude Code"
          desc="ターミナルでこのコマンドを1回実行すると登録されます。"
          stack
        >
          <Snippet
            real={claudeCodeSnippet(app.mcpPort, token)}
            shown={claudeCodeSnippet(app.mcpPort, maskToken(token))}
            onCopy={copy}
          />
        </SettingRow>

        <SettingRow
          title="Claude Desktop"
          desc={
            <>
              設定ファイル (<code>{CONFIG_PATHS.claudeDesktop.macos}</code> /
              Windowsは <code>{CONFIG_PATHS.claudeDesktop.windows}</code>) の{" "}
              <code>mcpServers</code> に足してください。Claude Desktop
              はこのファイルでURLを扱えないため、Quelio自身を中継役として起動します
              (ウィンドウは出ません)。
            </>
          }
          stack
        >
          <Snippet
            real={claudeDesktopSnippet(exePath)}
            shown={claudeDesktopSnippet(exePath)}
            onCopy={copy}
          />
        </SettingRow>

        <SettingRow
          title="HTTP対応クライアント (Cursor など)"
          desc={`URLとヘッダを書く形です (${CONFIG_PATHS.httpClient})。`}
          stack
        >
          <Snippet
            real={httpClientSnippet(app.mcpPort, token)}
            shown={httpClientSnippet(app.mcpPort, maskToken(token))}
            onCopy={copy}
          />
        </SettingRow>
      </section>

      <section className="set-section">
        <h3 className="set-section-title">公開する接続</h3>
        <p className="set-section-note">
          AIから見えるのは、ここで公開した接続だけです (既定は公開しない)。
          公開しても、AIに渡るのは<b>接続名だけ</b>
          で、ホスト名やパスワードは渡りません。
          接続の編集画面からも同じ設定ができます。
        </p>
        <div className="mcp-conn-count">
          {exposed > 0
            ? `公開中: ${exposed}件`
            : "公開している接続はありません。ここで選ぶか、接続の編集画面で設定してください"}
        </div>
        {conns
          .filter((c) => canExpose(c.dbType))
          .map((c) => {
            const access = c.aiAccess ?? "none";
            // 本番の接続は、AIからの更新を許可できない
            const prod = c.env === "prod";
            return (
              <div className="mcp-conn-row" key={c.id}>
                <span className="mcp-conn-name">{c.name}</span>
                {c.env && (
                  <span
                    className="mcp-conn-env"
                    style={{ background: envColor(c.env) }}
                  >
                    {envLabel(c.env)}
                  </span>
                )}
                <span className="toolbar-spacer" />
                <SelectMenu
                  value={access}
                  popFixed
                  options={AI_ACCESS.filter(
                    ([v]) => !(prod && v === "write"),
                  ).map(([value, label]) => ({ value, label }))}
                  onChange={(v) => void changeAccess(c, v as AiAccess)}
                />
              </div>
            );
          })}
      </section>

      {confirming && (
        <ConfirmDialog
          title="トークンを作り直します"
          target="AI連携のトークン"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            try {
              setToken(await mcpRegenerateToken());
              reload();
              notify("トークンを作り直しました");
            } catch (e) {
              notify(`作り直せません: ${e}`, "error");
            }
            setConfirming(false);
          }}
        >
          今のトークンはこの場で使えなくなります。
          設定済みのAIクライアントは、新しいトークンに直すまで接続できません。
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * 貼り付け用の設定文。
 *
 * 画面にはトークンを伏せたものを出し、コピーするのは実物にする
 * (肩越しに見られてもトークンが漏れないようにしつつ、
 *  貼り付けでは書き換えが要らないようにするため)
 */
function Snippet({
  real,
  shown,
  onCopy,
}: {
  real: string;
  shown: string;
  onCopy: (text: string, what?: string) => void;
}) {
  return (
    <div className="mcp-snippet">
      <pre className="mcp-snippet-text mono">{shown}</pre>
      <button className="btn-secondary" onClick={() => onCopy(real)}>
        コピー
      </button>
    </div>
  );
}
