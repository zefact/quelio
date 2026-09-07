//! アプリが今どれだけメモリを使っているか。
//!
//! Tauriのアプリは1つのプロセスでは動いていない。
//! Rust本体のほかに、画面を描くWebViewや、接続に使う外部CLI
//! (SSM / Cloud SQL Proxy) が別のプロセスとして動く。
//! 「アプリ全体」を出すには、それらをまとめて数える必要がある。
//!
//! 数え方は「自分のPIDから親子を辿って集める」。
//! Windowsの WebView2 や、こちらから起こしたCLIはこれで拾える。
//! ただし macOS では、画面の中身を描くWebKitのプロセスが
//! アプリの子ではなくOSの下にぶら下がるため、この合計には入らない。
//! 表示側にその断りを出している

use std::collections::HashSet;

/// 集計に要るぶんだけのプロセス情報
#[derive(Clone, Copy, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    /// 親のPID (辿れないときは None)
    pub parent: Option<u32>,
    /// 実メモリ (バイト)
    pub memory: u64,
}

/// 使用量の内訳
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppMemory {
    /// 自分と子孫の合計 (バイト)
    pub bytes: u64,
    /// そのうち本体のぶん (バイト)
    pub own: u64,
    /// 数えたプロセスの数 (本体を含む)
    pub processes: usize,
}

/// root と、その子孫のメモリを合計する。
///
/// 親子の関係が壊れて輪になっていても止まるよう、
/// 一度入れたPIDは二度数えない
pub fn tree_memory(procs: &[ProcInfo], root: u32) -> AppMemory {
    let mut want: HashSet<u32> = HashSet::from([root]);
    // 孫・ひ孫まで辿る (増えなくなったら終わり)
    loop {
        let mut added = false;
        for p in procs {
            if want.contains(&p.pid) {
                continue;
            }
            if p.parent.is_some_and(|parent| want.contains(&parent)) {
                want.insert(p.pid);
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    let mine: Vec<&ProcInfo> = procs.iter().filter(|p| want.contains(&p.pid)).collect();
    AppMemory {
        bytes: mine.iter().map(|p| p.memory).sum(),
        own: mine
            .iter()
            .find(|p| p.pid == root)
            .map_or(0, |p| p.memory),
        processes: mine.len(),
    }
}

/// 今の使用量を調べる
pub fn current() -> AppMemory {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    // 親子を辿るので、すべてのプロセスを見る必要がある。
    // ただし要るのはメモリだけなので、それ以外は集めない
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    let procs: Vec<ProcInfo> = sys
        .processes()
        .iter()
        .map(|(pid, p)| ProcInfo {
            pid: pid.as_u32(),
            parent: p.parent().map(|x| x.as_u32()),
            // sysinfo はバイトで返す
            memory: p.memory(),
        })
        .collect();
    tree_memory(&procs, std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: Option<u32>, memory: u64) -> ProcInfo {
        ProcInfo { pid, parent, memory }
    }

    #[test]
    fn 自分と子と孫を合計する() {
        let procs = [
            p(1, None, 10),      // 無関係 (OS)
            p(100, Some(1), 500), // 自分
            p(200, Some(100), 40),
            p(300, Some(200), 5), // 孫
            p(400, Some(1), 900), // 別のアプリ
        ];
        let got = tree_memory(&procs, 100);
        assert_eq!(got.bytes, 545);
        assert_eq!(got.own, 500);
        assert_eq!(got.processes, 3);
    }

    #[test]
    fn 子がいなければ自分だけ() {
        let procs = [p(1, None, 10), p(100, Some(1), 500)];
        assert_eq!(
            tree_memory(&procs, 100),
            AppMemory { bytes: 500, own: 500, processes: 1 }
        );
    }

    #[test]
    fn 親が輪になっていても止まる() {
        // 壊れた親子関係 (100 → 200 → 100)
        let procs = [p(100, Some(200), 5), p(200, Some(100), 7)];
        let got = tree_memory(&procs, 100);
        assert_eq!(got.bytes, 12);
        assert_eq!(got.processes, 2);
    }

    #[test]
    fn 実際に自分のプロセスを数えられる() {
        // 数え方そのものではなく、OSから値を取れているかの確認
        let got = current();
        assert!(got.processes >= 1, "{got:?}");
        assert!(got.own > 0, "{got:?}");
        assert!(got.bytes >= got.own, "{got:?}");
    }

    #[test]
    fn 自分が見つからなくても落ちない() {
        let procs = [p(1, None, 10)];
        assert_eq!(
            tree_memory(&procs, 999),
            AppMemory { bytes: 0, own: 0, processes: 0 }
        );
    }
}
