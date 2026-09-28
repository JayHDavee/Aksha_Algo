import React, { useEffect, useState } from "react";
import Tooltip from "@mui/material/Tooltip";
import { useTranslation } from "react-i18next";
import axios from "axios";
import { toast } from "react-toastify";
import AddMobileUser from "./AddMobileUser";
import { useApi } from "../../hooks/useApi";

interface MobileUsersProps {
  setCamDirectory?: React.Dispatch<React.SetStateAction<boolean>>;
}

const MobileUsers: React.FC<MobileUsersProps> = ({ setCamDirectory }) => {
  const { t } = useTranslation();
  const { callApi } = useApi();
  const [siteId, setSiteId] = useState<string>("Loading...");
  const [activescreen, setActivescreen] = useState<0 | 1>(0);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);

  // Fetching site ID from localStorage correctly
  useEffect(() => {
    const localSiteId = localStorage.getItem("siteId") || "";
    setSiteId(localSiteId);
  }, []);

  const [mobileUsers, setMobileUsers] = useState<any[]>([]);

  // Fetching mobile users from the backend
  useEffect(() => {
    if (!siteId || siteId === "Loading...") return;

    callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile-users?siteId=${siteId}`, {
      method: "GET",
    })
      .then((res: any) => setMobileUsers(res.data?.users || []))
      .catch((error: any) => {
        console.error("Failed to fetch mobile users", error);
        setMobileUsers([]);
      });
  }, [siteId, callApi]);

  const handleAddUser = async (userPayload: any) => {
    try {
      const response = await axios.post(
        "https://hbzo58z4zk.execute-api.ap-south-1.amazonaws.com/prod/mobile/register",
        userPayload
      );
      
      if (response.status === 201) {
        toast.success(t("Account created successfully"));
        setMobileUsers([response.data, ...mobileUsers]);
      }
    } catch (error: any) {
      if (error.response?.status === 409) {
        toast.error(error.response.data.message || t("An account with this email/username already exists"));
      } else if (error.response?.status === 400) {
        toast.error(t("Validation failed. Please check your inputs."));
      } else {
        toast.error(t("Internal server error while creating user"));
      }
      throw error; // Re-throw to be caught by the modal
    }
  };

  const handleDelete = async (email: string) => {
    if (window.confirm(t("Are you sure you want to delete this mobile user?"))) {
      try {
        await callApi(`${import.meta.env.VITE_AUTHENCTICATE_USER}/mobile/delete?email=${email}`, {
          method: "DELETE",
        });
        toast.success(t("User deleted successfully"));
        setMobileUsers(mobileUsers.filter((user) => user.email !== email));
      } catch (error) {
        toast.error(t("Failed to delete user"));
        console.error("Delete error:", error);
      }
    }
  };

  const handleView = (user: any) => {
    setSelectedUser(user);
    setIsViewModalOpen(true);
  };

  return (
    <div className="container pb-4" style={{ paddingTop: 30 }}>
      {activescreen === 0 ? (
        <>
          {/* Header */}
          <div className="d-flex justify-content-end mb-3">
            <button 
              className="btn btn-primary px-4"
              onClick={() => {
                setActivescreen(1);
                if (setCamDirectory) setCamDirectory(false);
              }}
            >
              {t("Add mobile user")}
            </button>
          </div>

      {/* Table */}
      <div className="table-responsive classy-table-card">
      <table className="table classy-table align-middle">
        <thead>
          <tr>
            <th>{t("Username")}</th>
            <th>{t("Email")}</th>
            <th>{t("Site ID")}</th>
            <th>{t("Mobile ID")}</th>
            <th>{t("Actions")}</th>
          </tr>
        </thead>
        <tbody>
          {mobileUsers.map((item) => {
            return (
              <tr key={item.mobile_id || item._id}>
                <td>{item.username}</td>
                <td>{item.email}</td>
                <td>{siteId}</td>
                <td>{item.mobile_id}</td>
                <td>
                  <Tooltip title={t("View")}>
                    <button className="btn btn-link p-1" onClick={() => handleView(item)}>
                      <i className="bx bx-show text-info fs-5"></i>
                    </button>
                  </Tooltip>

                  <Tooltip title={t("Delete")}>
                    <button className="btn btn-link p-1" onClick={() => handleDelete(item.email)}>
                      <i className="bx bx-trash text-danger fs-5"></i>
                    </button>
                  </Tooltip>
                </td>
              </tr>
            );
          })}
          {mobileUsers.length === 0 && (
            <tr>
              <td colSpan={5} className="text-center py-4 text-muted">
                {t("No mobile users found.")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
        </>
      ) : (
        <AddMobileUser 
          back={() => {
            setActivescreen(0);
            if (setCamDirectory) setCamDirectory(true);
          }} 
          onAddUser={handleAddUser}
          siteId={siteId}
        />
      )}

      {/* View Modal */}
      {isViewModalOpen && selectedUser && (
        <div className="modal show d-block" style={{ backgroundColor: "rgba(0,0,0,0.5)" }} tabIndex={-1}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">{t("Mobile User Details")}</h5>
                <button type="button" className="btn-close" onClick={() => setIsViewModalOpen(false)}></button>
              </div>
              <div className="modal-body">
                <p><strong>{t("Username")}:</strong> {selectedUser.username}</p>
                <p><strong>{t("Email")}:</strong> {selectedUser.email}</p>
                <p><strong>{t("Site ID")}:</strong> {siteId}</p>
                <p><strong>{t("Mobile ID")}:</strong> {selectedUser.mobile_id}</p>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsViewModalOpen(false)}>
                  {t("Close")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MobileUsers;
