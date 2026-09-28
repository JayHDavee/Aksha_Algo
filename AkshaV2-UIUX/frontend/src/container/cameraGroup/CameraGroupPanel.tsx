import React from "react";
import Tooltip from "@mui/material/Tooltip";
import { useTranslation } from "react-i18next";

interface CameraGroup {
  _id: string;
  group_name: string;
  description: string;
}


interface CameraGroupPanelProps {
  groupList: CameraGroup[];
  showAddGroup: () => void;
  showeditpage: (group: CameraGroup) => void;
  showviewpage: (group: CameraGroup) => void;
  showdeletemodal: (group: CameraGroup) => void;
}

const CameraGroupPanel: React.FC<CameraGroupPanelProps> = ({
  groupList,
  showAddGroup,
  showeditpage,
  showviewpage,
  showdeletemodal,
}) => {
  
  const { t } = useTranslation();

  return (
    <div className="container pb-4" style={{ paddingTop: 30 }}>
      {/* Header Row */}
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div className="d-flex gap-4 align-items-center">
        
        </div>
        <button className="btn btn-primary px-4" onClick={showAddGroup}>
          {t("Create New Group")}
        </button>
      </div>

      {/* Table */}
      <div className="table-responsive classy-table-card">
        <table className="table classy-table align-middle">
          <thead>
            <tr>
              <th style={{ width: "10%" }}>{t("Sr. No")}</th>
              <th style={{ width: "25%" }}>{t("Group Name")}</th>
              <th style={{ width: "45%" }}>{t("Description")}</th>
              <th style={{ width: "20%" }} className="text-center">
                {t("Actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {groupList?.length > 0 ? (
              groupList.map((group, index) => (
                <tr key={group._id}>
                  <td className="text-center">{index + 1}</td>
                  <td>{group.group_name}</td>
                  <td>{group.description}</td>
                  <td className="text-center">
                    
                    <Tooltip title={t("Edit Group")}>
                      <button
                        className="btn btn-link p-1"
                        onClick={() => showeditpage(group)}
                      >
                        <i className="bx bx-edit-alt text-primary fs-5"></i>
                      </button>
                    </Tooltip>
                    <Tooltip title={t("View Group")}>
                      <button
                        className="btn btn-link p-1"
                        onClick={() => showviewpage(group)}
                      >
                        <i className="bx bx-show text-info fs-5"></i>
                      </button>
                    </Tooltip>
                    <Tooltip title={t("Delete Group")}>
                      <button
                        className="btn btn-link p-1"
                        onClick={() => showdeletemodal(group)}
                      >
                        <i className="bx bx-trash text-danger fs-5"></i>
                      </button>
                    </Tooltip>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="text-center text-muted py-4">
                  {t("No camera groups available")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default React.memo(CameraGroupPanel);
