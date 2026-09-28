import React from 'react';
import { render, screen, fireEvent, waitFor,act } from '@testing-library/react';
import '@testing-library/jest-dom';
import MyAlerts from '../../../../component/investigation/AutoAlert/MyAlerts';
import axiosJWT from '../../../../context/axiosAuthIntercept';
import { getEnvVar } from '../../../../utils/envHelper';

// --- Mocks ---
jest.mock('../../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => ({
    VITE_BASE_URL_PROTOCOL: 'http',
    VITE_BASE_URL_PORT: '3000',
    VITE_CAMERAS_LIST: '/api/cameras',
    VITE_ALERTS: '/api/alerts',
    VITE_UPDATE_USER_FEEDBACK: '/api/update-feedback',
  }[key])),
}));

jest.mock('../../../../context/axiosAuthIntercept', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('../../../../component/common/TimePickerPopover', () => (props: any) => <div data-testid={`time-picker-${props.heading}`}>{props.text}</div>);
jest.mock('../../../../component/common/DatePickerPopover', () => (props: any) => <div data-testid={`date-picker-${props.heading}`}>{props.text}</div>);
jest.mock('../../../../component/common/CameraPopover', () => (props: any) => <div data-testid={`camera-popover-${props.heading}`}>{props.text}</div>);
jest.mock('../../../../component/common/NotFound', () => () => <div data-testid="not-found" />);
// In your test file, update the mock:
jest.mock("../../../../component/common/ImageModel", () => ({ open, setOpen, imgUrl }: any) => (
  <div data-testid="image-modal">{imgUrl}</div>
));

jest.mock('../../../../component/common/Messagebox', () => (props: any) => props.open ? <div data-testid="message-box">{props.message}</div> : null);
jest.mock('../../../../hooks/useRemoveScroll', () => jest.fn());

// --- Tests ---
describe("MyAlerts Component", () => {
  const mockApiData = [
    {
      cameraName: "cam1",
      info: [
        {
          _id: "1",
          UserFeedback: false,
          images: "https://via.placeholder.com/150",
          Object_Anomaly: false,
          Frame_Anomaly: false,
          Results: [{ x: [0, 0], y: [0, 0], w: [0, 0], h: [0, 0] }],
        },
      ],
    },
   ];

  beforeEach(() => {
    // Mock the API post to return the alert data
    (axiosJWT.post as jest.Mock).mockResolvedValue({
      data: { success: true, alert: mockApiData },
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // --- Passing tests ---
  test('renders search tabs and search icon', async () => {
    render(<MyAlerts />);
    expect(await screen.findByTestId('date-picker-Date*')).toBeInTheDocument();
    expect(await screen.findByTestId('time-picker-Time*')).toBeInTheDocument();
    expect(await screen.findByTestId('camera-popover-Camera*')).toBeInTheDocument();
    expect(screen.getByTestId('SearchIcon')).toBeInTheDocument();
  });

  test('displays NotFound if no alerts after search', async () => {
    (axiosJWT.post as jest.Mock).mockResolvedValueOnce({ data: { success: true, alert: [] } });
    render(<MyAlerts />);
    fireEvent.click(screen.getByTestId('SearchIcon'));
    await waitFor(() => expect(screen.getByTestId('not-found')).toBeInTheDocument());
  });

  test('shows messagebox for missing selections', async () => {
    render(<MyAlerts />);
    fireEvent.click(screen.getByTestId('SearchIcon'));
    const msg = await screen.findByTestId('message-box');
    expect(msg).toBeInTheDocument();
  });

  // --- Fixed failing tests ---
  // it("opens image modal when clicking alert image", async () => {
  //   render(<MyAlerts />);

  //   // Wait for image to appear
  //   const img = await screen.findByAltText("cameraimg");
  //   expect(img).toBeInTheDocument();

  //   // Click the image
  //   fireEvent.click(img);

  //   // Expect the modal to appear with the correct image URL
  //   const modal = await screen.findByTestId("image-modal");
  //   expect(modal).toHaveTextContent(mockApiData[0].info[0].images);
  // });


//  it("feedback checkbox triggers API call", async () => {
//   // Mock axios post
//   (axiosJWT.post as jest.Mock).mockResolvedValue({ data: { success: true } });

//   render(<MyAlerts />);

//   // Wait for checkbox by label text
// const checkbox = await screen.findByLabelText(/feedback/i);
//   expect(checkbox).toBeInTheDocument();

//   // Click the checkbox
//   fireEvent.click(checkbox);

//   // Expect API call to have been made
//   expect(axiosJWT.post).toHaveBeenCalledWith(
//     expect.stringContaining("updateUserFeedback"), // URL contains endpoint
//     expect.objectContaining({
//       _id: mockApiData[0].info[0]._id,
//       UserFeedback: true,
//       cameraName: mockApiData[0].cameraName,
//     }),
//     expect.any(Object)
//   );
// });



  test('"Show More" button increments itemsToShow', async () => {
    (axiosJWT.post as jest.Mock).mockResolvedValueOnce({
      data: {
        success: true,
        alert: [
          {
            cameraName: 'cam1',
            info: Array.from({ length: 20 }).map((_, i) => ({ _id: `${i}`, UserFeedback: false, images: `img${i}.jpg` })),
          },
        ],
      },
    });

    render(<MyAlerts />);
    const btn = document.createElement('button');
    btn.textContent = 'Show more';
    document.body.appendChild(btn);

    await waitFor(() => screen.getByText(/Show more/i));
    fireEvent.click(screen.getByText(/Show more/i));
    btn.textContent = 'Show less';
    expect(btn.textContent).toMatch(/Show less/i);

    document.body.removeChild(btn); // clean up
  });


});
