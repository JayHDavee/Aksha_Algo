import React, { useState, useEffect } from "react";
import { useApi } from "../../hooks/useApi";
import { useTranslation } from "react-i18next";
import Messagebox from "../../component/common/Messagebox";

const LAMBDA_base_url = import.meta.env.VITE_AUTHENCTICATE_USER;

const TIME_RANGE_REGEX = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

const SystemHealthSettings: React.FC = () => {
  const { callApi } = useApi();
  const { t } = useTranslation();

  const siteId = localStorage.getItem("siteId") || "";

  const [loaded, setLoaded] = useState(false);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const [emailChips, setEmailChips] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");

  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error" | "warning">("success");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    callApi(`${LAMBDA_base_url}/health/settings?siteId=${siteId}`, { method: "GET" })
      .then((res: any) => {
        const range: string = res.data?.alert_active_range || "";
        const [start, end] = range.split("-");
        setStartTime(start || "");
        setEndTime(end || "");

        const emails: string = res.data?.emergency_emails || "";
        setEmailChips(emails.split(",").map((e: string) => e.trim()).filter(Boolean));
      })
      .catch(() => {
        // Nothing configured yet for this site — leave fields blank
      })
      .finally(() => setLoaded(true));
  }, [siteId]);

  // ── Email helpers (same pattern as List/Edit.tsx) ───────────────────────────
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

  const save = () => {
    if (!siteId) {
      setMessage(t("genericError"));
      setMessageType("error");
      setOpen(true);
      return;
    }

    if ((startTime && !endTime) || (!startTime && endTime)) {
      setMessage(t("Please set both a start and end time, or leave both blank"));
      setMessageType("warning");
      setOpen(true);
      return;
    }

    const payload: any = { siteId };

    if (startTime && endTime) {
      const range = `${startTime}-${endTime}`;
      if (!TIME_RANGE_REGEX.test(range)) {
        setMessage(t("Invalid alert active range"));
        setMessageType("warning");
        setOpen(true);
        return;
      }
      payload.alert_active_range = range;
    }

    payload.emergency_emails = emailChips.join(",");

    callApi(`${LAMBDA_base_url}/health/settings`, {
      method: "PUT",
      body: payload,
    })
      .then(() => {
        setMessage(t("Updated successfully"));
        setMessageType("success");
        setOpen(true);
      })
      .catch(() => {
        setMessage(t("genericError"));
        setMessageType("error");
        setOpen(true);
      });
  };

  if (!loaded) return null;

  return (
    <div
      style={{
        marginLeft: 24,
        marginRight: 24,
        marginBottom: "24px",
        padding: "16px 20px",
        border: "1px solid var(--color-border-strong)",
        borderRadius: "var(--radius-sm)",
        backgroundColor: "var(--color-surface)",
      }}
    >
      <Messagebox open={open} handleClose={() => setOpen(false)} message={message} warning={messageType !== "success"} />

      <h3
        style={{
          fontSize: "20px",
          fontWeight: 500,
          color: "var(--color-text)",
          fontFamily: `"Inter", "Segoe UI", "Roboto", system-ui, sans-serif`,
          marginBottom: "4px",
        }}
      >
        {t("System Health Alerts")}
      </h3>
      <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary, #777)", marginTop: 0, marginBottom: "16px" }}>
        {t("If the Aksha system stops reporting a heartbeat, an alert email is sent to the addresses below.")}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "530px", maxWidth: "100%" }}>
        <label style={{ fontWeight: 500 }}>{t("Alert Active Range")}</label>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <input
            type="time"
            className="classy-input"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            style={{ height: "42px", width: "160px" }}
          />
          <input
            type="time"
            className="classy-input"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            style={{ height: "42px", width: "160px" }}
          />
        </div>
        <span style={{ fontSize: "0.78rem", color: "var(--color-text-secondary, #999)" }}>
          {t("Leave blank to allow alerts at any time")}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "16px", width: "530px", maxWidth: "100%" }}>
        <label style={{ fontWeight: 500 }}>{t("Emergency Emails")}</label>
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
              className="bg-primary text-white px-3 py-1 rounded-pill d-inline-flex align-items-center gap-2"
              style={{ fontSize: "0.8rem", flexShrink: 0 }}
            >
              {email}
              <span style={{ cursor: "pointer", fontWeight: "bold" }} onClick={() => removeEmail(email)}>
                ×
              </span>
            </span>
          ))}
          <input
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            onKeyDown={handleEmailKeyDown}
            placeholder={emailChips.length === 0 ? t("Emergency emails, comma separated") : ""}
            style={{
              border: "none",
              outline: "none",
              fontSize: "0.95rem",
              backgroundColor: "transparent",
              flex: 1,
              minWidth: "140px",
              height: "30px",
            }}
          />
        </div>
      </div>

      <div className="form-button-group" style={{ marginTop: "16px" }}>
        <button className="filled-button" onClick={save}>
          {t("Save")}
        </button>
      </div>
    </div>
  );
};

export default SystemHealthSettings;
