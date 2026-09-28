import React from 'react';
import Tooltip from '@mui/material/Tooltip';
import { useTranslation } from 'react-i18next';

interface CameraItem {
  _id: string;
  Camera_Name: string;
  Rtsp_Link: string;
  Priority: string;
  Email_Auto_Alert: boolean;
  Display_Auto_Alert: boolean;
  rowselected: boolean;
}

interface CameraSettingsPanelProps {
  is_mobile: boolean;
  allselected: boolean;
  emailalertstatus: boolean;
  displayalertstatus: boolean;
  cameraemailalerts: boolean;
  cameradisplayalerts: boolean;
  isCamLimitExceeded: boolean;
  cameraList: CameraItem[];
  handleSelectAll: () => void;
  handleemailalerts: () => void;
  handledisplayalerts: () => void;
  update_email_alert: () => void;
  update_display_alert: () => void;
  showaddpage: (mode: number) => void;
  onChangeSingleRowSelected: (id: string) => void;
  onChangeSingleEmailAlerts: (item: CameraItem) => void;
  onChangeSingleDisplayAlerts: (item: CameraItem) => void;
  showeditpage: (item: CameraItem) => void;
  showviewpage: (item: CameraItem) => void;
  showdeletemodal: (item: CameraItem) => void;
}

const CameraSettingsPanel: React.FC<CameraSettingsPanelProps> = ({
  allselected,
  emailalertstatus,
  displayalertstatus,
  cameraemailalerts,
  cameradisplayalerts,
  isCamLimitExceeded,
  cameraList,
  handleSelectAll,
  handleemailalerts,
  handledisplayalerts,
  update_email_alert,
  update_display_alert,
  showaddpage,
  onChangeSingleRowSelected,
  onChangeSingleEmailAlerts,
  onChangeSingleDisplayAlerts,
  showeditpage,
  showviewpage,
  showdeletemodal
}) => {

  const { t } = useTranslation();

  const alertOptions = [
    { label: t('Email alerts'), checked: cameraemailalerts, onChange: update_email_alert },
    { label: t('Display alerts'), checked: cameradisplayalerts, onChange: update_display_alert }
  ];

  return (
    <div className="container pb-4" style={{ paddingTop: 30 }}>
      {/* Top Panel */}
      <div className="row align-items-center mb-3">
        {/* Left: checkboxes */}
        <div className="col-lg-9 d-flex flex-wrap gap-3 align-items-center">
          <div className="d-flex align-items-center me-3">
            <input
              className="form-check-input"
              checked={allselected}
              type="checkbox"
              id="select-all"
              onChange={handleSelectAll}
            />
            <label className="form-check-label ms-2" htmlFor="select-all" style={{ fontSize: 16 }}>
              {t("All")}
            </label>
          </div>

          {alertOptions.map(({ label, checked, onChange }, i) => (
            <div className="d-flex align-items-center me-3" key={i}>
              <input
                className="form-check-input"
                type="checkbox"
                checked={checked}
                onChange={onChange}
                disabled={!allselected}
              />
              <label className="form-check-label ms-2" style={{ fontSize: 16 }}>
                {label}
              </label>
            </div>
          ))}
        </div>

        {/* Right: Add Button */}
        <div className="col-lg-3 text-end">
          <button
            className={!isCamLimitExceeded ? 'btn btn-primary addcam' : 'btn btn-secondary disabled addcam'}
            onClick={() => showaddpage(1)}
          >
            {t("Add New Camera")}
          </button>
        </div>
      </div>

      {/* Camera Table */}
      <div className="table-responsive classy-table-card">
        <table className="table classy-table">
          <thead>
            <tr>
              <th></th>
              <th>Sr.No</th>
              <th>
                {t("Camera")}
              </th>
              <th>{t("Link")}</th>
              <th>{t("Priority")}</th>
              <th style={{ width: '150px', whiteSpace: 'nowrap' }}>{t("Actions")}</th>            </tr>
          </thead>
          <tbody>
            {cameraList?.length > 0 ? (
              cameraList.map((item, index) => (
                <tr key={item._id}>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      checked={item.rowselected}
                      onChange={() => onChangeSingleRowSelected(item._id)}
                      className="form-check-input"
                    />
                  </td>
                  <td className="text-center">{index + 1}</td>
                  <td>{item.Camera_Name}</td>
                  <td className="text-break">{item.Rtsp_Link}</td>
                  <td className="text-center text-capitalize">{item.Priority}</td>
                  <td className="text-center">
                    <Tooltip title={t("Edit Camera")}>
                      <button className="btn btn-link p-1 editcam" onClick={() => showeditpage(item)}>
                        <i className="bx bx-edit-alt text-primary fs-5" />
                      </button>
                    </Tooltip>
                    <Tooltip title={t("View Camera")}>
                      <button className="btn btn-link p-1 viewcam" onClick={() => showviewpage(item)}>
                        <i className="bx bx-show text-info fs-5" />
                      </button>
                    </Tooltip>
                    <Tooltip title={t("Delete Camera")}>
                      <button className="btn btn-link p-1 deletecam" onClick={() => showdeletemodal(item)}>
                        <i className="bx bx-trash text-danger fs-5" />
                      </button>
                    </Tooltip>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="text-center text-muted py-4">
                  {t("No cameras available")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CameraSettingsPanel;