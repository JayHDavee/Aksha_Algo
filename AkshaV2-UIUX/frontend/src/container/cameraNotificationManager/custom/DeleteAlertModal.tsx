import React, { useState, useEffect } from "react";
import axios from "axios";
import { message as antdMessage } from "antd";
import { useTranslation } from "react-i18next";
import Tooltip from "@mui/material/Tooltip";
import Checkbox from "@mui/material/Checkbox";
import Modal from "react-bootstrap/Modal";
import Button from "react-bootstrap/Button";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

interface DeleteProps {
  data: any;
  onRefresh: () => void;
}

const DeleteAlertModal: React.FC<DeleteProps> = ({ data, onRefresh }) => {
  const { t } = useTranslation();

  /**
   * SAFE BOOLEAN DEFAULTS
   */
  const [isModalVisible, setVisible] = useState<boolean>(false);

  const [channels, setChannels] = useState({
    email: Boolean(data?.email?.enabled),
    mobile: Boolean(data?.mobile?.enabled),
    telegram: Boolean(data?.telegram?.enabled),
  });

  useEffect(() => {
    setChannels({
      email: Boolean(data?.email?.enabled),
      mobile: Boolean(data?.mobile?.enabled),
      telegram: Boolean(data?.telegram?.enabled),
    });
  }, [data]);

  const handleCancel = (): void => setVisible(false);

  /**
   * DELETE MANAGER
   */
  const deleteManager = async (): Promise<void> => {
    try {
      const url = `${VITE_base_url}/api/notification/${data._id}`;

      const response = await axios.delete(url);

      antdMessage.success(t("Notification Manager deleted successfully"));
      setVisible(false);

      onRefresh();
    } catch (err: any) {
      antdMessage.warning(t("genericError"));
    }
  };

  /**
   * TOGGLE CHANNEL FOR THIS GROUP
   */
  const toggleChannel = async (
    channel: "email" | "mobile" | "telegram",
    enabled: boolean
  ): Promise<void> => {
    try {
      const url = `${VITE_base_url}/api/notification/toggle/channel/${channel}/${data._id}`;

      await axios.put(url, { enabled });

      antdMessage.success(`${channel} ${enabled ? "enabled" : "disabled"}`);
      onRefresh();
    } catch (err: any) {
      antdMessage.warning(t("genericError"));
    }
  };

  return (
    <>
      <Tooltip title={t("Delete Notification")}>
        <i
          onClick={() => setVisible(true)}
          className="bx bx-trash text-danger fs-5"
        />
      </Tooltip>

      <Modal show={isModalVisible} onHide={handleCancel} centered>
        <Modal.Header closeButton>
          <Modal.Title>
            {t("Delete Notification Manager")}
          </Modal.Title>
        </Modal.Header>

        <Modal.Body>
          <p>{t("Disable channels before delete if needed")}</p>

          <div className="mt-2">
            <Checkbox
              checked={channels.email}
              onChange={(e) =>
                toggleChannel("email", e.target.checked)
              }
            />
            {t("Email")}
          </div>

          <div className="mt-2">
            <Checkbox
              checked={channels.mobile}
              onChange={(e) =>
                toggleChannel("mobile", e.target.checked)
              }
            />
            {t("Mobile")}
          </div>

          <div className="mt-2">
            <Checkbox
              checked={channels.telegram}
              onChange={(e) =>
                toggleChannel("telegram", e.target.checked)
              }
            />
            {t("Telegram")}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="secondary" onClick={handleCancel}>
            {t("Cancel")}
          </Button>

          <button className="deletebutton" onClick={deleteManager}>
            {t("Delete")}
          </button>
        </Modal.Footer>
      </Modal>
    </>
  );
};

export default React.memo(DeleteAlertModal);
