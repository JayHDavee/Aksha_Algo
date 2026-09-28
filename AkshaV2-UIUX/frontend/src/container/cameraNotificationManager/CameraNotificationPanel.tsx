import React from "react";
import { Checkbox } from "@mui/material";
import Tooltip from "@mui/material/Tooltip";
import axios from "axios";
import { useTranslation } from "react-i18next";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

/* ================= TYPES ================= */

interface NotificationItem {
  _id: string;
  camera_group_id: {
    _id: string;
    group_name: string;
  } | null;
  email?: {
    enabled: boolean;
    email_list?: string;
  } | null;
  mobile_app?: {
    enabled: boolean;
    mobile_ids?: string;
  } | null;
  mobile?: {
    enabled: boolean;
    mobile_numbers?: string;
  } | null;
  telegram?: {
    enabled: boolean;
    bot_token?: string;
    chat_id?: string;
  } | null;
  alerts_enabled?: boolean;
}

interface Props {
  list: NotificationItem[];
  showAddGroup: () => void;
  showeditpage: (item: NotificationItem) => void;
  showdeletemodal: (item: NotificationItem) => void;
  refreshList: () => void;
}

/* ================= COMPONENT ================= */

const CameraNotificationPanel: React.FC<Props> = ({
  list,
  showAddGroup,
  showeditpage,
  showdeletemodal,
  refreshList,
}) => {
  const { t } = useTranslation();

  /* ================= DERIVED STATE ================= */

  const allEnabled =
    list.length > 0 &&
    list.every((item) => item.alerts_enabled && item.camera_group_id);

  const someEnabled =
    list.some((item) => item.alerts_enabled && item.camera_group_id);

  /* ================= API ACTIONS ================= */

  const toggleSingleChannel = async (
    groupId: string,
    channel: "email" | "mobile_app" | "mobile" | "telegram",
    enabled: boolean,
    item: NotificationItem  // ← added to access mobile_ids and group info
  ) => {
    try {
      await axios.put(
        `${VITE_base_url}/api/notification/toggle/group/${groupId}/${channel}`,
        { enabled }
      );

      // ── Sync DynamoDB when mobile_app is toggled ──────────────────────────
      if (channel === "mobile_app" && item.mobile_app?.mobile_ids && item.camera_group_id) {
        await axios.post(
          `${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/update-groups`,
          {
            mobile_ids: item.mobile_app.mobile_ids,
            group_id:   item.camera_group_id._id,
            group_name: item.camera_group_id.group_name,
            action:     enabled ? "enable" : "disable",
          }
        ).catch((err: any) =>
          console.error("updateGroups DynamoDB sync failed:", err)
        );
      }
      // ─────────────────────────────────────────────────────────────────────

      refreshList();
    } catch (err) {
      console.error(err);
      alert(t("Failed to update channel"));
    }
  };

  const toggleGroup = async (groupId: string, enabled: boolean) => {
    try {
      await axios.put(
        `${VITE_base_url}/api/notification/toggle/group/${groupId}`,
        { enabled }
      );
      refreshList();
    } catch (err) {
      console.error(err);
      alert(t("Failed to update group"));
    }
  };

  const toggleAllGroups = async (enabled: boolean) => {
    try {
      await axios.put(
        `${VITE_base_url}/api/notification/toggle/all`,
        { enabled }
      );
      refreshList();
    } catch (err) {
      console.error(err);
      alert(t("Failed to update all groups"));
    }
  };

  /* ================= HELPERS ================= */

  const maskValue = (value?: string, visibleChars = 3) => {
    if (!value) return "-";
    const len = value.length;
    if (len <= visibleChars) return value;
    return "*".repeat(len - visibleChars) + value.slice(-visibleChars);
  };

  // Mobile app registrations are stored as "<device name>_<install uuid>" —
  // the uuid is meaningless to a reader, so only the name is shown; the raw
  // value is still available in the tooltip for anyone who needs to match it up.
  const formatDeviceLabel = (value: string) =>
    value.replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "");

  // Long comma lists (many devices/emails on one group) used to render as a
  // full-height bullet list, blowing up the row. Show the first couple and
  // fold the rest behind a "+N more" tooltip instead.
  const renderChannelList = (value?: string, formatter?: (v: string) => string) => {
    if (!value) return null;
    const items = value.split(",").map((v) => v.trim()).filter(Boolean);
    if (items.length === 0) return null;

    const VISIBLE_COUNT = 2;
    const visible = items.slice(0, VISIBLE_COUNT);
    const remaining = items.slice(VISIBLE_COUNT);

    return (
      <>
        {visible.map((item, idx) => (
          <div key={idx} className="small text-muted">
            • {formatter ? formatter(item) : item}
          </div>
        ))}
        {remaining.length > 0 && (
          <Tooltip
            title={remaining.map((item, idx) => (
              <div key={idx}>{formatter ? formatter(item) : item}</div>
            ))}
            arrow
          >
            <span className="channel-list-more">+{remaining.length} more</span>
          </Tooltip>
        )}
      </>
    );
  };

  /* ================= UI ================= */

  return (
    <div className="container pb-4" style={{ paddingTop: 30 }}>
      {/* Header */}
      <div className="d-flex justify-content-end align-items-center mb-3">
        {/* <div className="d-flex align-items-center gap-2">
          <Checkbox
            checked={allEnabled}
            indeterminate={!allEnabled && someEnabled}
            onChange={(e) => toggleAllGroups(e.target.checked)}
            sx={{
              "& .MuiSvgIcon-root": { fontSize: 28 },
              "&.Mui-checked": { color: "#66bb6a" },
            }}
          />
          <span className="fw-semibold" style={{ fontSize: "16px", color: "#333" }}>
            {t("Enable Alerts for All Groups")}
          </span>
        </div> */}

        <button className="btn btn-primary px-4" onClick={showAddGroup}>
          {t("Add Notification Group")}
        </button>
      </div>

      {/* Table */}
      <div className="table-responsive classy-table-card">
      <table className="table classy-table align-middle">
        <thead>
          <tr>
            <th>{t("Group Name")}</th>
            <th>{t("Email")}</th>
            <th>{t("Mobile App")}</th>
            <th>{t("Mobile")}</th>
            <th>{t("Telegram Chat")}</th>
            <th>{t("Group Master")}</th>
            <th>{t("Actions")}</th>
          </tr>
        </thead>

        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={7} className="text-center text-muted py-4">
                {t("No notification groups available")}
              </td>
            </tr>
          )}
          {list.map((item) => {
            if (!item.camera_group_id) return null;

            const groupId = item.camera_group_id._id;
            const groupEnabled = !!item.alerts_enabled;

            return (
              <tr
                key={item._id}
                className={!groupEnabled ? "table-secondary opacity-75" : ""}
              >
                {/* Group Name */}
                <td>
                  {item.camera_group_id.group_name}
                  {!groupEnabled && (
                    <span className="badge bg-warning ms-2">{t("Paused")}</span>
                  )}
                </td>

                {/* Email */}
                <td>
                  {!item.email?.email_list ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <>
                      <Checkbox
                        checked={!!item.email?.enabled}
                        disabled={!groupEnabled}
                        onChange={(e) =>
                          toggleSingleChannel(groupId, "email", e.target.checked, item)
                        }
                      />
                      <div className="mt-1">
                        {renderChannelList(item.email.email_list)}
                      </div>
                    </>
                  )}
                </td>

                {/* Mobile App */}
                <td>
                  {!item.mobile_app?.mobile_ids ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <>
                      <Checkbox
                        checked={!!item.mobile_app?.enabled}
                        disabled={!groupEnabled}
                        onChange={(e) =>
                          toggleSingleChannel(groupId, "mobile_app", e.target.checked, item) // ← pass item
                        }
                      />
                      <div className="mt-1">
                        {renderChannelList(item.mobile_app.mobile_ids, formatDeviceLabel)}
                      </div>
                    </>
                  )}
                </td>

                {/* Mobile */}
                <td>
                  {!item.mobile?.mobile_numbers ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <>
                      <Checkbox
                        checked={!!item.mobile?.enabled}
                        disabled={!groupEnabled}
                        onChange={(e) =>
                          toggleSingleChannel(groupId, "mobile", e.target.checked, item)
                        }
                      />
                      <div className="mt-1">
                        {renderChannelList(item.mobile.mobile_numbers)}
                      </div>
                    </>
                  )}
                </td>

                {/* Telegram */}
                <td>
                  {item.telegram?.enabled ? (
                    <div className="d-flex flex-column">
                      <small className="text-muted">
                        Token: {maskValue(item.telegram?.bot_token)}
                      </small>
                      <small className="text-muted">
                        Chat ID: {maskValue(item.telegram?.chat_id)}
                      </small>
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>

                {/* Group Master */}
                <td>
                  <Checkbox
                    checked={groupEnabled}
                    onChange={(e) => toggleGroup(groupId, e.target.checked)}
                  />
                </td>

                {/* Actions */}
                <td>
                  <Tooltip title={t("Edit")}>
                    <button
                      className="btn btn-link p-1"
                      onClick={() => showeditpage(item)}
                    >
                      <i className="bx bx-edit-alt text-primary fs-5"></i>
                    </button>
                  </Tooltip>

                  <Tooltip title={t("Delete Group")}>
                    <button
                      className="btn btn-link p-1"
                      onClick={() => showdeletemodal(item)}
                    >
                      <i className="bx bx-trash text-danger fs-5"></i>
                    </button>
                  </Tooltip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
};

export default React.memo(CameraNotificationPanel);