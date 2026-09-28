import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import AlertReport from '../../../../component/insights/alertReport/AlertReport';
import axios from 'axios';
import { useSelector } from 'react-redux';
import axiosJWT from '../../../../context/axiosAuthIntercept';

// --- Mocks ---
jest.mock('react-markdown', () => (props) => <div>{props.children}</div>);
jest.mock('../../../../context/axiosAuthIntercept', () => ({
  __esModule: true,
  default: {
    put: jest.fn().mockResolvedValue({ data: { success: true } }),
    get: jest.fn().mockResolvedValue({
      data: {
        success: true,
        send_alert_report: false,
        genai_features: true,
        models: ['GPT-4o'],
      },
    }),
    post: jest.fn().mockResolvedValue({
      data: JSON.stringify({ report_analysis: 'Mock AI Summary' }),
    }),
  },
}));
jest.mock('../../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => ( {
    VITE_BASE_URL: 'http://localhost:3000',
    VITE_INSIGHT_REPORT: '/api/insight-report',
    VITE_CAMERAS_LIST: '/api/cameras',
    VITE_OBJECT_OF_INTEREST_LABELS: '/api/labels',
    VITE_GET_EMAIL_DETAILS: '/api/email-details',
  }[key])),
}));
jest.mock('axios');
jest.mock('react-redux', () => ({ useSelector: jest.fn() }));

// --- Component Mocks ---
jest.mock('../../../../component/insights/alertReport/components/CustomTable', () => ({
  __esModule: true,
  default: ({ showModal }: any) => (
    <div data-testid="custom-table" onClick={() => showModal('https://test.com/img.jpg')}>
      Table
    </div>
  ),
}));
jest.mock('../../../../component/insights/alertReport/components/DoughnutChart', () => ({
  __esModule: true,
  default: () => <div data-testid="doughnut-chart" />,
}));
jest.mock('../../../../component/insights/alertReport/components/HorizontalBarChart', () => ({
  __esModule: true,
  default: () => <div data-testid="horizontal-bar-chart" />,
}));
jest.mock('../../../../component/common/Messagebox', () => ({
  __esModule: true,
  default: ({ open, message }: any) => (open ? <div data-testid="message-box">{message}</div> : null),
}));
jest.mock('../../../../component/common/NotFound', () => () => <div data-testid="not-found" />);
jest.mock('../../../../component/common/DatePickerPopover', () => ({ heading, text }: any) => (
  <div data-testid={`date-picker-${heading}`}>{text}</div>
));
jest.mock('../../../../component/common/TimePickerPopover', () => ({ heading, text }: any) => (
  <div data-testid={`time-picker-${heading}`}>{text}</div>
));
jest.mock('../../../../component/insights/alertReport/components/Dropdown', () => ({ heading, options }: any) => (
  <div data-testid={`dropdown-${heading}`}>{options.join(',')}</div>
));

// --- Tests ---
describe('AlertReport Component', () => {
  beforeEach(() => {
    // Provide complete reportData so table and messagebox render
    (useSelector as jest.Mock).mockImplementation((fn) =>
      fn({
        alertReport: {
          reportData: {
            rows: [{ id: 1, camera: 'cam1', object: 'Truck' }],
            cameras: [{ Camera_Name: 'cam1', Active: true }],
            labels: ['Truck'],
          },
          alertDate: new Date(),
        },
      })
    );

    (axios.get as jest.Mock).mockResolvedValue({
      data: { cameras: [{ Camera_Name: 'cam1', Active: true }], labels: ['Truck'] },
    });
    (axios.post as jest.Mock).mockResolvedValue({ data: '{}' });
  });

  test('renders filters and search icon', async () => {
    render(<AlertReport />);
    expect(await screen.findByTestId('dropdown-Camera')).toBeInTheDocument();
    expect(await screen.findByTestId('dropdown-Object of Interest')).toBeInTheDocument();
    expect(screen.getByTestId('search-icon')).toBeInTheDocument();
  });

  test('shows NotFound if reportData is empty', async () => {
    (useSelector as jest.Mock).mockImplementation((fn) =>
      fn({ alertReport: { reportData: {}, alertDate: new Date() } })
    );
    render(<AlertReport />);
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
  });

  test('checkbox toggling displays messagebox', async () => {
    render(<AlertReport />);
    const checkboxDiv = screen.getByText('Send alert report bimonthly').parentElement!;
    fireEvent.click(checkboxDiv);
    const msgBox = await screen.findByTestId('message-box');
    expect(msgBox).toHaveTextContent('You will keep receiving bimonthly alert report');
  });

//   test('modal opens and closes', async () => {
//     render(<AlertReport />);

//     // wait for table to render
//     const table = await screen.findByTestId('custom-table');
//     fireEvent.click(table);

//     // wait for modal image to appear
//     const modalImg = await screen.findByAltText('alert img');
//     expect(modalImg).toHaveAttribute('src', 'https://test.com/img.jpg');

//     const closeBtn = screen.getByTestId('close-modal-icon');
//     fireEvent.click(closeBtn);

//     await waitFor(() =>
//       expect(screen.queryByAltText('alert img')).not.toBeInTheDocument()
//     );
//   });

//   test('AI Report Summary section renders and button works', async () => {
//     render(<AlertReport />);

//     // wait for AI section to render (mock models exist)
//     await waitFor(() => screen.getByText(/Select Model/i));

//     const generateBtn = screen.getByRole('button', { name: /Generate Report Summary/i });
//     expect(generateBtn).toBeInTheDocument();
//     fireEvent.click(generateBtn);
//     expect(generateBtn).toBeDisabled();
//   });

//   test('search validation displays error message if invalid', async () => {
//     // empty date triggers validation
//     (useSelector as jest.Mock).mockImplementation((fn) =>
//       fn({ alertReport: { reportData: { rows: [] }, alertDate: null } })
//     );

//     render(<AlertReport />);
//     fireEvent.click(screen.getByTestId('search-icon'));

//     const msgBox = await screen.findByTestId('message-box');
//     expect(msgBox).toHaveTextContent(/please select date/i);
//   });
});
