import { afterEach, describe, expect, it } from "vitest";
import {
  clearLost,
  isConnectionLost,
  lostSnapshot,
  markChecking,
  markLost,
  watchSession,
} from "./connLost";

describe("isConnectionLost: MySQL", () => {
  it("通信が切れたエラーは切断とみなす", () => {
    expect(isConnectionLost("接続できません: Broken pipe (os error 32)")).toBe(true);
    expect(
      isConnectionLost("接続できません: Connection reset by peer (os error 54)")
    ).toBe(true);
    expect(isConnectionLost("接続できません: unexpected end of file")).toBe(true);
    // 張り直そうとして届かなかった
    expect(
      isConnectionLost("接続できません: Connection refused (os error 61)")
    ).toBe(true);
    expect(isConnectionLost("DB接続がタイムアウトしました")).toBe(true);
  });

  it("SQLSTATE 08 (接続の異常) は切断とみなす", () => {
    expect(
      isConnectionLost("DBエラー: 1053 (08S01): Server shutdown in progress")
    ).toBe(true);
    expect(isConnectionLost("MySQL server has gone away")).toBe(true);
  });

  it("SQLの誤りや中止は切断ではない", () => {
    expect(
      isConnectionLost(
        "DBエラー: 1064 (42000): You have an error in your SQL syntax"
      )
    ).toBe(false);
    expect(
      isConnectionLost("DBエラー: 1146 (42S02): Table 'a.b' doesn't exist")
    ).toBe(false);
    expect(isConnectionLost("実行を中止しました")).toBe(false);
    expect(isConnectionLost("クエリがタイムアウトしました")).toBe(false);
  });
});

describe("isConnectionLost: PostgreSQL", () => {
  it("サーバーが接続を切ったエラーは切断とみなす", () => {
    expect(
      isConnectionLost(
        "DBエラー: terminating connection due to administrator command"
      )
    ).toBe(true);
    expect(
      isConnectionLost("DBエラー: the database system is shutting down")
    ).toBe(true);
    // サーバーの言語設定が日本語のとき
    expect(
      isConnectionLost("DBエラー: 管理者コマンドにより接続を終了しています")
    ).toBe(true);
    expect(isConnectionLost("接続できません: unexpected end of file")).toBe(true);
  });

  it("権限や構文のエラーは切断ではない", () => {
    expect(
      isConnectionLost("DBエラー: permission denied for table users")
    ).toBe(false);
    expect(
      isConnectionLost('DBエラー: relation "nope" does not exist')
    ).toBe(false);
    expect(
      isConnectionLost("DBエラー: canceling statement due to user request")
    ).toBe(false);
  });
});

describe("isConnectionLost: Valkey", () => {
  it("接続が切れた・張り直せないエラーは切断とみなす", () => {
    expect(isConnectionLost("Valkeyエラー: broken pipe")).toBe(true);
    expect(
      isConnectionLost("Valkeyエラー: Connection reset by peer (os error 54)")
    ).toBe(true);
    expect(
      isConnectionLost(
        "Valkeyに接続できません: Connection refused (os error 61)"
      )
    ).toBe(true);
    expect(isConnectionLost("Valkey接続がタイムアウトしました")).toBe(true);
    expect(isConnectionLost("Valkeyエラー: Driver unexpectedly terminated")).toBe(
      true
    );
  });

  it("コマンドの誤り・中止・時間切れは切断ではない", () => {
    expect(
      isConnectionLost("Valkeyエラー: ERR unknown command 'FOO'")
    ).toBe(false);
    expect(
      isConnectionLost(
        "Valkeyエラー: WRONGTYPE Operation against a key holding the wrong kind of value"
      )
    ).toBe(false);
    expect(isConnectionLost("中止しました (1件目まで実行済み)")).toBe(false);
    expect(isConnectionLost("コマンドがタイムアウトしました (60秒)")).toBe(false);
    expect(
      isConnectionLost("Valkey接続ではこの操作はできません")
    ).toBe(false);
  });
});

describe("isConnectionLost: 共通", () => {
  it("空や接続が開いていないときは切断とみなさない", () => {
    expect(isConnectionLost(null)).toBe(false);
    expect(isConnectionLost("")).toBe(false);
    expect(isConnectionLost("接続されていません。再接続してください")).toBe(false);
    expect(
      isConnectionLost(
        "パスワードが読めないため接続できません (Quelioで接続し直してください)"
      )
    ).toBe(false);
  });

  it("SSH踏み台の切断も切断とみなす", () => {
    expect(isConnectionLost("SSH接続がタイムアウトしました (bastion:22)")).toBe(
      true
    );
  });
});

describe("watchSession", () => {
  afterEach(() => {
    clearLost("s1");
  });

  it("切断の失敗で印が付き、成功で消える", async () => {
    await expect(
      watchSession(
        "list_tables",
        { sessionId: "s1" },
        Promise.reject("接続できません: Broken pipe (os error 32)")
      )
    ).rejects.toBe("接続できません: Broken pipe (os error 32)");
    expect(lostSnapshot().get("s1")?.message).toContain("Broken pipe");

    await watchSession("list_tables", { sessionId: "s1" }, Promise.resolve([]));
    expect(lostSnapshot().has("s1")).toBe(false);
  });

  it("結果の中のエラーも見る (SQL・Valkey の実行)", async () => {
    const out = await watchSession(
      "kv_exec",
      { sessionId: "s1" },
      Promise.resolve({ statements: [], error: "Valkeyエラー: broken pipe" })
    );
    expect(out.error).toBe("Valkeyエラー: broken pipe");
    expect(lostSnapshot().has("s1")).toBe(true);

    // 中止しただけでは消さない
    await watchSession(
      "kv_exec",
      { sessionId: "s1" },
      Promise.resolve({ statements: [], error: "中止しました" })
    );
    expect(lostSnapshot().has("s1")).toBe(true);

    // 構文の誤りは、接続が生きている証拠なので消す
    await watchSession(
      "run_query",
      { sessionId: "s1" },
      Promise.resolve({ statements: [], error: "DBエラー: syntax error" })
    );
    expect(lostSnapshot().has("s1")).toBe(false);
  });

  it("接続を使わないコマンドの成功では消さない", async () => {
    markLost("s1", "接続できません: Broken pipe");
    await watchSession(
      "check_kv_destructive",
      { sessionId: "s1" },
      Promise.resolve([])
    );
    expect(lostSnapshot().has("s1")).toBe(true);
  });

  it("接続し直すのに失敗したら、確かめ中を戻して理由を差し替える", async () => {
    markLost("s1", "接続できません: Broken pipe");
    markChecking("s1");
    expect(lostSnapshot().get("s1")?.checking).toBe(true);
    await expect(
      watchSession(
        "check_connection",
        { sessionId: "s1" },
        Promise.reject("DB接続がタイムアウトしました")
      )
    ).rejects.toBeDefined();
    const info = lostSnapshot().get("s1");
    expect(info?.checking).toBe(false);
    expect(info?.message).toBe("DB接続がタイムアウトしました");
  });

  it("接続する前の操作や中止の失敗では印を付けない", async () => {
    await expect(
      watchSession(
        "connect_session",
        { sessionId: "s1" },
        Promise.reject("接続できません: Connection refused (os error 61)")
      )
    ).rejects.toBeDefined();
    expect(lostSnapshot().has("s1")).toBe(false);
  });

  it("セッションを持たないコマンドは見ない", async () => {
    await expect(
      watchSession("list_connections", undefined, Promise.reject("接続できません"))
    ).rejects.toBeDefined();
    expect(lostSnapshot().size).toBe(0);
  });
});
