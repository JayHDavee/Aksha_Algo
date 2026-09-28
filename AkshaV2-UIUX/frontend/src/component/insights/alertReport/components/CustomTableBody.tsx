import React, { JSX, useState } from 'react';
import { CaretDownOutlined, CaretRightOutlined } from '@ant-design/icons';
import { format } from 'date-fns';
import { Tooltip } from 'antd';
import deliveryTruck from '../../../../assets/images/reportIcons/delivery-truck.png';
import forklift from '../../../../assets/images/reportIcons/forklift.png';
import gateClosed from '../../../../assets/images/reportIcons/gate-closed.png';
import gateOpen from '../../../../assets/images/reportIcons/gate-open.png';
import helmet from '../../../../assets/images/reportIcons/helmet.png';
import motorcycle from '../../../../assets/images/reportIcons/motorcycle.png';
import noHelmet from '../../../../assets/images/reportIcons/no-helmet.png';
import person from '../../../../assets/images/reportIcons/person.png';
import supinePerson from '../../../../assets/images/reportIcons/supine-person.png';
import crowd from '../../../../assets/images/reportIcons/crowd.png';
import backpack from '../../../../assets/images/reportIcons/backpack.png';
import bicycle from '../../../../assets/images/reportIcons/bicycle.png';
import car from '../../../../assets/images/reportIcons/car.png';
import noperson from '../../../../assets/images/reportIcons/noperson.png';
import handbag from '../../../../assets/images/reportIcons/handbag.png';
import { useTranslation } from 'react-i18next';

import { reduceStringSize } from '../../../../utils/reduceStringSize';

interface AlertData {
  timestamp?: string;
  object?: string;
  no_obj_status?: string;
  my_alert_name?: string[];
  link?: string;
}

interface CameraData {
  alerts?: { [time: string]: AlertData };
}

interface Props {
  data: any;
  camName: string;
  showModal: (link: string) => void;
}

const CustomTableBody: React.FC<Props> = ({ data, camName, showModal }) => {
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);

  const renderAlertIcon = (iconData?: string, no_obj_status?: string): JSX.Element | null => {
    if (!iconData) return null;

    let iconUsed: string | null = null;
    switch (iconData.toLowerCase()) {
      case "supine person": iconUsed = supinePerson; break;
      case "crowd": iconUsed = crowd; break;
      case "backpack": iconUsed = backpack; break;
      case "handbag": iconUsed = handbag; break;
      case "car": iconUsed = car; break;
      case "bicycle": iconUsed = bicycle; break;
      case "person": iconUsed = person; break;
      case "no helmet": iconUsed = noHelmet; break;
      case "no person": iconUsed = noperson; break;
      case "helmet": iconUsed = helmet; break;
      case "gate closed": case "gate_close": iconUsed = gateClosed; break;
      case "gate open": case "gate_open": iconUsed = gateOpen; break;
      case "motorbike": iconUsed = motorcycle; break;
      case "truck": iconUsed = deliveryTruck; break;
      case "fork_lift": case "fork lift": iconUsed = forklift; break;
    }

    return iconUsed ? <img src={iconUsed} alt="alert-icon-img" className="alert-named-icon" /> : null;
  };

  const handleIconClass = (index: number): string => (index === 0 || open ? 'shown' : 'hidden');

  const alerts = data[camName]?.alerts;

  return (
    <tbody>
      {alerts && Object.keys(alerts).length > 0 ? (
        Object.keys(alerts).map((timeKey, index) => (
          <tr key={timeKey} className={handleIconClass(index)}>
            {/* Accessible Caret button */}
            <td style={{ width: 10 }}>
              {index === 0 && (
                <button
                  onClick={() => setOpen((prev) => !prev)}
                  aria-label={open ? "Collapse row" : "Expand row"}
                  style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}
                >
                  {open ? <CaretDownOutlined /> : <CaretRightOutlined />}
                </button>
              )}
            </td>

            {/* Show cam name every 2nd row */}
            {index % 2 === 0 ? (
              <td className="cam-name-style">{reduceStringSize(camName)}</td>
            ) : (
              <td></td>
            )}

            {/* Date */}
            <td>{alerts[timeKey]?.timestamp ? format(new Date(alerts[timeKey].timestamp!), 'do MMMM yyyy') : ''}</td>

            {/* Time */}
            <td>{alerts[timeKey]?.timestamp ? format(new Date(alerts[timeKey].timestamp!), 'HH:mm aa') : ''}</td>

            {/* Alert icon and name */}
            <td className="alertName-td">
              <Tooltip title={alerts[timeKey]?.object || ''}>
                <div className="alertname-items-container">
                  <div className="alertname-item-one">
                    {renderAlertIcon(alerts[timeKey]?.object, alerts[timeKey]?.no_obj_status)}
                  </div>
                  <div className="alertname-item-two">
                    {alerts[timeKey]?.my_alert_name?.[0] && (
                      <span>{reduceStringSize(alerts[timeKey].my_alert_name[0])}</span>
                    )}
                  </div>
                </div>
              </Tooltip>
            </td>

            {/* Video link */}
            <td
              className="td-link-style"
              onClick={() => alerts[timeKey]?.link && showModal(alerts[timeKey].link)}
            >
              {alerts[timeKey]?.link ? 'https' : ''}
            </td>
          </tr>
        ))
      ) : (
        <tr className="shown">
          <td style={{ width: 10 }}></td>
          <td colSpan={1} className="cam-name-style">{reduceStringSize(camName)}</td>
          <td className="No-Alerts-Captured" colSpan={4}>{t("No Alerts Captured")}</td>
        </tr>
      )}
    </tbody>
  );
};

export default CustomTableBody;
