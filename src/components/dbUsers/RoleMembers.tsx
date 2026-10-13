/**
 * ロールのメンバー (PostgreSQLのみ)。
 *
 * 選んでいるロールに、どのユーザーが属しているかを出し、
 * メンバーを足したり外したりする (GRANT ロール TO ユーザー / REVOKE)。
 *
 * 今つないでいるユーザー自身も足せる。
 * AWS RDS のマスターユーザーは作ったロールに属していないので、
 * そのロールを所有者にする前などに、ここで自分を足す。
 * 外すほうは、自分の権限を削りかねないので自分自身には出さない
 */
import type { DbUser } from "../../types";
import { SelectMenu } from "../SelectMenu";
import { CloseMark } from "../CloseMark";
import type { AskedChange } from "./UserActions";
import { memberCandidates, roleMembers } from "./memberList";

interface Props {
  /** 選んでいるロール */
  role: DbUser;
  /** 一覧にあるユーザーとロール (サーバー既定のものも含めて全部) */
  users: DbUser[];
  /** メンバーを足したり外したりできるか */
  editable: boolean;
  onAsk: (ask: AskedChange) => void;
}

export function RoleMembers({ role, users, editable, onAsk }: Props) {
  const members = roleMembers(role, users);
  const candidates = memberCandidates(role, users);

  const join = (u: DbUser) =>
    onAsk({
      title: "ロールにメンバーを足します",
      change: {
        kind: "role",
        user: { name: u.name, host: "" },
        role: role.name,
        add: true,
      },
      note: u.isSelf
        ? `今つないでいる「${u.name}」を「${role.name}」のメンバーにします。` +
          `「${role.name}」の権限を使えるようになり、データベースの所有者を「${role.name}」にすることもできるようになります`
        : `「${u.name}」は「${role.name}」の権限を使えるようになります`,
      confirmLabel: "足す",
      done: `「${u.name}」を「${role.name}」のメンバーにしました`,
    });

  const leave = (u: DbUser) =>
    onAsk({
      title: "ロールからメンバーを外します",
      change: {
        kind: "role",
        user: { name: u.name, host: "" },
        role: role.name,
        add: false,
      },
      note: `「${u.name}」は「${role.name}」の権限を使えなくなります`,
      confirmLabel: "外す",
      done: `「${u.name}」を「${role.name}」から外しました`,
    });

  return (
    <div className="dbusers-members">
      <div className="dbusers-grant-head">
        <span className="dbusers-grant-title">
          メンバー (このロールに属しているユーザー)
        </span>
        {editable && (
          <SelectMenu
            className="select-field dbusers-member-add"
            value=""
            options={candidates.map((u) => ({
              value: u.key,
              label: u.isSelf ? `${u.name} (この接続)` : u.name,
            }))}
            placeholder={
              candidates.length === 0 ? "足せるユーザーがいません" : "メンバーを足す..."
            }
            disabled={candidates.length === 0}
            popFixed
            onChange={(key) => {
              const u = candidates.find((c) => c.key === key);
              if (u) join(u);
            }}
          />
        )}
      </div>
      {members.length === 0 ? (
        <div className="csv-empty-hint">メンバーはいません</div>
      ) : (
        <div className="dbusers-roles">
          {members.map((u) => (
            <span className="dbusers-badge dbusers-member" key={u.key}>
              {u.name}
              {u.isSelf && " (この接続)"}
              {/* 自分自身とサーバーが用意したものは外させない */}
              {editable && !u.isSelf && !u.system && (
                <button
                  className="dbusers-member-x"
                  aria-label={`${u.name} を外す`}
                  title="このロールから外す"
                  onClick={() => leave(u)}
                >
                  <CloseMark size={8} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
