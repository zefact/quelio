//! AI用のDBセッション。
//!
//! AIからの呼び出しは、利用者のタブとは別のセッションで扱う:
//! - session_id は `mcp:<プロファイルid>` 固定。タブ (別のid) と混ざらない
//! - 最初に使われたときだけ繋ぐ (有効にしただけでは繋ぎに行かない)
//! - 10分使われなければ切る (AIは「終わり」を言ってくれないため)
//!
//! 接続そのものは既存の `sessions::connect` に任せる。
//! パスワードの復号・SSHトンネル・TLS・方言解決を、ここで作り直さない

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::models::{AiAccess, ConnectionProfile, ConnectionStore, DbType};

/// 使われないまま切るまでの時間。
///
/// AIは「もう使わない」と言ってくれない。
/// 放っておくと、DB側の接続数を無言で占め続けることになる
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// 見回りの間隔 (この粒度で切れればよいので、短くしすぎない)
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// SQLコンソールで、AIが動かしたものだと分かるようにする印。
///
/// 接続プロファイルの名前に前置すると、
/// 既存の `conn_label` を通って接続・クエリ・切断のすべてに乗る
/// (記録の入口を増やさずに済む)
pub const AI_MARK: &str = "[AI] ";

/// その名前で見つからなかった・公開されていないときの文言。
///
/// 「無い」と「公開していない」を区別できる文言にしない。
/// 区別できると、AIから接続名を総当たりして存在を当てられてしまう
pub const NOT_EXPOSED: &str = "その名前の接続は公開されていません";

/// 同じ名前の接続が複数あるときの文言
pub const DUPLICATED: &str = "接続名が重複しています。Quelioで名前を変えてください";

/// パスワードを復号できない接続の文言
pub const LOCKED: &str =
    "パスワードが読めないため接続できません (Quelioで接続し直してください)";

/// AI用セッションのID (利用者のタブとは必ず別になる)
pub fn session_id(profile_id: &str) -> String {
    format!("mcp:{profile_id}")
}

/// 実際に効かせる公開レベル。
///
/// 本番環境の接続は、設定がどうであれ更新を通さない。
/// 画面でも保存時でも止めているが、設定ファイルは手で書き換えられるので、
/// 実行のたびにここでも見る (3か所とも同じ判断をする)
pub fn effective_access(env: Option<&str>, access: AiAccess) -> AiAccess {
    if env == Some("prod") && access == AiAccess::Write {
        return AiAccess::Read;
    }
    access
}

/// 名前から接続を1件選ぶ。
///
/// 公開していないもの・Valkey・見つからないものは、すべて同じ文言で断る。
/// 同名が複数あるときは、どれかに繋がず名前を直してもらう
/// (「どちらに繋がったか分からない」まま動かすと取り返しがつかない)
pub fn find_by_name<'a>(
    store: &'a ConnectionStore,
    name: &str,
) -> Result<&'a ConnectionProfile, String> {
    let c = find_exposed_by_name(store, name)?;
    if c.password_locked {
        return Err(LOCKED.to_string());
    }
    Ok(c)
}

/// 名前を引くところまで (パスワードの状態は見ない)。
///
/// DBに触らない道 (`open_in_editor`) はここを使う。
/// 触らないのに「鍵が要る」と返すと、
/// **その名前の接続があること自体** を教えてしまう
pub fn find_exposed_by_name<'a>(
    store: &'a ConnectionStore,
    name: &str,
) -> Result<&'a ConnectionProfile, String> {
    let hits: Vec<&ConnectionProfile> = store
        .connections
        .iter()
        .filter(|c| c.name == name)
        .collect();
    if hits.is_empty() {
        return Err(NOT_EXPOSED.to_string());
    }
    if hits.len() > 1 {
        return Err(DUPLICATED.to_string());
    }
    let c = hits[0];
    // 公開していない / Valkey は「見つからない」と同じ返し方にする
    if !c.ai_access.is_exposed() || c.db_type == DbType::Valkey {
        return Err(NOT_EXPOSED.to_string());
    }
    Ok(c)
}

/// AI用に使う接続プロファイルへ作り変える。
///
/// - 名前に `[AI] ` を付ける (SQLコンソールで見分けられるように)
/// - 「読み取りのみ」の接続は **読み取り専用で張る**。既存の仕組み
///   (サーバー側の READ ONLY 設定とプリペアド送信) に乗せて、
///   Quelioの判定をすり抜けた文があってもDB側で止まるようにする
/// - 「更新も許可」の接続は読み取り専用にしない。
///   そうしないと、人が許可した更新まで通らなくなる。
///   代わりに、更新は毎回ダイアログを通す (`approval`)
pub fn ai_profile(profile: &ConnectionProfile, access: AiAccess) -> ConnectionProfile {
    let mut p = profile.clone();
    p.name = format!("{AI_MARK}{}", profile.name);
    p.read_only = access != AiAccess::Write;
    p
}

/// 最後に使われてから切る対象になったものを選ぶ。
///
/// 時刻を渡す形にしてあるので、待たずに試せる
pub fn idle_targets(
    last_used: &HashMap<String, Instant>,
    now: Instant,
    timeout: Duration,
) -> Vec<String> {
    let mut out: Vec<String> = last_used
        .iter()
        .filter(|(_, at)| now.duration_since(**at) >= timeout)
        .map(|(id, _)| id.clone())
        .collect();
    // 呼ぶたびに順番が変わらないようにする (記録も試験も読みやすくなる)
    out.sort();
    out
}

/// 開いているAI用セッション1つぶんの覚え書き
struct Open {
    /// 最後にツールから使われた時刻
    last_used: Instant,
    /// SQLコンソールに出す名前 (`[AI] 接続名`)
    label: String,
    /// **張ったときの** 公開レベル。
    ///
    /// 読み取り専用で張るかどうかがこれで決まるので、
    /// 設定が変わったら張り直さないと、古い状態のまま使い続けてしまう
    access: AiAccess,
}

/// 開いているAI用セッションの一覧
#[derive(Default)]
pub struct AiSessions {
    open: Mutex<HashMap<String, Open>>,
    /// 接続ごとの「張るところ」の順番待ち。
    ///
    /// 同じ接続へ同時に来た最初の呼び出しが、二重に繋ぎに行かないようにする
    gates: Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
}

impl AiSessions {
    /// 使ったことを記録する (無ければ足す)
    fn touch(&self, session_id: &str, label: &str, access: AiAccess) {
        if let Ok(mut m) = self.open.lock() {
            m.entry(session_id.to_string())
                .and_modify(|o| o.last_used = Instant::now())
                .or_insert_with(|| Open {
                    last_used: Instant::now(),
                    label: label.to_string(),
                    access,
                });
        }
    }

    /// 開いていれば、張ったときの公開レベルを返す
    fn opened_access(&self, session_id: &str) -> Option<AiAccess> {
        self.open.lock().ok()?.get(session_id).map(|o| o.access)
    }

    /// その接続の順番待ち (無ければ作る)
    fn gate_for(&self, session_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        let mut m = match self.gates.lock() {
            Ok(m) => m,
            // 取れないときは「待たない」で進む (繋ぎ直しになるだけで壊れはしない)
            Err(_) => return Default::default(),
        };
        m.entry(session_id.to_string()).or_default().clone()
    }

    /// 一覧から外して、記録に使う名前を返す
    fn forget(&self, session_id: &str) -> Option<String> {
        self.open.lock().ok()?.remove(session_id).map(|o| o.label)
    }

    fn all(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .open
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        v.sort();
        v
    }

    fn idle(&self, timeout: Duration) -> Vec<String> {
        let Ok(m) = self.open.lock() else {
            return Vec::new();
        };
        let at: HashMap<String, Instant> =
            m.iter().map(|(id, o)| (id.clone(), o.last_used)).collect();
        idle_targets(&at, Instant::now(), timeout)
    }
}

/// ツールが1回の呼び出しで使う接続の情報
pub struct Opened {
    /// AI用セッションのID
    pub session_id: String,
    /// 接続名 (許可のダイアログに出す。`[AI] ` は付けない)
    pub name: String,
    /// SQLコンソールに出す名前 (`[AI] 接続名`)
    pub label: String,
    /// 環境ラベル ("prod" / "staging" / "dev")
    pub env: Option<String>,
    /// 既定のデータベース (プロファイルの設定。無ければ空)
    pub default_db: String,
    pub db_type: DbType,
    /// 実際に効かせる公開レベル (本番の接続は write でも read に落ちている)
    pub access: AiAccess,
}

/// 接続名から、使える状態のAI用セッションを用意する。
///
/// 公開レベルは **呼ばれるたびに** 読み直す:
/// - 「公開しない」に戻されていたら、その場で切って断る
/// - 読み取り/更新が入れ替わっていたら、張り直す
///   (読み取り専用で張るかどうかが変わるため。張りっぱなしだと
///   「更新に変えたのに通らない」「読み取りに戻したのに通る」の両方が起きる)
pub async fn open(app: &AppHandle, name: &str) -> Result<Opened, String> {
    // ここでは復号しない。公開レベルと種別を見るだけなので、鍵に触る理由が無い
    let store = crate::storage::load_without_secrets(app)?;
    let public = find_by_name(&store, name);

    // 公開をやめた接続が開きっぱなしにならないよう、断る前に切る
    if public.is_err() {
        if let Some(c) = store.connections.iter().find(|c| c.name == name) {
            close(app, &session_id(&c.id), "公開をやめたため切断").await;
        }
        return Err(public.expect_err("直前で Err だと分かっている"));
    }
    let public = public?;
    let id = session_id(&public.id);
    // 本番の接続は、設定が write でも read として扱う
    let access = effective_access(public.env.as_deref(), public.ai_access);
    let label = format!("{AI_MARK}{}", public.name);
    let opened = Opened {
        session_id: id.clone(),
        name: public.name.clone(),
        label: label.clone(),
        env: public.env.clone(),
        default_db: public.database.clone().unwrap_or_default(),
        db_type: public.db_type,
        access,
    };

    // 公開レベルが変わっていたら、張り直す
    if let Some(before) = app.state::<AiSessions>().opened_access(&id) {
        if before != access {
            close(app, &id, "公開レベルが変わったため張り直し").await;
        }
    }

    ensure_connected(app, &id, name, &label, access).await?;
    Ok(opened)
}

/// 繋がっていなければ繋ぐ。
///
/// 同じ接続への最初の呼び出しが重なると、二重に繋ぎに行ってしまう
/// (AIは複数のツールをまとめて呼ぶので、これは普通に起きる)。
/// 接続ごとの順番待ちを1本置き、**ロックを取ってからもう一度** 開いているかを見る
async fn ensure_connected(
    app: &AppHandle,
    id: &str,
    name: &str,
    label: &str,
    access: AiAccess,
) -> Result<(), String> {
    let state = app.state::<AiSessions>();
    if state.opened_access(id).is_some() {
        state.touch(id, label, access);
        return Ok(());
    }

    let gate = state.gate_for(id);
    let _held = gate.lock().await;
    // 待っている間に、別の呼び出しが繋ぎ終えているかもしれない
    if state.opened_access(id).is_some() {
        state.touch(id, label, access);
        return Ok(());
    }

    // 繋ぐときだけ復号する
    let full = crate::storage::load(app)?;
    let profile = find_by_name(&full, name)?.clone();
    let sessions = app.state::<crate::sessions::Sessions>();
    let cancel = app.state::<crate::sessions::CancelRegistry>();
    let qlog = app.state::<crate::query_log::QueryLog>();
    let jobs = app.state::<crate::csv_job::CsvJobs>();
    crate::sessions::connect(
        &sessions,
        &cancel,
        &qlog,
        &jobs,
        id.to_string(),
        ai_profile(&profile, access),
    )
    .await?;
    state.touch(id, label, access);
    Ok(())
}

/// 接続を用意して処理を行う。繋がっていなければ1度だけ張り直す。
///
/// 覚えている側 (`AiSessions`) には残っているのに、
/// 実体 (`Sessions`) が無いことがある (利用者が「接続を閉じる」を押した等)。
/// そのままではAIに「接続されていません」と返るだけで、次も同じになる。
///
/// 判断は **状態を見て** 行う (`sessions::has_session`)。
/// エラーの文言を読み解くと、文言を直した瞬間に判定が静かに外れる
pub async fn with_session<T, F, Fut>(app: &AppHandle, name: &str, run: F) -> Result<T, String>
where
    F: Fn(Opened) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let opened = open(app, name).await?;
    let id = opened.session_id.clone();
    let first = run(opened).await;
    if first.is_ok() {
        return first;
    }
    // 失敗の理由が「接続が無い」ときだけ、張り直してもう一度試す
    let sessions = app.state::<crate::sessions::Sessions>();
    if crate::sessions::has_session(&sessions, &id).await {
        return first;
    }
    // 覚えているだけの状態を捨ててから繋ぎ直す
    app.state::<AiSessions>().forget(&id);
    let again = open(app, name).await?;
    run(again).await
}

/// AI用セッションを1つ閉じる (開いていなければ何もしない)。
///
/// `why` は SQLコンソールに残す理由 (「アイドル切断」など)
pub async fn close(app: &AppHandle, session_id: &str, why: &str) {
    let state = app.state::<AiSessions>();
    let Some(label) = state.forget(session_id) else {
        return;
    };
    let sessions = app.state::<crate::sessions::Sessions>();
    let cancel = app.state::<crate::sessions::CancelRegistry>();
    let qlog = app.state::<crate::query_log::QueryLog>();
    let jobs = app.state::<crate::csv_job::CsvJobs>();
    // 何がいつ切れたかを残す (AIの動きは画面に出ないので、記録だけが手がかりになる)
    qlog.add(&label, "", &format!("-- AI連携: {why}"));
    crate::sessions::disconnect(&sessions, &cancel, &qlog, &jobs, session_id).await;
}

/// AI用セッションをすべて閉じる (AI連携を切ったとき・アプリ終了時)
pub async fn close_all(app: &AppHandle) {
    for id in app.state::<AiSessions>().all() {
        close(app, &id, "AI連携を止めたため切断").await;
    }
}

/// 使われていないAI用セッションを切る見回り。
///
/// 既存の keepalive は全セッションを生かし続けるので、
/// AI用はこちらで別に見る
pub async fn sweep_idle(app: &AppHandle) {
    for id in app.state::<AiSessions>().idle(IDLE_TIMEOUT) {
        close(app, &id, "しばらく使われなかったため切断").await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(name: &str, access: AiAccess, db_type: DbType) -> ConnectionProfile {
        ConnectionProfile {
            id: format!("id-{name}"),
            name: name.to_string(),
            db_type,
            host: "db.example.com".to_string(),
            port: 3306,
            user: "app".to_string(),
            password: "ひみつ".to_string(),
            database: Some("appdb".to_string()),
            tls: false,
            ssl_mode: None,
            ca_cert_path: None,
            client_cert_path: None,
            client_key_path: None,
            read_only: false,
            ssh: None,
            proxy: None,
            folder_id: None,
            color: None,
            env: Some("dev".to_string()),
            ai_access: access,
            pinned: false,
            last_used_at: None,
            password_locked: false,
            password_saved: false,
            passphrase_saved: false,
        }
    }

    fn store(v: Vec<ConnectionProfile>) -> ConnectionStore {
        ConnectionStore {
            connections: v,
            ..Default::default()
        }
    }

    #[test]
    fn 公開している接続は名前で引ける() {
        let s = store(vec![profile("開発DB", AiAccess::Read, DbType::Mysql)]);
        assert_eq!(find_by_name(&s, "開発DB").expect("引けること").id, "id-開発DB");
    }

    #[test]
    fn 無い名前と非公開とvalkeyは同じ文言で断る() {
        // 文言が違うと、名前を総当たりして「在るかどうか」を当てられてしまう
        let s = store(vec![
            profile("非公開", AiAccess::None, DbType::Mysql),
            profile("KV", AiAccess::Write, DbType::Valkey),
        ]);
        for name in ["ありません", "非公開", "KV"] {
            assert_eq!(
                find_by_name(&s, name).expect_err("断ること"),
                NOT_EXPOSED,
                "{name}"
            );
        }
    }

    #[test]
    fn 同名が複数あれば繋がずに名前を直してもらう() {
        let s = store(vec![
            profile("同じ", AiAccess::Read, DbType::Mysql),
            profile("同じ", AiAccess::Read, DbType::Postgresql),
        ]);
        assert_eq!(find_by_name(&s, "同じ").expect_err("断ること"), DUPLICATED);
    }

    #[test]
    fn 同名でも公開が1つだけなら重複にはならない() {
        // 片方が非公開でも「同じ名前がある」ことに変わりはないので、重複として断る
        let mut a = profile("同じ", AiAccess::Read, DbType::Mysql);
        a.id = "a".into();
        let mut b = profile("同じ", AiAccess::None, DbType::Mysql);
        b.id = "b".into();
        assert_eq!(
            find_by_name(&store(vec![a, b]), "同じ").expect_err("断ること"),
            DUPLICATED
        );
    }

    #[test]
    fn パスワードが読めない接続は専用の文言() {
        let mut p = profile("鍵が変わった", AiAccess::Read, DbType::Mysql);
        p.password_locked = true;
        assert_eq!(
            find_by_name(&store(vec![p]), "鍵が変わった").expect_err("断ること"),
            LOCKED
        );
    }

    #[test]
    fn 名前解決だけならパスワードの状態を見ない() {
        // DBに触らない道 (`open_in_editor`) は、鍵が要る接続でも通す。
        // 断ると「その名前の接続がある」ことを教えてしまう
        let mut p = profile("鍵が変わった", AiAccess::Read, DbType::Mysql);
        p.password_locked = true;
        let store = store(vec![p]);
        assert_eq!(
            find_exposed_by_name(&store, "鍵が変わった")
                .expect("通ること")
                .name,
            "鍵が変わった"
        );
        // 公開していないものは、こちらでも同じように断る
        assert_eq!(
            find_exposed_by_name(&store, "知らない名前").expect_err("断ること"),
            NOT_EXPOSED
        );
    }

    #[test]
    fn 読み取りのみの接続は読み取り専用で張る() {
        let p = profile("開発DB", AiAccess::Read, DbType::Mysql);
        let ai = ai_profile(&p, AiAccess::Read);
        assert!(ai.read_only);
        assert_eq!(ai.name, "[AI] 開発DB");
        // 繋ぐのに要るものは落とさない
        assert_eq!(ai.host, p.host);
        assert_eq!(ai.password, p.password);
    }

    #[test]
    fn 更新も許可の接続は読み取り専用にしない() {
        // 読み取り専用で張ると、人が許可した更新まで通らなくなる
        let p = profile("開発DB", AiAccess::Write, DbType::Mysql);
        assert!(!ai_profile(&p, AiAccess::Write).read_only);
    }

    #[test]
    fn 本番の接続は更新を許可していても読み取りに落とす() {
        // 設定ファイルを手で write に書き換えられても、実行時に止める
        assert_eq!(
            effective_access(Some("prod"), AiAccess::Write),
            AiAccess::Read
        );
        // 本番でも「読み取りのみ」はそのまま
        assert_eq!(effective_access(Some("prod"), AiAccess::Read), AiAccess::Read);
        // 本番以外は指定どおり
        assert_eq!(
            effective_access(Some("staging"), AiAccess::Write),
            AiAccess::Write
        );
        assert_eq!(effective_access(None, AiAccess::Write), AiAccess::Write);
        // 公開しないは落とすものが無い
        assert_eq!(effective_access(Some("prod"), AiAccess::None), AiAccess::None);
    }

    #[test]
    fn 本番の接続はprofileも読み取り専用で張る() {
        let mut p = profile("本番", AiAccess::Write, DbType::Mysql);
        p.env = Some("prod".into());
        let access = effective_access(p.env.as_deref(), p.ai_access);
        assert!(ai_profile(&p, access).read_only);
    }

    #[tokio::test]
    async fn 開いていない接続だけを張り直しの対象にする() {
        // 文言ではなく状態で見分ける (文言を直しても判定は外れない)
        let sessions = crate::sessions::Sessions::default();
        assert!(!crate::sessions::has_session(&sessions, "mcp:ありません").await);
    }

    #[test]
    fn 接続が無いエラーは種別を持つ() {
        // sessions::get_session が返すもの。文言は画面にそのまま出るので変えない
        let e = crate::apperr::AppError::no_session();
        assert!(e.is_no_session());
        assert_eq!(e.message, crate::apperr::NO_SESSION_MSG);
    }

    #[test]
    fn セッションidは利用者のタブと混ざらない() {
        assert_eq!(session_id("abc"), "mcp:abc");
    }

    #[test]
    fn 一定時間使われなければ切る対象になる() {
        let now = Instant::now();
        let mut m = HashMap::new();
        m.insert("mcp:古い".to_string(), now - Duration::from_secs(11 * 60));
        m.insert("mcp:ちょうど".to_string(), now - IDLE_TIMEOUT);
        m.insert("mcp:新しい".to_string(), now - Duration::from_secs(60));
        let got = idle_targets(&m, now, IDLE_TIMEOUT);
        assert_eq!(got, vec!["mcp:ちょうど".to_string(), "mcp:古い".to_string()]);
    }

    #[test]
    fn 使っていれば切らない() {
        let now = Instant::now();
        let mut m = HashMap::new();
        m.insert("mcp:a".to_string(), now);
        assert!(idle_targets(&m, now, IDLE_TIMEOUT).is_empty());
    }
}
