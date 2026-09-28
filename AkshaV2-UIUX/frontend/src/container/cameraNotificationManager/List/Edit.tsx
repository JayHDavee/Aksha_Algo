import React, { useState, useEffect } from "react";
import { useApi } from "../../../hooks/useApi";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@mui/material";
import Messagebox from "../../../component/common/Messagebox";
import "./list.scss";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

interface CameraGroupType {
  _id: string;
  group_name: string;
}

const EditManager: React.FC<any> = ({ data, back, loadlist }: any) => {
  const { callApi } = useApi();
  const { t } = useTranslation();

  const [local, setLocal] = useState<any>(data);
  const [cameraGroups, setCameraGroups] = useState<CameraGroupType[]>([]);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "warning">("success");
  const [open, setOpen] = useState(false);

  const [emailChips, setEmailChips] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");

  const [mobileChips, setMobileChips] = useState<string[]>([]);
  const [mobileInput, setMobileInput] = useState("");

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [editingType, setEditingType] = useState<"email" | "mobile" | null>(null);

  // Mobile App
  const [mobileUsers, setMobileUsers] = useState<any[]>([]);
  const [mobileAppEnabled, setMobileAppEnabled] = useState(true);
  const [selectedMobileIds, setSelectedMobileIds] = useState<string[]>([]);
  const [selectedMobile, setSelectedMobile] = useState("");

  // Call Notification
  const [callEnabled, setCallEnabled] = useState(false);
  const [callStartTime, setCallStartTime] = useState("19:00");
  const [callEndTime, setCallEndTime] = useState("08:00");

  const siteId = localStorage.getItem("siteId") || "";

  useEffect(() => {
    if (!siteId) return;
    callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile-users?siteId=${siteId}`, {
      method: "GET",
    })
      .then((res: any) => setMobileUsers(res.data?.users || []))
      .catch(() => setMobileUsers([]));
  }, [siteId]);

  useEffect(() => {
    callApi(`${VITE_base_url}/api/camgroup`, { method: "GET" })
      .then((res: any) => setCameraGroups(res.data?.groups ?? []))
      .catch(() => setCameraGroups([]));
  }, []);

  useEffect(() => {
    setLocal(data);

    if (data?.email?.email_list) {
      setEmailChips(data.email.email_list.split(",").map((e: string) => e.trim()).filter(Boolean));
    } else {
      setEmailChips([]);
    }

    if (data?.mobile?.mobile_numbers) {
      setMobileChips(data.mobile.mobile_numbers.split(",").map((m: string) => m.trim()).filter(Boolean));
    } else {
      setMobileChips([]);
    }

    setMobileAppEnabled(data?.mobile_app?.enabled ?? true);
    if (data?.mobile_app?.mobile_ids) {
      setSelectedMobileIds(data.mobile_app.mobile_ids.split(",").map((id: string) => id.trim()).filter(Boolean));
    } else {
      setSelectedMobileIds([]);
    }

    if (data?.alerts_call_notification?.alert_call_enabled_notification) {
      setCallEnabled(true);
      setCallStartTime(data.alerts_call_notification.start_time || "19:00");
      setCallEndTime(data.alerts_call_notification.end_time || "08:00");
    } else {
      setCallEnabled(false);
    }
  }, [data]);

  const update = () => {
    if (!local.camera_group_id) {
      setMessage(t("Please select a camera group"));
      setOpen(true);
      return;
    }
      if (!local.camera_group_id) {
    setMessage(t("Please select a camera group"));
    setOpen(true);
    return;
  }

  if (mobileAppEnabled && selectedMobileIds.length === 0) {
    setMessage(t("Please select at least one mobile user or uncheck Mobile App"));
    setMessageType("warning");
    setOpen(true);
    return;
  }

  if (local.mobile?.enabled && mobileChips.length === 0) {
    setMessage(t("Please add at least one mobile number or uncheck Mobile"));
    setMessageType("warning");
    setOpen(true);
    return;
  }
    // ── Get group_id and group_name ───────────────────────────────────────────
    const groupId =
      typeof local.camera_group_id === "object"
        ? local.camera_group_id._id
        : local.camera_group_id;

    const groupName =
      typeof local.camera_group_id === "object"
        ? local.camera_group_id.group_name
        : cameraGroups.find((g) => g._id === local.camera_group_id)?.group_name ?? "";

    const previousMobileIds: string[] = data?.mobile_app?.mobile_ids
      ? data.mobile_app.mobile_ids.split(",").map((id: string) => id.trim()).filter(Boolean)
      : [];

    const previousEnabled: boolean = data?.mobile_app?.enabled ?? true;

    const payload = {
      ...local,
      email: {
        ...local.email,
        email_list: emailChips.join(","),
      },
      mobile: {
        ...local.mobile,
        mobile_numbers: mobileChips.join(","),
      },
      mobile_app: {
        enabled: mobileAppEnabled,
        mobile_ids: selectedMobileIds.join(","),
      },
      alerts_call_notification: callEnabled
        ? {
            alert_call_enabled_notification: true,
            start_time: callStartTime,
            end_time: callEndTime,
          }
        : undefined,
    };

    callApi(`${VITE_base_url}/api/notification/${local._id}`, {
      method: "PUT",
      body: payload,
    })
      .then(() => {
        const syncPromises: Promise<any>[] = [];

        // ── New mobile_ids added ──────────────────────────────────────────────
        const addedIds = selectedMobileIds.filter((id) => !previousMobileIds.includes(id));
        if (addedIds.length > 0) {
          syncPromises.push(
            callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/add-groups`, {
              method: "POST",
              body: {
                mobile_ids: addedIds.join(","),
                group_id:   groupId,    // ← Option A
                group_name: groupName,
                enabled:    true,
              },
            })
          );
        }

        // ── Removed mobile_ids ────────────────────────────────────────────────
        const removedIds = previousMobileIds.filter((id) => !selectedMobileIds.includes(id));
        if (removedIds.length > 0) {
          syncPromises.push(
            callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/update-groups`, {
              method: "POST",
              body: {
                mobile_ids: removedIds.join(","),
                group_id:   groupId,    // ← Option A
                group_name: groupName,
                action:     "remove",
              },
            })
          );
        }

        // ── mobile_app toggled OFF → disable notifications ────────────────────
        if (!mobileAppEnabled && previousEnabled && selectedMobileIds.length > 0) {
          syncPromises.push(
            callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/update-groups`, {
              method: "POST",
              body: {
                mobile_ids: selectedMobileIds.join(","),
                group_id:   groupId,
                group_name: groupName,
                action:     "disable",
              },
            })
          );
        }

        // ── mobile_app toggled ON → enable notifications ──────────────────────
        if (mobileAppEnabled && !previousEnabled && selectedMobileIds.length > 0) {
          syncPromises.push(
            callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/update-groups`, {
              method: "POST",
              body: {
                mobile_ids: selectedMobileIds.join(","),
                group_id:   groupId,
                group_name: groupName,
                action:     "enable",
              },
            })
          );
        }

        return Promise.allSettled(syncPromises);
      })
      .then(() => {
        setMessage(t("Updated successfully"));
        setMessageType("success");
        setOpen(true);
        setTimeout(() => {
          setOpen(false);
          back();
          loadlist();
        }, 700);
      })
      .catch(() => {
        setMessage(t("genericError"));
        setMessageType("error");
        setOpen(true);
      });
  };

  // ── Email helpers ─────────────────────────────────────────────────────────
  const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const addEmailChip = (value: string) => {
    const email = value.trim();
    if (!email) return;
    if (!isValidEmail(email)) {
      setMessage(t("Invalid email address"));
      setMessageType("warning");
      setOpen(true);
      return;
    }
    if (emailChips.includes(email)) return;
    setEmailChips((prev) => [...prev, email]);
    setEmailInput("");
  };

  const handleEmailKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "," || e.key === "Enter") {
      e.preventDefault();
      addEmailChip(emailInput.replace(",", ""));
    }
    if (e.key === "Backspace" && emailInput === "" && emailChips.length > 0) {
      const last = emailChips[emailChips.length - 1];
      setEmailChips((prev) => prev.slice(0, -1));
      setEmailInput(last);
    }
  };

  const removeEmail = (email: string) =>
    setEmailChips((prev) => prev.filter((e) => e !== email));

  // ── Mobile helpers ────────────────────────────────────────────────────────
  const isValidMobile = (mobile: string) => /^\+?\d{10}$/.test(mobile);

  const addMobileChip = (value: string) => {
    const phone = value.trim();
    if (!phone) return;
    if (!isValidMobile(phone)) {
      setMessage(t("Invalid mobile number"));
      setMessageType("warning");
      setOpen(true);
      return;
    }
    if (mobileChips.includes(phone)) return;
    setMobileChips((prev) => [...prev, phone]);
    setMobileInput("");
  };

  const handleMobileKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "," || e.key === "Enter") {
      e.preventDefault();
      addMobileChip(mobileInput.replace(",", ""));
    }
    if (e.key === "Backspace" && mobileInput === "" && mobileChips.length > 0) {
      const last = mobileChips[mobileChips.length - 1];
      setMobileChips((prev) => prev.slice(0, -1));
      setMobileInput(last);
    }
  };

  const removeMobile = (phone: string) =>
    setMobileChips((prev) => prev.filter((m) => m !== phone));

  const startEdit = (type: "email" | "mobile", index: number) => {
    setEditingType(type);
    setEditingIndex(index);
    setEditingValue(type === "email" ? emailChips[index] : mobileChips[index]);
  };

  const saveEdit = () => {
    if (editingType === "email") {
      if (!isValidEmail(editingValue)) {
        setMessage(t("Invalid email address"));
        setMessageType("warning");
        setOpen(true);
        return;
      }
      setEmailChips((prev) => prev.map((e, i) => (i === editingIndex ? editingValue : e)));
    } else if (editingType === "mobile") {
      if (!isValidMobile(editingValue)) {
        setMessage(t("Invalid mobile number"));
        setMessageType("warning");
        setOpen(true);
        return;
      }
      setMobileChips((prev) => prev.map((m, i) => (i === editingIndex ? editingValue : m)));
    }
    setEditingType(null);
    setEditingIndex(null);
    setEditingValue("");
  };

  const cancelEdit = () => {
    setEditingType(null);
    setEditingIndex(null);
    setEditingValue("");
  };

  const removeMobileId = (id: string) =>
    setSelectedMobileIds((prev) => prev.filter((m) => m !== id));

  return (
    <div style={{ marginLeft: 24, paddingRight: 24, maxWidth: "100%", boxSizing: "border-box" }}>
      <Messagebox open={open} handleClose={() => setOpen(false)} message={message} warning={messageType !== "success"} />

      <div>
        <h3 style={{ fontSize: "24px", fontWeight: "500", color: "var(--color-text)", fontFamily: `"Inter", "Segoe UI", "Roboto", system-ui, sans-serif`, marginBottom: "4px", paddingBottom: "6px", marginLeft: "5px", letterSpacing: "0.2px", marginTop: "8px" }}>
          {t("Edit Notification Manager")}
        </h3>

        {/* Camera Group (read-only) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "20px" }}>
          <label style={{ fontWeight: 500 }}>{t("Camera Group")}</label>
          <input type="text" className="classy-input" value={local.camera_group_id?.group_name || ""} disabled
            style={{ fontSize: "0.95rem", height: "42px", width: "530px", maxWidth: "100%" }}
          />
        </div>

        {/* ── Mobile App ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px" }}>
          <label style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Checkbox checked={mobileAppEnabled} onChange={(e) => setMobileAppEnabled(e.target.checked)} />
            <span>{t("Mobile App")}</span>
          </label>
          <select className="classy-select" disabled={!mobileAppEnabled} value={selectedMobile}
            onChange={(e) => {
              const mobile_id = e.target.value;
              if (mobile_id && !selectedMobileIds.includes(mobile_id)) setSelectedMobileIds((prev) => [...prev, mobile_id]);
              setSelectedMobile("");
            }}
            style={{ fontSize: "0.95rem", height: "42px", width: "530px", maxWidth: "100%" }}
          >
            <option value="">{t("Select Mobile User")}</option>
            {mobileUsers.filter((user) => !selectedMobileIds.includes(user.mobile_id)).map((user) => (
              <option key={user.mobile_id} value={user.mobile_id}>{user.mobile_id} - {user.email}</option>
            ))}
          </select>
          {selectedMobileIds.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", padding: "0.4rem 0.6rem", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-sm)", backgroundColor: "var(--color-surface)", width: "530px", maxWidth: "100%", minHeight: "38px", boxSizing: "border-box" }}>
              {selectedMobileIds.map((id) => {
                const user = mobileUsers.find((u) => u.mobile_id === id);
                return (
                  <span key={id} style={{ backgroundColor: "var(--color-primary)", color: "#fff", padding: "4px 10px", borderRadius: "16px", fontSize: "0.8rem", display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }}>
                    {user ? `${user.mobile_id} - ${user.email}` : id}
                    <span style={{ cursor: "pointer", fontWeight: "bold", lineHeight: 1 }} onClick={() => removeMobileId(id)}>×</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Mobile Numbers ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px", width: "530px", maxWidth: "100%" }}>
          <label style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Checkbox checked={local.mobile?.enabled} onChange={(e) => setLocal({ ...local, mobile: { ...local.mobile, enabled: e.target.checked } })} />
            <span>{t("Mobile")}</span>
          </label>
          <div style={{ padding: "0.4rem 0.6rem", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-sm)", fontSize: "0.95rem", backgroundColor: "var(--color-surface)", minHeight: "38px", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", overflow: "hidden" }}>
            {mobileChips.map((phone, index) =>
              editingType === "mobile" && editingIndex === index ? (
                <input key={index} value={editingValue} autoFocus onChange={(e) => setEditingValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") cancelEdit(); }}
                  onBlur={saveEdit}
                  style={{ minWidth: "140px", borderRadius: "12px", padding: "4px 8px", fontSize: "0.8rem", border: "1px solid var(--color-primary)" }}
                />
              ) : (
                <span key={phone} className="bg-primary text-white px-3 py-1 rounded-pill d-inline-flex align-items-center gap-2"
                  style={{ fontSize: "0.8rem", cursor: "pointer", flexShrink: 0 }} onClick={() => startEdit("mobile", index)}>
                  {phone}
                  <span style={{ cursor: "pointer", fontWeight: "bold" }} onClick={(e) => { e.stopPropagation(); removeMobile(phone); }}>×</span>
                </span>
              )
            )}
            <input disabled={!local.mobile?.enabled} value={mobileInput} onChange={(e) => setMobileInput(e.target.value)} onKeyDown={handleMobileKeyDown}
              placeholder={mobileChips.length === 0 ? t("Mobile numbers, comma separated") : ""}
              style={{ border: "none", outline: "none", fontSize: "0.95rem", backgroundColor: "transparent", flex: 1, minWidth: "140px", height: "30px" }}
            />
          </div>
        </div>

        {/* ── Telegram ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px", width: "530px", maxWidth: "100%" }}>
          <label style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Checkbox checked={local.telegram?.enabled} onChange={(e) => setLocal({ ...local, telegram: { ...local.telegram, enabled: e.target.checked } })} />
            <span>{t("Telegram")}</span>
          </label>
          <input
            className="classy-input"
            disabled={!local.telegram?.enabled}
            placeholder={t("Telegram bot token")}
            value={local.telegram?.bot_token || ""}
            onChange={(e) => setLocal({ ...local, telegram: { ...local.telegram, bot_token: e.target.value } })}
            style={{ height: "42px", width: "530px", maxWidth: "100%" }}
          />
          <input
            className="classy-input"
            disabled={!local.telegram?.enabled}
            placeholder={t("Telegram chat ID")}
            value={local.telegram?.chat_id || ""}
            onChange={(e) => setLocal({ ...local, telegram: { ...local.telegram, chat_id: e.target.value } })}
            style={{ height: "42px", width: "530px", maxWidth: "100%" }}
          />
        </div>

        {/* ── Call Notification ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px", width: "530px", maxWidth: "100%" }}>
          <label style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Checkbox checked={callEnabled} onChange={(e) => setCallEnabled(e.target.checked)} />
            {t("Enable Call Notification")}
          </label>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <input type="time" className="classy-input" disabled={!callEnabled} value={callStartTime} onChange={(e) => setCallStartTime(e.target.value)}
              style={{ height: "42px", width: "160px" }} />
            <input type="time" className="classy-input" disabled={!callEnabled} value={callEndTime} onChange={(e) => setCallEndTime(e.target.value)}
              style={{ height: "42px", width: "160px" }} />
          </div>
        </div>

        {/* ── Enable Alerts ── */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "10px" }}>
          <Checkbox checked={local.alerts_enabled} onChange={(e) => setLocal({ ...local, alerts_enabled: e.target.checked })} />
          <label style={{ fontWeight: 500 }}>{t("Enable Alerts")}</label>
        </div>

        {/* ── Buttons ── */}
        <div className="form-button-group" style={{ marginLeft: 15, marginBottom: "20px" }}>
          <button className="outlined-button" onClick={back}>{t("Cancel")}</button>
          <button className="filled-button" onClick={update}>{t("Update Group")}</button>
        </div>
      </div>
    </div>
  );
};

export default EditManager;