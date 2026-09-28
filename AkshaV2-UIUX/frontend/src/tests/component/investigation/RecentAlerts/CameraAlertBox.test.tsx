import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CameraAlertBox from '../../../../component/investigation/RecentAlerts/CameraAlertBox';

// ─── Mock envHelper ───────────────────────────────────────────────────────────
jest.mock('../../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: "http",
      VITE_BASE_URL_PORT: "3000",
      VITE_ALERTS: "/api/alerts",
      VITE_UPDATE_USER_FEEDBACK: "/api/feedback",
      VITE_CAMERAS_LIST: "/api/cameras",
    };
    return envs[key] || "";
  }),
}));

// ─── Mock Subcomponents ───────────────────────────────────────────────────────
jest.mock('../../../../component/common/ImageModel', () => (props: any) =>
  props.open ? <div>ImageModel Open</div> : null
);

jest.mock('../../../../component/investigation/ChatPopover/ChatPopover', () => (props: any) => (
  <dialog ref={props.modalRef}>ChatPopover</dialog>
));

describe('CameraAlertBox Component', () => {
  const mockData = {
    cameraName: 'Camera 1',
    images: ['image1.jpg', 'image2.jpg', 'image3.jpg', 'image4.jpg', 'image5.jpg'],
  };

  it('renders CameraAlertBox and shows initially visible images', () => {
    render(<CameraAlertBox data={mockData} indexed={0} />);

    expect(screen.getByText('Camera 1')).toBeInTheDocument();

    // Only first 4 images are visible by default
    const images = screen.getAllByAltText('camera img');
    expect(images.length).toBe(4);

    // Optional: verify the src attributes of displayed images
    images.forEach((img, index) => {
      expect(img).toHaveAttribute('src', mockData.images[index]);
    });
  });

  it('reveals all images after clicking "Show more"', () => {
    render(<CameraAlertBox data={mockData} indexed={0} />);

    // Click "Show more" to reveal the hidden image(s)
    const showMoreButton = screen.getByText(/Show more/i);
    fireEvent.click(showMoreButton);

    const images = screen.getAllByAltText('camera img');
    expect(images.length).toBe(mockData.images.length); // now all images are visible

    // Verify each image src
    images.forEach((img, index) => {
      expect(img).toHaveAttribute('src', mockData.images[index]);
    });
  });
});
