import React, { useState, useEffect, JSX } from "react";
import Dialog from "@mui/material/Dialog";
import Slide from "@mui/material/Slide";
import { TransitionProps } from "@mui/material/transitions";
import { Tooltip } from '@mui/material'; // Keep Tooltip as it's used
// Importing icons (assuming these are used for visual display and not directly in logic)
import CloseIcon from "@mui/icons-material/Close";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import Visibility from "@mui/icons-material/Visibility";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import PersonOutlinedIcon from "@mui/icons-material/PersonOutlined"; // Not directly used in JSX, but kept for completeness
import CallOutlinedIcon from "@mui/icons-material/CallOutlined"; // Not directly used in JSX, but kept for completeness
import axiosInstance from '../../utils/axiosInstance';
// Assuming profileImg is correctly typed, if it's a static import, it's typically 'string'
import profileImg from "../../assets/images/profileImg.png";
import { useTranslation } from "react-i18next";

// Assuming these paths are correct relative to where this file will be.
// You might need to adjust them based on your project structure.
import "./profile.scss";
import axiosJWT from "../../context/axiosAuthIntercept";
// Assuming this is a configured axios instance
import { message } from "antd"; // Assuming antd library is installed for messages

/**
 * Custom Slide transition component for the Dialog.
 * @param {TransitionProps & { children: React.ReactElement<any, any> }} props - Props for the transition, including children.
 * @param {React.Ref<unknown>} ref - Ref forwarded to the Slide component.
 * @returns {React.ReactElement} The Slide component.
 */
const Transition = React.forwardRef(function Transition(
  props: TransitionProps & {
    children: React.ReactElement<any, any>;
  },
  ref: React.Ref<unknown>
) {
  return <Slide direction="up" ref={ref} {...props} />;
});

/**
 * @typedef {Object} ProfileProps
 * @property {React.ReactNode} children - The content that triggers the profile modal to open.
 */
type ProfileProps = {
  children: React.ReactNode;
};

/**
 * User information structure stored in localStorage.
 * Adjust this type to accurately reflect the content of `userInfo`.
 */
interface UserInfo {
  Client: string;
  Email: string;
  Username: string;
  Password?: string; // Password might be present in some cases, but generally shouldn't be stored in localStorage directly.
  // Add other properties if they exist in localStorage `userInfo`
}

/**
 * Profile Component
 *
 * This component displays and allows modification of user profile details
 * including username, email settings, Telegram integration, and password change.
 * It uses a Material-UI Dialog for a modal interface.
 *
 * @param {ProfileProps} props - The properties for the component.
 * @returns {JSX.Element} The rendered Profile component.
 */
export default function Profile(props: ProfileProps): JSX.Element {
  const { t } = useTranslation();
  // State for controlling the open/close status of the profile modal.
  const [open, setOpen] = useState<boolean>(false);
  // State for user's display name.
  const [userName, setUserName] = useState<string>("");
  // State for the primary admin email address.
  const [email, setEmail] = useState<string>("");
  // State for Telegram bot token.
  const [bot_token, setBot_token] = useState<string>("");
  // State for Telegram chat IDs (comma-separated string).
  const [chat_ids, setChat_ids] = useState<string>("");
  // State for notification email addresses (comma-separated string).
  const [notificationEmail, setNotificationEmail] = useState<string>("");
  // State for alert report email addresses (comma-separated string).
  const [alertReportMail, setAlertReportMail] = useState<string>("");
  // State for the text on the email save button, indicates saving status.
  const [changeEmailText, setChangeEmailText] = useState<string>(t("Save"));
  // States for password change fields. Using `string | undefined` because they can be empty initially.
  const [newPassword, setNewPassword] = useState<string | undefined>(undefined);
  const [confirmPassword, setConfirmPassword] = useState<string | undefined>(undefined);
  const [currentPassword, setCurrentPassword] = useState<string | undefined>(undefined);
  // State to toggle password visibility.
  const [showPassword, setShowPassword] = useState<boolean>(false);
  // State to determine which password field's visibility is being toggled.
  const [passwordIndex, setPasswordIndex] = useState<number>(0); // 0 indicates no password field selected for display
  // State to enable/disable Generative AI features.
  const [genAIfeatures, setGenAIfeatures] = useState<boolean>(false);


  // Retrieve user information from localStorage.
  // Using `as string` because localStorage.getItem returns `string | null`.
  const globalInfo: string | null = window.localStorage.getItem("userInfo");

  /**
   * useEffect hook to parse and set initial username and email from localStorage
   * when the component mounts or `globalInfo` changes.
   */
  useEffect(() => {
    if (globalInfo) {
      try {
        const userInfo: UserInfo = JSON.parse(globalInfo);
        setUserName(userInfo.Client);
        setEmail(userInfo.Email);
      } catch (error) {
        console.error(t("Failed to parse user info from localStorage:"), error);
        // Optionally, handle error, e.g., clear malformed localStorage item
      }
    }
  }, [globalInfo]);

  /**
   * useEffect hook to fetch email details from the backend when the component mounts.
   */
  useEffect(() => {
    get_email_details();
  }, []); // Empty dependency array ensures this runs only once on mount

  /**
   * Fetches email and notification details from the backend.
   * Updates component states with the retrieved information.
   * Assumes `import.meta.env.VITE_GET_EMAIL_DETAILS` is correctly configured.
   */
  const get_email_details = async (): Promise<void> => {
    try {
      const url: string = `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_GET_EMAIL_DETAILS}`;
      const res = await axiosJWT.get(url);

      if (res.data.success === true) {
        // Join arrays with ',' for display in textarea/input
        setNotificationEmail(res.data.notification_email?.join(",") || "");
        setAlertReportMail(res.data.alert_report_email?.join(",") || "");
        setBot_token(res.data.bot_token || "");
        setChat_ids(res.data.chat_ids?.join(",") || "");
        setEmail(res.data.new_email || "");
        setGenAIfeatures(res.data.genai_features || false);
      } else {
        // Handle API success: false case (e.g., log error, show message)
        console.warn(t("Failed to retrieve email details:"), res.data.message);
      }
    } catch (error) {
      console.error(t("Error fetching email details:"), error);
      message.error(t("Failed to load email details. Please try again."));
    }
  };

  /**
   * Opens the profile dialog/modal.
   */
  const handleClickOpen = (): void => {
    setOpen(true);
  };

  /**
   * Closes the profile dialog/modal.
   */
  const handleClose = (): void => {
    setOpen(false);
  };

  /**
   * Sets the `passwordIndex` to show the password for a specific input field.
   * Resets `showPassword` to `false` initially when changing field selection.
   * @param {number} indexNumber - The index representing which password field to display.
   */
  const displaypassword = (indexNumber: number): void => {
    setShowPassword(true); // Changed to true to reveal on click
    setPasswordIndex(indexNumber);
  };

  /**
   * Hides the currently displayed password.
   * Sets `showPassword` to `false`.
   */
  const hidepassword = (): void => {
    setShowPassword(false);
    setPasswordIndex(0); // Reset index when hiding all
  };

  /**
   * Handles the update of email and other related user settings.
   * Validates inputs, formats data, and sends a POST request to the backend.
   * Assumes `import.meta.env.VITE_UPDATE_EMAIL` and `import.meta.env.VITE_UPDATE_EMAIL_DETAILS` are configured.
   *
   * IMPORTANT: The comment `VITE_UPDATE_EMAIL is the old aws link` suggests this might be
   * an outdated or misconfigured endpoint. It's crucial to verify the correct API endpoint
   * for updating email details.
   */
  const changeEmail = async (): Promise<void> => {
    setChangeEmailText(t("Please Wait..."));


    // Parse userInfo from localStorage. Handle potential null `globalInfo`.
    let userInfo: UserInfo | null = null;
    if (globalInfo) {
      try {
        userInfo = JSON.parse(globalInfo);
      } catch (error) {
        console.error(t("Error parsing userInfo from localStorage:"), error);
        message.warn(t('User information could not be loaded. Please log in again.'));
        setChangeEmailText(t("Save"));
        return;
      }
    }

    if (!userInfo?.Username) {
      console.log(userInfo);
      message.warn(t('Username is required.'));
      setChangeEmailText(t("Save"));
      return;
    }
    if (!email) {
      message.warn(t('Admin Email Address is required.'));
      setChangeEmailText(t("Save"));
      return;
    }
    if (!notificationEmail) {
      message.warn(t('Notification Email Address is required.'));
      setChangeEmailText(t("Save"));
      return;
    }

    // Helper to split and trim comma-separated strings into an array of strings
    const splitAndTrim = (input: string): string[] => {
      return input.split(',').map(item => item.trim()).filter(item => item !== '');
    };

    const emailsArray = splitAndTrim(notificationEmail);
    const alertReportEmailsArray = splitAndTrim(alertReportMail);
    const chatIdsArray = splitAndTrim(chat_ids);

    const params = {
      Username: userName,
      Password: userInfo.Password, // WARNING: Sending password from localStorage is highly insecure. Reconsider this approach.
      New_Email: email,
      Notification_Email: emailsArray,
      Alert_Report_Emails: alertReportEmailsArray,
      Bot_token: bot_token,
      Chat_ids: chatIdsArray,
      Gen_AI_features: genAIfeatures,
    };

    try {
      // // First API call for email authentication/update (as per original comment)
      // const awsUpdateResponse = await axiosJWT.post(
      //   `${import.meta.env.VITE_UPDATE_EMAIL}`, // Consider renaming this ENV variable if it's not strictly an AWS link
      //   params
      // );

      // if (awsUpdateResponse.data.statusCode === 200) {
      //   message.success(t("Details are updated successfully"));
      //   const stringifiedEmailList = JSON.stringify(emailsArray);
      //   start_servilence(stringifiedEmailList); // Assuming this needs the stringified array
      //   localStorage.setItem(t("emailList"), stringifiedEmailList);

      // Update details in MongoDB (second API call)
      // Clone params to remove password before sending to the second endpoint if needed
      const mongoUpdateParams = { ...params };
      delete mongoUpdateParams.Password; // Crucial for security if this endpoint doesn't need it.

      await update_email_details(mongoUpdateParams);
      // } else {
      //   message.warning(awsUpdateResponse.data.message || t("Something went wrong. Please try again!"));
      // }
    } catch (err) {
      console.error(t("Error changing email:"), err);
      message.warning(t("Something went wrong. Please try again!"));
    } finally {
      setChangeEmailText(t("Save"));
      setOpen(false); // Close the modal regardless of success or failure
    }
  };

  /**
   * Updates email details in the database (likely MongoDB based on context).
   * This is typically a separate endpoint to save the user's preferences after
   * initial email authentication/validation.
   * Assumes `import.meta.env.VITE_UPDATE_EMAIL_DETAILS` is correctly configured.
   * @param {Object} params - The parameters to send for updating email details.
   */
  const update_email_details = async (params: any): Promise<void> => {
    try {
      const url: string = `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_UPDATE_EMAIL_DETAILS}`;
      const res = await axiosJWT.put(url, params);
      if (res.data.success !== true) {
        console.warn(t("Failed to update email details in DB:"), res.data.message);
        // Optionally show a warning for this specific failure
      }
    } catch (error) {
      console.error(t("Error updating email details in DB:"), error);
      // Optionally show a warning
    }
  };

  /**
   * Toggles the state of the "Enable Gen AI features" checkbox.
   */
  const toggleCheckBox = (): void => {
    setGenAIfeatures((prev) => !prev);
  };

  /**
   * Initiates or updates surveillance settings on the backend.
   * The current implementation has a `return;` which means it will not execute the actual API call.
   * This needs to be reviewed and potentially fixed based on intended functionality.
   * Assumes `import.meta.env.VITE_START_SURVIELLANCE` is correctly configured.
   * @param {string} emailList - A stringified JSON array of emails.
   */
  const start_servilence = async (emailList: string): Promise<void> => {
    // Current implementation includes `return;` which prevents the API call from running.
    // This line should be removed if the API call is intended to execute.
    // return; // <-- REVIEW THIS LINE: Prevents the function from executing further.

    const params = {
      email: emailList,
      type: 'update',
    };
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
    };
    const url: string = `${import.meta.env.VITE_BASE_URL}${import.meta.env.VITE_START_SURVIELLANCE}`;

    try {
      const res = await axiosJWT.post(url, params, { headers });
      if (res.data.success !== true) {
        console.warn(t("Failed to start surveillance:"), res.data.message);
      }
    } catch (error) {
      console.error(t("Error starting surveillance:"), error);
    }
  };

  /**
   * Handles the process of changing the user's password.
   * Validates current, new, and confirmed passwords, then sends a POST request to the backend.
   * Assumes `import.meta.env.VITE_UPDATE_PASSWORD` is correctly configured.
   */
  const changepassword = async (): Promise<void> => {
    if (!currentPassword) {
      message.warn(t('Invalid current password'));
      return;
    }
    if (!newPassword) {
      message.warn(t('Invalid new password'));
      return;
    }
    if (!confirmPassword) {
      message.warn(t('Invalid confirm password'));
      return;
    }
    if (newPassword !== confirmPassword) {
      message.warn(t('New password and confirm password are not matching.'));
      return;
    }

    // Retrieve user info from localStorage to get username
    let userInfo: UserInfo | null = null;
    if (globalInfo) {
      try {
        userInfo = JSON.parse(globalInfo);
      } catch (error) {
        console.error(t("Error parsing userInfo from localStorage:"), error);
        message.warn(t('User information could not be loaded for password change.'));
        return;
      }
    }

    if (!userInfo?.Username) {
      message.warn(t('Username is required for password change.'));
      return;
    }

    const params = {
      Username: userInfo.Username,
      currentPassword: currentPassword,
      newPassword: newPassword,
    };

    try {
      const response = await axiosInstance.post('/update-password', params);

      if (response.status === 200) {
        message.success(t("Password is changed successfully."));
        // Clear password fields after successful change
        setCurrentPassword(undefined);
        setNewPassword(undefined);
        setConfirmPassword(undefined);
        setShowPassword(false);
        setPasswordIndex(0);
      } else {
        message.warn(response.data.message || t("Something went wrong. Please check once again."));
      }
    } catch (error) {
      console.error(t("Error changing password:"), error);
      message.warn(t("Something went wrong. Please try again!"));
    }
  };

  return (
    <div>
      {/* Clickable area that triggers the profile modal */}
      <div onClick={handleClickOpen}>{props.children}</div>

      {/* Material-UI Dialog for the profile modal */}
      <Dialog
        open={open}
        TransitionComponent={Transition}
        keepMounted
        onClose={handleClose}
        aria-describedby="profile-dialog-description" // Descriptive label for accessibility
      >
        <div className="profile-model">
          <div className="profile-header">
            <div className="userInfo">
              <div className="flex-info">
                <img
                  src={profileImg}
                  alt="profile icon"
                  style={{
                    width: "60px",
                    height: "50px",
                    objectFit: "cover",
                    borderRadius: "50%",
                  }}
                />                <div>
                  <h3 className="mb-0">{userName}</h3>
                </div>
              </div>
              {/* Close button for the modal */}
              <CloseIcon className="close-icon" onClick={handleClose} />
            </div>
          </div>
          <div className="flex-main-info">
            <div className="row">
              <div className="col-lg-6">
                <div className="information">
                  <h2>{t("User Information")}</h2>
                  <p className="credential-title">{t("Username")}</p>
                  <div className="flex-input">
                    {/* Username input field */}
                    <input
                      type="text"
                      className="form-control"
                      placeholder={t("Full name")}
                      value={userName}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUserName(e.target.value)}
                    />
                  </div>
                  <p className="credential-title"> {t("From")} </p>

                  <div className="flex-input">
                    {/* Admin Email input field with tooltip */}
                    <Tooltip
                      title={<p style={{ fontSize: "17px", margin: "0", padding: "0" }}>{t("Email notifications will be sent from this email id")}</p>}
                      PopperProps={{ style: { zIndex: 4600 } }}
                      placement="bottom-start"
                    >
                      <input
                        type="text"
                        className="form-control"
                        placeholder={t("Admin Email address")}
                        value={email}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                      />
                    </Tooltip>
                  </div>

                  <p className="credential-title"> {t("To")} </p>

                  <div className="mt-3 flex-input">
                    {/* Notification Email textarea with tooltip */}
                    <Tooltip
                      title={<p style={{ fontSize: "17px", margin: "0", padding: "0" }}>{t("You will receive notifications on this email ID")}</p>}
                      PopperProps={{ style: { zIndex: 4600 } }}
                      placement="bottom-start"
                    >
                      <textarea
                        id="txtid"
                        className="form-control"
                        rows={2}
                        cols={50}
                        maxLength={200}
                        placeholder={t("Notification Email address")}
                        value={notificationEmail}
                        style={{ width: '100%' }}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNotificationEmail(e.target.value)}
                      ></textarea>
                    </Tooltip>
                  </div>

                  <p className="credential-title"> {t("Send alert report to:")} </p>

                  <div className="mt-3 flex-input">
                    {/* Alert Report Email textarea with tooltip */}
                    <Tooltip
                      title={<p style={{ fontSize: "17px", margin: "0", padding: "0" }}>{t("You will receive alert report on this email ID bimonthly")}</p>}
                      PopperProps={{ style: { zIndex: 4600 } }}
                      placement="bottom-start"
                    >
                      <textarea
                        id="txtid"
                        className="form-control"
                        rows={2}
                        cols={50}
                        maxLength={200}
                        placeholder={t("Email address to receive alert report")}
                        value={alertReportMail}
                        style={{ width: '100%' }}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setAlertReportMail(e.target.value)}
                      ></textarea>
                    </Tooltip>
                  </div>

                  <Tooltip title="telegram">
                    <p className="credential-title">{t("Telegram Bot Token")}</p>
                  </Tooltip>
                  <div className="flex-input">
                    {/* Telegram Bot Token input field */}
                    <input
                      type="text"
                      className="form-control"
                      placeholder={t("telegram bot_token")}
                      value={bot_token}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBot_token(e.target.value)}
                    />
                  </div>
                  <p className="credential-title">{t("Telegram Chat IDs")}</p>
                  <div className="flex-input">
                    {/* Telegram Chat IDs input field with tooltip */}
                    <Tooltip
                      title={<p style={{ fontSize: "17px", margin: "0", padding: "0" }}>{t("You will receive telegram notifications on these chat ids")}</p>}
                      PopperProps={{ style: { zIndex: 4600 } }}
                      placement="bottom-start"
                    >
                      <input
                        type="text"
                        className="form-control"
                        placeholder={t("telegram chat ids")}
                        value={chat_ids}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setChat_ids(e.target.value)}
                      />
                    </Tooltip>
                  </div>
                  {/* Checkbox for Gen AI features */}
                  {/* <div className="enable-gen-ai-features" onClick={toggleCheckBox}>
                    <input className="form-check-input" type="checkbox" checked={genAIfeatures} onChange={toggleCheckBox} />
                    <p className="credential-title">{t("Enable Gen AI features")}</p>
                  </div> */}
                </div>
              </div>
              <div className="col-lg-6">
                <div className="change-password">
                  <h2>{t("Change Password")}</h2>
                  {/* Current Password input field */}
                  <div className="flex-input">
                    <LockOutlinedIcon className="lockIcon" />
                    <input
                      type={!(showPassword && passwordIndex === 1) ? "password" : "text"}
                      className="form-control"
                      placeholder={t("Current password")}
                      value={currentPassword || ''} // Handle undefined state
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrentPassword(e.target.value)}
                    />
                    {/* Toggle visibility for Current Password */}
                    {(showPassword && passwordIndex === 1) ? (
                      <Visibility className="pencil-icon" onClick={hidepassword} />
                    ) : (
                      <VisibilityOffIcon className="pencil-icon" onClick={() => displaypassword(1)} />
                    )}
                  </div>
                  {/* New Password input field */}
                  <div className="flex-input">
                    <LockOutlinedIcon className="lockIcon" />
                    <input
                      type={!(showPassword && passwordIndex === 2) ? "password" : "text"}
                      className="form-control"
                      placeholder={t("New password")}
                      value={newPassword || ''} // Handle undefined state
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPassword(e.target.value)}
                    />
                    {/* Toggle visibility for New Password */}
                    {(showPassword && passwordIndex === 2) ? (
                      <Visibility className="pencil-icon" onClick={hidepassword} />
                    ) : (
                      <VisibilityOffIcon className="pencil-icon" onClick={() => displaypassword(2)} />
                    )}
                  </div>
                  {/* Confirm Password input field */}
                  <div className="flex-input">
                    <LockOutlinedIcon className="lockIcon" />
                    <input
                      type={!(showPassword && passwordIndex === 3) ? "password" : "text"}
                      className="form-control"
                      placeholder={t("confirm password")}
                      value={confirmPassword || ''} // Handle undefined state
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmPassword(e.target.value)}
                    />
                    {/* Toggle visibility for Confirm Password */}
                    {(showPassword && passwordIndex === 3) ? (
                      <Visibility className="pencil-icon" onClick={hidepassword} />
                    ) : (
                      <VisibilityOffIcon className="pencil-icon" onClick={() => displaypassword(3)} />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* Action buttons */}
          <div className="flex-btn-pass">
            <button className="btn btn-primary" onClick={changeEmail}>
              {changeEmailText}
            </button>
            <button className="btn btn-reset-pass" onClick={changepassword}>{t("Reset password")}</button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
