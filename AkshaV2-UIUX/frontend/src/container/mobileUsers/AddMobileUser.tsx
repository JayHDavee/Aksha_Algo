import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import VisibilityOffOutlinedIcon from "@mui/icons-material/VisibilityOffOutlined";

interface AddMobileUserProps {
  back: () => void;
  onAddUser: (user: any) => Promise<void>;
  siteId: string;
}

const AddMobileUser: React.FC<AddMobileUserProps> = ({ back, onAddUser, siteId }) => {
  const { t } = useTranslation();
  
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const save = async () => {
    if (!username || !email || !password) return;
    
    setIsSubmitting(true);
    const newUserPayload = {
      username,
      email,
      password,
      siteId
    };
    
    try {
      await onAddUser(newUserPayload);
      // Wait a moment then go back, similar to Notification Manager behavior
      setTimeout(() => {
        back();
      }, 700);
    } catch (error) {
      // Error handling (toast) is managed in the parent component
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ marginLeft: 24, paddingRight: 24, maxWidth: "100%", boxSizing: "border-box" }}>
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
          {t("Add Mobile User")}
        </h3>

        {/* Username */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "20px" }}>
          <label style={{ fontWeight: 500 }}>{t("Username")}</label>
          <input
            type="text"
            className="classy-input"
            placeholder={t("Enter username")}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{
              height: "42px",
              width: "530px",
              maxWidth: "100%",
            }}
          />
        </div>

        {/* Email */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px" }}>
          <label style={{ fontWeight: 500 }}>{t("Email")}</label>
          <input
            type="email"
            className="classy-input"
            placeholder={t("Enter email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              height: "42px",
              width: "530px",
              maxWidth: "100%",
            }}
          />
        </div>

        {/* Password */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px" }}>
          <label style={{ fontWeight: 500 }}>{t("Password")}</label>
          <div style={{ position: "relative", width: "530px", maxWidth: "100%" }}>
            <input
              type={showPassword ? "text" : "password"}
              className="classy-input"
              placeholder={t("Enter password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              style={{
                paddingRight: "2.5rem",
                height: "42px",
                width: "100%",
              }}
            />
            <div
              onClick={() => setShowPassword(!showPassword)}
              style={{
                position: "absolute",
                right: "10px",
                top: "50%",
                transform: "translateY(-50%)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                color: "#666"
              }}
            >
              {showPassword ? <VisibilityOutlinedIcon /> : <VisibilityOffOutlinedIcon />}
            </div>
          </div>
        </div>

        {/* Site ID */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "10px", marginBottom: "20px" }}>
          <label style={{ fontWeight: 500 }}>{t("Site ID")}</label>
          <input
            type="text"
            className="classy-input"
            value={siteId}
            disabled
            style={{
              height: "42px",
              width: "530px",
              maxWidth: "100%",
              cursor: "not-allowed"
            }}
          />
          <small style={{ color: "#6c757d", marginTop: "-4px" }}>
            {t("Site ID is automatically assigned.")}
          </small>
        </div>

        {/* Buttons */}
        <div className="form-button-group" style={{ marginLeft: 15, marginBottom: "20px" }}>
          <button className="outlined-button" onClick={back} disabled={isSubmitting}>
            {t("Cancel")}
          </button>
          <button
            className="filled-button"
            onClick={save}
            disabled={isSubmitting || !username || !email || !password}
          >
            {isSubmitting ? t("Saving...") : t("Save User")}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddMobileUser;
