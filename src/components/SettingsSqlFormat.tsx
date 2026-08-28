/**
 * 設定 > エディタ > SQLの整形。
 *
 * SQLエディタの「整形」ボタンの書き方を決める。
 * 項目名だけでは形が想像しにくいので、下に見本を整形して出す
 */
import { useMemo } from "react";
import { formatErrorMessage, formatSql } from "../sqlFormat";
import { defaultSqlFormat } from "../types";
import type { AppSettings, SqlFormatSettings } from "../types";
import { SettingRow } from "./SettingRow";

interface Props {
  app: AppSettings;
  saveApp: (next: AppSettings) => void;
}

/** 見本のSQL (カンマ・AND/OR・JOIN が全部入っている短いもの) */
const SAMPLE = [
  "select s.shop_cd, s.shop_name, sum(o.total) as total",
  "from orders o",
  "inner join shops s on s.shop_cd = o.shop_cd and s.closed = 0",
  "where o.ordered_at >= :from and o.status = 1",
  "group by s.shop_cd, s.shop_name",
  "order by total desc",
].join("\n");

/** 選択肢を横並びのボタンで出す (設定の他の項目と同じ見た目) */
function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button
          key={v}
          className={"segment" + (value === v ? " active" : "")}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsSqlFormat({ app, saveApp }: Props) {
  const fmt = app.sqlFormat;
  /** 1項目だけ変えて保存する */
  const set = <K extends keyof SqlFormatSettings>(
    key: K,
    value: SqlFormatSettings[K]
  ) => saveApp({ ...app, sqlFormat: { ...fmt, [key]: value } });

  // 見本は設定が変わったときだけ作り直す
  const preview = useMemo(() => {
    try {
      return formatSql(SAMPLE, "mysql", fmt);
    } catch (e) {
      return formatErrorMessage(e);
    }
  }, [fmt]);

  const isDefault =
    JSON.stringify(fmt) === JSON.stringify(defaultSqlFormat());

  return (
    <section className="set-section">
      <h3 className="set-section-title">SQLの整形</h3>
      <p className="set-section-note">
        SQLエディタの「整形」ボタン (⇧⌘F) で書き直すときの形です。
        設定を変えても、書いてあるSQLはボタンを押すまで変わりません。
      </p>

      <SettingRow
        title="カンマの位置"
        desc="項目を並べるときのカンマを、次の行の先頭に置くか、その行の末尾に置くか。先頭に置くと、行ごと消してもカンマが余りません。"
      >
        <Choice
          value={fmt.commaStyle}
          options={[
            ["leading", "先頭"],
            ["trailing", "行末"],
          ]}
          onChange={(v) => set("commaStyle", v)}
        />
      </SettingRow>

      <SettingRow
        title="キーワード"
        desc="SELECT・FROM などの予約語の大文字小文字。「そのまま」は書いたとおりにします。"
      >
        <Choice
          value={fmt.keywordCase}
          options={[
            ["upper", "大文字"],
            ["lower", "小文字"],
            ["preserve", "そのまま"],
          ]}
          onChange={(v) => set("keywordCase", v)}
        />
      </SettingRow>

      <SettingRow title="字下げ" desc="1段ぶんの幅です。">
        <Choice
          value={fmt.indent}
          options={[
            ["2", "空白2"],
            ["4", "空白4"],
            ["tab", "タブ"],
          ]}
          onChange={(v) => set("indent", v)}
        />
      </SettingRow>

      <SettingRow
        title="AND・OR の位置"
        desc="条件をつなぐ語を、次の行の先頭に置くか、その行の末尾に置くか。"
      >
        <Choice
          value={fmt.logicalNewline}
          options={[
            ["before", "行の先頭"],
            ["after", "行の末尾"],
          ]}
          onChange={(v) => set("logicalNewline", v)}
        />
      </SettingRow>

      <SettingRow
        title="JOIN の ON"
        desc="結合条件を JOIN と同じ行に置くか、ON を次の行に出して条件をさらに一段下げるか。"
      >
        <Choice
          value={fmt.onClause}
          options={[
            ["same", "同じ行"],
            ["newline", "次の行"],
          ]}
          onChange={(v) => set("onClause", v)}
        />
      </SettingRow>

      <SettingRow
        title="字下げのスタイル"
        desc="「標準」はキーワードだけの行を作って中身を字下げします。「そろえる」はキーワードの幅を固定して、中身を同じ列から始めます。"
      >
        <Choice
          value={fmt.indentStyle}
          options={[
            ["standard", "標準"],
            ["tabularLeft", "そろえる (左)"],
            ["tabularRight", "そろえる (右)"],
          ]}
          onChange={(v) => set("indentStyle", v)}
        />
      </SettingRow>

      <SettingRow title="見本" desc="今の設定で整形した形です。" stack>
        <div className="sql-format-preview">
          <pre className="mono">{preview}</pre>
          <button
            className="btn-secondary"
            disabled={isDefault}
            onClick={() => saveApp({ ...app, sqlFormat: defaultSqlFormat() })}
          >
            既定に戻す
          </button>
        </div>
      </SettingRow>
    </section>
  );
}
