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

const AddManager: React.FC<any> = ({ back, refresh }) => {
  const { callApi } = useApi();
  const { t } = useTranslation();

  const [mobileUsers, setMobileUsers] = useState<any[]>([]);
  const [selectedMobile, setSelectedMobile] = useState("");
  const [cameraGroups, setCameraGroups] = useState<CameraGroupType[]>([]);
  const [cameraGroupId, setCameraGroupId] = useState("");


  // Mobile App (mobile_id dropdown)
  const [mobileAppEnabled, setMobileAppEnabled] = useState(true);
  const [selectedMobileIds, setSelectedMobileIds] = useState<string[]>([]);

  // Mobile numbers
  const [mobileEnabled, setMobileEnabled] = useState(true);
  const [mobileNumbers, setMobileNumbers] = useState<string[]>([]);
  const [mobileInput, setMobileInput] = useState("");

  // Email
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [emailChips, setEmailChips] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");

  // Telegram
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");

  // Alerts / Call
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [callEnabled, setCallEnabled] = useState(false);
  const [callStartTime, setCallStartTime] = useState("19:00");
  const [callEndTime, setCallEndTime] = useState("08:00");

  // UI
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "warning">("success");
  const [formloader, setFormloader] = useState(false);
  const [usedGroupIds, setUsedGroupIds] = useState<Set<string>>(new Set());

  const siteId = localStorage.getItem("siteId") || "";

  // Load mobile users
  useEffect(() => {
    if (!siteId) return;
    callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile-users?siteId=${siteId}`, {
      method: "GET",
    })
      .then((res: any) => setMobileUsers(res.data?.users || []))
      .catch(() => setMobileUsers([]));
  }, [siteId]);

  // Load camera groups
  useEffect(() => {
    callApi(`${VITE_base_url}/api/camgroup`, { method: "GET" })
      .then((res: any) => setCameraGroups(res.data?.groups ?? []))
      .catch(() => setCameraGroups([]));
  }, []);

  // Load used camera groups
  useEffect(() => {
    callApi(`${VITE_base_url}/api/notification`)
      .then((res: any) => {
        const ids = new Set(
          (res.data?.data ?? [])
            .map((item: any) => {
              if (!item.camera_group_id) return null;
              return typeof item.camera_group_id === "string"
                ? item.camera_group_id
                : item.camera_group_id._id?.toString() ?? null;
            })
            .filter((id): id is string => !!id)
        );
        setUsedGroupIds(ids);
      })
      .catch(() => setUsedGroupIds(new Set()));
  }, []);

  const availableGroups = cameraGroups.filter((group) =>
    !usedGroupIds.has(group._id.toString())
  );

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = () => {
    if (!cameraGroupId) {
      setMessage(t("Please select a camera group"));
      setMessageType("warning");
      setOpen(true);
      return;
    }

    if (mobileAppEnabled && selectedMobileIds.length === 0) {
    setMessage(t("Please select at least one mobile user or uncheck Mobile App"));
    setMessageType("warning");
    setOpen(true);
    return;
    }

    if (mobileEnabled && mobileNumbers.length === 0) {
    setMessage(t("Please add at least one mobile number or uncheck Mobile"));
    setMessageType("warning");
    setOpen(true);
    return;
   }
    setFormloader(true);

    const payload = {
      camera_group_id: cameraGroupId,
      alerts_enabled: alertsEnabled,
      email: {
        enabled: emailEnabled,
        email_list: emailChips.join(","),
      },
      mobile_app: {
        enabled: mobileAppEnabled ,
        mobile_ids: selectedMobileIds.join(","),
      },
      mobile: {
        enabled: mobileEnabled,
        mobile_numbers: mobileNumbers.join(","),
      },
      telegram: {
        enabled: telegramEnabled,
        bot_token: telegramToken,
        chat_id: telegramChatId,
      },
      alerts_call_notification: callEnabled
        ? {
            alert_call_enabled_notification: true,
            start_time: callStartTime,
            end_time: callEndTime,
          }
        : undefined,
    };

    callApi(`${VITE_base_url}/api/notification/add`, { method: "POST", body: payload })
      .then(() => {

        // ── Sync DynamoDB: add group_name to each selected mobile user ──────
        if (selectedMobileIds.length > 0) {
          const groupName =
            cameraGroups.find((g) => g._id === cameraGroupId)?.group_name ?? "";

          callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/add-groups`, {
            method: "POST",
            body: {
              mobile_ids: selectedMobileIds.join(","),
              group_id:   cameraGroupId,  
              group_name: groupName,
              enabled: mobileAppEnabled, // false if mobile app checkbox was unchecked
            },
          }).catch((err: any) =>
            console.error("addGroups DynamoDB sync failed:", err)
          );
        }
        // ────────────────────────────────────────────────────────────────────

        setMessage(t("Saved successfully"));
        setMessageType("success");
        setOpen(true);
        setUsedGroupIds((prev) => new Set(prev).add(cameraGroupId));
        setTimeout(() => {
          setOpen(false);
          back();
          refresh();
        }, 700);
      })
      .catch((err: any) => {
        const backendMsg = err?.response?.data?.message;
        const msg =
          backendMsg === "Notification config already exists"
            ? t("This group is already assigned and cannot be added")
            : t("genericError");
        setMessage(msg);
        setMessageType("error");
        setOpen(true);
      })
      .finally(() => setFormloader(false));
  };


  // ── Mobile number helpers ─────────────────────────────────────────────────
  const isValidMobile = (mobile: string) => /^\+?\d{10,15}$/.test(mobile);

  const addMobileChip = (value: string) => {
    const phone = value.trim();
    if (!phone) return;
    if (!isValidMobile(phone)) {
      setMessage(t("Invalid mobile number"));
      setMessageType("warning");
      setOpen(true);
      return;
    }
    if (mobileNumbers.includes(phone)) return;
    setMobileNumbers((prev) => [...prev, phone]);
    setMobileInput("");
  };

  const handleMobileKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "," || e.key === "Enter") {
      e.preventDefault();
      addMobileChip(mobileInput.replace(",", ""));
    }
  };

  const removeMobileNumber = (phone: string) =>
    setMobileNumbers((prev) => prev.filter((m) => m !== phone));

  // ── Email helpers (same pattern as Edit.tsx) ──────────────────────────────
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
  };

  const removeEmail = (email: string) =>
    setEmailChips((prev) => prev.filter((e) => e !== email));

  // ── Mobile App helpers ────────────────────────────────────────────────────
  const removeMobileId = (id: string) =>
    setSelectedMobileIds((prev) => prev.filter((m) => m !== id));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ marginLeft: 24, paddingRight: 24, maxWidth: "100%", boxSizing: "border-box" }}>
      <Messagebox
        open={open}
        handleClose={() => setOpen(false)}
        message={message}
        warning={messageType !== "success"}
      />

      <div>
        <h3
          style={{
            fontSize: "24px",
            fontWeight: "500",
            color: "#2f2f2f",
            fontFamily: `"Inter", "Segoe UI", "Roboto", system-ui, sans-serif`,
            marginBottom: "4px",
            paddingBottom: "6px",
            marginLeft: "5px",
            letterSpacing: "0.2px",
            marginTop: "8px",
          }}
        >
          {t("Add Notification Manager")}
        </h3>

        {/* Camera Group Dropdown */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "20px" }}>
          <label style={{ fontWeight: 500 }}>{t("Camera Group")}</label>
          <select
            className="classy-select"
            value={cameraGroupId}
            onChange={(e) => setCameraGroupId(e.target.value)}
            style={{
              height: "42px",
              width: "530px",
              maxWidth: "100%",
            }}
          >
            <option value="">{t("Select a group")}</option>
            {availableGroups.map((group) => (
              <option key={group._id} value={group._id}>
                {group.group_name}
              </option>
            ))}
          </select>
        </div>

        {/* ── Email ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px", width: "530px", maxWidth: "100%" }}>
          <label style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Checkbox checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} />
            <span>{t("Email")}</span>
          </label>
          <div
            style={{
              padding: "0.4rem 0.6rem",
              border: "1px solid var(--color-border-strong)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.95rem",
              backgroundColor: "var(--color-surface)",
              minHeight: "38px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flexWrap: "wrap",
              overflow: "hidden",
            }}
          >
            {emailChips.map((email) => (
              <span
                key={email}
                style={{
                  backgroundColor: "var(--color-primary)",
                  color: "#fff",
                  padding: "4px 10px",
                  borderRadius: "16px",
                  fontSize: "0.8rem",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {email}
                <span style={{ cursor: "pointer", fontWeight: "bold", lineHeight: 1 }} onClick={() => removeEmail(email)}>×</span>
              </span>
            ))}
            <input
              disabled={!emailEnabled}
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={handleEmailKeyDown}
              placeholder={emailChips.length === 0 ? t("Emails, comma separated") : ""}
              style={{ border: "none", outline: "none", fontSize: "0.95rem", backgroundColor: "transparent", flex: 1, minWidth: "140px", height: "30px" }}
            />
          </div>
        </div>

        {/* ── Mobile App (mobile_id dropdown) ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px" }}>
          <label style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Checkbox checked={mobileAppEnabled} onChange={(e) => setMobileAppEnabled(e.target.checked)} />
            <span>{t("Mobile App")}</span>
          </label>

          <select
            className="classy-select"
            disabled={!mobileAppEnabled}
            value={selectedMobile}
            onChange={(e) => {
              const mobile_id = e.target.value;
              if (mobile_id && !selectedMobileIds.includes(mobile_id)) {
                setSelectedMobileIds((prev) => [...prev, mobile_id]);
              }
              setSelectedMobile("");
            }}
            style={{
              height: "42px",
              width: "530px",
              maxWidth: "100%",
            }}
          >
            <option value="">{t("Select Mobile User")}</option>
            {mobileUsers
              .filter((user) => !selectedMobileIds.includes(user.mobile_id))
              .map((user) => (
                <option key={user.mobile_id} value={user.mobile_id}>
                  {user.mobile_id} - {user.email}
                </option>
              ))}
          </select>

          {/* Chips for selected mobile_ids */}
          {selectedMobileIds.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
                padding: "0.4rem 0.6rem",
                border: "1px solid var(--color-border-strong)",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--color-surface)",
                width: "530px",
                maxWidth: "100%",
                minHeight: "38px",
                boxSizing: "border-box",
              }}
            >
              {selectedMobileIds.map((id) => {
                const user = mobileUsers.find((u) => u.mobile_id === id);
                return (
                  <span
                    key={id}
                    style={{
                      backgroundColor: "var(--color-primary)",
                      color: "#fff",
                      padding: "4px 10px",
                      borderRadius: "16px",
                      fontSize: "0.8rem",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      whiteSpace: "nowrap",
                    }}
                  >
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
            <Checkbox checked={mobileEnabled} onChange={(e) => setMobileEnabled(e.target.checked)} />
            <span>{t("Mobile")}</span>
          </label>
          <div
            style={{
              padding: "0.4rem 0.6rem",
              border: "1px solid var(--color-border-strong)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.95rem",
              backgroundColor: "var(--color-surface)",
              minHeight: "38px",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flexWrap: "wrap",
              overflow: "hidden",
            }}
          >
            {mobileNumbers.map((phone) => (
              <span
                key={phone}
                style={{
                  backgroundColor: "var(--color-primary)",
                  color: "#fff",
                  padding: "4px 10px",
                  borderRadius: "16px",
                  fontSize: "0.8rem",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {phone}
                <span style={{ cursor: "pointer", fontWeight: "bold", lineHeight: 1 }} onClick={() => removeMobileNumber(phone)}>×</span>
              </span>
            ))}
            <input
              disabled={!mobileEnabled}
              value={mobileInput}
              onChange={(e) => setMobileInput(e.target.value)}
              onKeyDown={handleMobileKeyDown}
              placeholder={mobileNumbers.length === 0 ? t("Mobile numbers, comma separated") : ""}
              style={{ border: "none", outline: "none", fontSize: "0.95rem", backgroundColor: "transparent", flex: 1, minWidth: "140px", height: "30px" }}
            />
          </div>
        </div>

        {/* ── Telegram ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px", width: "530px", maxWidth: "100%" }}>
          <label style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Checkbox checked={telegramEnabled} onChange={(e) => setTelegramEnabled(e.target.checked)} />
            <span>{t("Telegram")}</span>
          </label>
          <input
            className="classy-input"
            disabled={!telegramEnabled}
            placeholder={t("Telegram bot token")}
            value={telegramToken}
            onChange={(e) => setTelegramToken(e.target.value)}
            style={{ height: "42px", width: "530px", maxWidth: "100%" }}
          />
          <input
            className="classy-input"
            disabled={!telegramEnabled}
            placeholder={t("Telegram chat ID")}
            value={telegramChatId}
            onChange={(e) => setTelegramChatId(e.target.value)}
            style={{ height: "42px", width: "530px", maxWidth: "100%" }}
          />
        </div>

        {/* ── Alerts ── */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "10px" }}>
          <Checkbox checked={alertsEnabled} onChange={(e) => setAlertsEnabled(e.target.checked)} />
          <label style={{ fontWeight: 500 }}>{t("Enable Alerts")}</label>
        </div>

        {/* ── Call Notification ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px", width: "530px", maxWidth: "100%" }}>
          <label style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Checkbox checked={callEnabled} onChange={(e) => setCallEnabled(e.target.checked)} />
            {t("Enable Call Notification")}
          </label>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <input
              type="time"
              className="classy-input"
              disabled={!callEnabled}
              value={callStartTime}
              onChange={(e) => setCallStartTime(e.target.value)}
              style={{ height: "42px", width: "160px" }}
            />
            <input
              type="time"
              className="classy-input"
              disabled={!callEnabled}
              value={callEndTime}
              onChange={(e) => setCallEndTime(e.target.value)}
              style={{ height: "42px", width: "160px" }}
            />
          </div>
        </div>

        {/* ── Buttons ── */}
        <div className="form-button-group" style={{ marginLeft: 15, marginBottom: "20px" }}>
          <button className="outlined-button" onClick={back}>{t("Cancel")}</button>
          <button
            className="filled-button"
            onClick={save}
            disabled={formloader || !cameraGroupId}
          >
            {formloader ? t("Saving...") : t("Save Group")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddManager;