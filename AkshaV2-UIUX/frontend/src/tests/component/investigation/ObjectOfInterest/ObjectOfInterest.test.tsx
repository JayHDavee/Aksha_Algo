import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import ObjectOfInterest from "../../../../component/investigation/ObjectOfInterest/ObjectOfInterest";

const mockStore = configureStore([]);
jest.mock("../../../../utils/envHelper", () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: "http",
      VITE_BASE_URL_PORT: "5000",
      // Add other keys as needed
    };
    return envs[key] || "";
  }),
}));

// Corrected paths — ALWAYS ../../../../component/...
jest.mock('../../../../component/common/DatePickerPopover', () => (props: any) => (
  <div data-testid="date-picker-popover">{props.text}</div>
));

jest.mock('../../../../component/common/TimePickerPopover', () => (props: any) => (
  <div data-testid="time-picker-popover">{props.text}</div>
));

jest.mock('../../../../component/common/CameraPopover', () => (props: any) => (
  <div data-testid="camera-popover">{props.text}</div>
));

jest.mock('../../../../component/investigation/ObjectOfInterest/AreaOfInterest', () => (props: any) => (
  <div data-testid="area-of-interest">{props.text}</div>
));

jest.mock('../../../../component/common/Truck', () => (props: any) => (
  <div data-testid="truck">{props.text}</div>
));

jest.mock('../../../../component/common/NotFound', () => () => <div>No Alerts Found</div>);

jest.mock('../../../../component/common/Messagebox', () => (props: any) => (
  props.open ? <div>{props.message}</div> : null
));

jest.mock('../../../../component/common/CanvasFramesObj', () => () => (
  <div>ImageBox Component</div>
));

describe('ObjectOfInterest Component', () => {
  let store: any;

  beforeEach(() => {
    store = mockStore({
      investigation: {
        isCoordinatesSelected: true,
        allCameraNames: [
          { _id: '1', Camera_Name: 'Camera 1', Active: true },
          { _id: '2', Camera_Name: 'Camera 2', Active: false },
        ],
      },
    });
  });

  it('renders ObjectOfInterest component with initial state', () => {
    const { getByTestId } = render(
      <Provider store={store}>
        <ObjectOfInterest />
      </Provider>
    );

    expect(getByTestId('date-picker-popover')).toBeInTheDocument();
    expect(getByTestId('time-picker-popover')).toBeInTheDocument();
    expect(getByTestId('camera-popover')).toBeInTheDocument();
    expect(getByTestId('area-of-interest')).toBeInTheDocument();
    expect(getByTestId('truck')).toBeInTheDocument();
  });
});
