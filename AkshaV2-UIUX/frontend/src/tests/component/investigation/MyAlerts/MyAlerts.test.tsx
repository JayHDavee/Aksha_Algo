import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
jest.mock("../../../../utils/envHelper", () => ({
  getEnvVar: jest.fn((key) => {
    const mockEnv = {
      VITE_BASE_URL_PROTOCOL: "http",
      VITE_BASE_URL_PORT: "5000",
    };

    return mockEnv[key];
  }),
}));

import MyAlerts from "../../../../component/investigation/MyAlerts/MyAlerts";

const mockStore = configureStore([]);

jest.mock('../../../../component/common/DatePickerPopover', () => (props: any) => (
  <div data-testid="date-picker-popover">{props.text}</div>
));
jest.mock('../../../../component/common/TimePickerPopover', () => (props: any) => (
  <div data-testid="time-picker-popover">{props.text}</div>
));
jest.mock('../../../../component/common/CameraPopover', () => (props: any) => (
  <div data-testid="camera-popover">{props.text}</div>
));
jest.mock('../../../../component/common/NotFound', () => () => <div>No Alerts Found</div>);
jest.mock('../../../../component/common/ImageModel', () => (props: any) => (
  props.open ? <div>Image Model Open</div> : null
));
jest.mock('../../../../component/common/Messagebox', () => (props: any) => (
  props.open ? <div>{props.message}</div> : null
));
jest.mock('../../../../component/investigation/ChatPopover/ChatPopover', () => (props: any) => (
  <dialog ref={props.modalRef}>Chat Popover</dialog>
));

describe('MyAlerts Component', () => {
  let store: any;

  beforeEach(() => {
    store = mockStore({
      investigation: {
        allCameraNames: [
          { _id: '1', Camera_Name: 'Camera 1', Active: true },
          { _id: '2', Camera_Name: 'Camera 2', Active: false },
        ],
      },
    });
  });

  it('renders MyAlerts component with initial state', () => {
    const { getByTestId } = render(
      <Provider store={store}>
        <MyAlerts />
      </Provider>
    );

    expect(getByTestId('date-picker-popover')).toBeInTheDocument();
    expect(getByTestId('time-picker-popover')).toBeInTheDocument();
    expect(getByTestId('camera-popover')).toBeInTheDocument();
  });
});
