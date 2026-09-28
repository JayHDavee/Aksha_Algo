import React, { useState, useEffect } from "react";
import { useSelector } from "react-redux";
import { useApi } from "../../hooks/useApi";
import { useTranslation } from "react-i18next";

import AddGroup from "./List/AddGroup";
import Edit from "./List/Edit";
import CameraNotificationPanel from "./CameraNotificationPanel";
import SystemHealthSettings from "./SystemHealthSettings";

import "./List/notification.scss";
import { CircularProgress, Box } from "@mui/material";
import Messagebox from "../../component/common/Messagebox";
import Modal from "react-bootstrap/Modal";
import Button from "react-bootstrap/Button";

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

interface NotificationManagerType {
  _id: string;
  camera_group_id?: any;
  email: { enabled: boolean; email_list: string };
  mobile_app?: { enabled: boolean; mobile_ids: string }; // ← added
  mobile: { enabled: boolean; mobile_numbers: string };
  telegram: { enabled: boolean; bot_token: string; chat_id: string };
  alerts_enabled: boolean;
}

const CameraNotificationManager: React.FC<any> = ({
  setActiveTab,
  setCamDirectory,
}) => {
  const { callApi } = useApi();
  const { t } = useTranslation();

  const { is_mobile } = useSelector((state: any) => state.isMobileDevice);

  const [activescreen, setActivescreen] = useState<0 | 1>(0);
  const [tableloader, setTableloader] = useState(false);
  const [list, setList] = useState<NotificationManagerType[]>([]);
  const [selected, setSelected] = useState<NotificationManagerType | null>(null);

  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [warning, setWarning] = useState(false);

  const [deleteModal, setDeleteModal] = useState(false);
  const [deleteId, setDeleteId] = useState("");
  const [deleteItem, setDeleteItem] = useState<NotificationManagerType | null>(null); // ← added

  const handleClose = () => setOpen(false);

  useEffect(() => {
    if (localStorage.getItem("isLoggedIn") !== "true") {
      window.location.assign("/monitor");
      return;
    }
    load();
  }, []);

  const load = () => {
    setTableloader(true);
    callApi(`${VITE_base_url}/api/notification`, { method: "GET" })
      .then((res: any) => {
        setList(res.data?.data ?? []);
        setTableloader(false);
      })
      .catch(() => {
        setMessage(t("genericError"));
        setWarning(true);
        setOpen(true);
        setTableloader(false);
      });
  };

  const showAddGroup = () => {
    setSelected(null);
    setActivescreen(1);
    setCamDirectory(false);
    setActiveTab("notification");
  };

  const showEdit = (item: NotificationManagerType) => {
    setSelected(item);
    setActivescreen(1);
    setCamDirectory(true);
  };

  const showDelete = (item: NotificationManagerType) => {
    setDeleteId(item._id);
    setDeleteItem(item); // ← store full item for DynamoDB sync
    setDeleteModal(true);
  };

  const deleteManager = () => {
    // ── Get mobile_ids and group info before deleting ─────────────────────────
    const mobileIds  = deleteItem?.mobile_app?.mobile_ids ?? "";
    const groupId    =
      typeof deleteItem?.camera_group_id === "object"
        ? deleteItem?.camera_group_id?._id
        : deleteItem?.camera_group_id ?? "";
    const groupName  =
      typeof deleteItem?.camera_group_id === "object"
        ? deleteItem?.camera_group_id?.group_name
        : "";

    callApi(`${VITE_base_url}/api/notification/${deleteId}`, { method: "DELETE" })
      .then(() => {

        // ── Sync DynamoDB: remove group from all mobile users ─────────────────
        if (mobileIds && groupId && groupName) {
          callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/update-groups`, {
            method: "POST",
            body: {
              mobile_ids: mobileIds,
              group_id:   groupId,
              group_name: groupName,
              action:     "remove",
            },
          }).catch((err: any) =>
            console.error("updateGroups DynamoDB sync failed on delete:", err)
          );
        }
        // ─────────────────────────────────────────────────────────────────────

        setMessage(t("Deleted successfully"));
        setWarning(false);
        setOpen(true);
        load();
        setDeleteModal(false);
        setDeleteItem(null);
      })
      .catch(() => {
        setMessage(t("genericError"));
        setWarning(true);
        setOpen(true);
      });
  };

  if (tableloader)
    return (
      <Box sx={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }}>
        <CircularProgress />
      </Box>
    );

  return (
    <>
      <Messagebox open={open} handleClose={handleClose} message={message} warning={warning} />

      {activescreen === 0 ? (
        <>
          <SystemHealthSettings />
          <CameraNotificationPanel
            is_mobile={is_mobile}
            list={list}
            showAddGroup={showAddGroup}
            showeditpage={showEdit}
            showdeletemodal={showDelete}
            refreshList={load}
          />
        </>
      ) : selected ? (
        <Edit data={selected} back={() => {
          setActivescreen(0);
          setCamDirectory(true);
        }} loadlist={load} />
      ) : (
        <AddGroup back={() => {
          setActivescreen(0);
          setCamDirectory(true);
        }} refresh={load} />
      )}

      <Modal show={deleteModal} onHide={() => setDeleteModal(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title>{t("Delete Confirmation")}</Modal.Title>
        </Modal.Header>
        <Modal.Body>{t("Are you sure you want to delete notification manager?")}</Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDeleteModal(false)}>
            {t("Cancel")}
          </Button>
          <Button variant="danger" onClick={deleteManager}>
            {t("Delete")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
};

export default CameraNotificationManager;