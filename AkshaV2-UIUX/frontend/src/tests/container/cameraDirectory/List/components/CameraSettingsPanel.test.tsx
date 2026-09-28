import React from 'react';
import { render } from '@testing-library/react';
import CameraSettingsPanel from '../../../../../container/cameraDirectory/List/components/CameraSettingsPanel';
describe('CameraSettingsPanel Component', () => {
  const defaultProps = {
    is_mobile: false,
    allselected: false,
    emailalertstatus: false,
    displayalertstatus: false,
    cameraemailalerts: false,
    cameradisplayalerts: false,
    isCamLimitExceeded: false,
    cameraList: [
      {
        _id: '1',
        Camera_Name: 'Camera 1',
        Rtsp_Link: 'rtsp://link1',
        Priority: 'High',
        Email_Auto_Alert: true,
        Display_Auto_Alert: false,
        rowselected: false,
      },
    ],
    handleSelectAll: jest.fn(),
    handleemailalerts: jest.fn(),
    handledisplayalerts: jest.fn(),
    update_email_alert: jest.fn(),
    update_display_alert: jest.fn(),
    showaddpage: jest.fn(),
    onChangeSingleRowSelected: jest.fn(),
    onChangeSingleEmailAlerts: jest.fn(),
    onChangeSingleDisplayAlerts: jest.fn(),
    showeditpage: jest.fn(),
    showviewpage: jest.fn(),
    showdeletemodal: jest.fn(),
  };

  it('renders without crashing', () => {
    const { getByText } = render(<CameraSettingsPanel {...defaultProps} />);
    expect(getByText(/Add New Camera/i)).toBeInTheDocument();
  });

  // Additional tests for other checkboxes and actions can be added here
});
