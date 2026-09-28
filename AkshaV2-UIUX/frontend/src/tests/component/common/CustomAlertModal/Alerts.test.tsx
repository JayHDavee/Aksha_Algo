import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureMockStore from 'redux-mock-store';
import thunk from 'redux-thunk';

import Alerts from "../../../../component/common/customAlertModal/Alerts";
import axiosJWT from '../../../../context/axiosAuthIntercept';

// --- MOCK SECTION START ---

// 1. Mock envHelper
jest.mock('../../../../utils/envHelper', () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: 'http',
      VITE_BASE_URL_PORT: '3000',
      VITE_ALERT: '/api/alerts/',
      VITE_ALERT_CREATE: '/api/create-alert',
      VITE_ALERT_UPDATE: '/api/update-alert/',
      VITE_CAMERA: '/api/cameras', 
      VITE_OBJECT_OF_INTEREST_LABELS: '/api/labels',
      VITE_AREA_OF_INTERESET: '/api/camera-image/',
    };
    return envs[key] || '';
  }),
}));

// 2. Mock axiosAuthIntercept
jest.mock('../../../../context/axiosAuthIntercept');

// 3. Mock dependent components
jest.mock('../../../../component/common/customAlertModal/AlertConfigurationModal', () => (props: any) =>
  props.modalStatus ? (
    <div data-testid="alert-modal">
        Mocked AlertConfigurationModal
        {/* Render a Select/Menu item that triggers the first step of validation logic */}
        <select data-testid="alert-name-input" onChange={() => {}} value="TestName"></select>
    </div>
) : null
);

jest.mock('../../../../component/common/CustomAlertModal/AlertListComponent', () => (props: any) => (
  <div data-testid="alert-list">
    {/* The loader logic is handled by props.tableloader */}
    {props.tableloader && <div role="progressbar" data-testid="alert-list-loader">Loading...</div>}
    {props.alertlist.length > 0 ? (
      props.alertlist.map((alert: any) => (
        <div key={alert._id}>{alert.Alert_Name}</div>
      ))
    ) : (
      <div data-testid="no-alerts">No alerts configured</div>
    )}
  </div>
));

jest.mock('../../../../component/common/CustomAlertModal/ViewAlertDialog', () => (props: any) =>
    props.viewmodalstatus ? <div data-testid="view-modal">Mocked ViewAlertDialog</div> : null
);

// 4. Mock MUI components (Removed the forwardRef complexity for a simpler Select mock)
jest.mock('@mui/material', () => {
  const original = jest.requireActual('@mui/material');
  return {
    ...original,
    Select: (props: any) => (
      <select
        data-testid={`mock-select-${props.label || 'default'}`} // Use label to differentiate
        value={props.value}
        onChange={(e) => props.onChange(e as any)} // Cast e to any for simpler type handling
      >
        {props.children}
      </select>
    ),
    MenuItem: (props: any) => <option value={props.value}>{props.children}</option>,
    CircularProgress: () => <div role="progressbar" data-testid="circular-progress">Loading...</div>, 
    // Mock for the 'Add Alert' button menu component in your Select implementation
    // Assuming the "Add Alert" button is inside a Select if used with MenuItem
    Menu: original.Menu,
  };
});

// --- MOCK DATA & SETUP ---

const CAMERA_NAME = 'Camera 1';

const mockAlertResponse = {
  data: {
    success: true,
    alerts: [
      {
        _id: '1',
        Alert_Name: 'Test Alert',
        Camera_Name: [CAMERA_NAME],
        // ... (other properties)
      },
    ],
  },
};

const mockLabelsResponse = {
  data: {
    success: true,
    labels: ['person', 'car', 'truck'],
  },
};

const mockCameraResponse = {
    data: {
        success: true,
        cameras: [{_id: 'c1', Camera_Name: CAMERA_NAME, Active: true}]
    }
}

const mockImageResponse = {
    data: { success: true, image: 'base64image' }
}

const mockStore = configureMockStore([thunk]);

// Function to set up the default successful mock response for all expected concurrent calls
const setupDefaultMocks = () => {
    // Reset all mocks for a clean slate
    (axiosJWT.get as jest.Mock).mockClear();

    (axiosJWT.get as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/api/alerts/')) {
            return Promise.resolve(mockAlertResponse);
        }
        if (url.includes('/api/labels')) {
            return Promise.resolve(mockLabelsResponse);
        }
        if (url.includes('/api/cameras')) {
            return Promise.resolve(mockCameraResponse);
        }
        if (url.includes('/api/camera-image/')) {
            return Promise.resolve(mockImageResponse);
        }
        return Promise.resolve({ data: { success: true, list: [] } }); 
    });
}


// --- TEST SUITE ---

describe('Alerts Component', () => {
  let store: any;

  beforeEach(() => {
    store = mockStore({
      auth: { isAuthenticated: true, user: { id: 1, username: 'test' } },
      isMobileDevice: { is_mobile: false },
    });
    
    setupDefaultMocks(); // Set successful default mocks
  });

    // ---
    
    it('1. renders and fetches alert data', async () => {
        render(
            <Provider store={store}>
                <Alerts camera_name={CAMERA_NAME} /> 
            </Provider>
        );

        // Wait for all the necessary API calls to be made
        await waitFor(() => {
            expect(axiosJWT.get).toHaveBeenCalledWith(expect.stringContaining(`/api/alerts/${CAMERA_NAME}`));
            expect(axiosJWT.get).toHaveBeenCalledWith(expect.stringContaining('/api/labels'));
        });
        
        // Wait for the alert item to appear (Data has loaded and AlertListComponent has re-rendered)
        const alertItem = await screen.findByText(/Test Alert/i);
        expect(alertItem).toBeInTheDocument();
    });

    
     it('2. renders the "Add Alert" button', async () => {
        render(
            <Provider store={store}>
                <Alerts calledInsideMenu={true} camera_name={CAMERA_NAME} />
            </Provider>
        );
        
        // Wait for API calls to finish to ensure stability
        await waitFor(() => {
            expect(axiosJWT.get).toHaveBeenCalled(); 
        });
        
        // Find the button using its text
        const addButton = screen.getByText(/Add Alert/i);
        expect(addButton).toBeInTheDocument();
    });


    it('3. shows loading state initially', async () => {
        // Mock the critical API calls (alerts, cameras, labels) to return a pending promise
        (axiosJWT.get as jest.Mock)
            .mockImplementationOnce(() => new Promise(() => {})) // getcameralist()
            .mockImplementationOnce(() => new Promise(() => {})) // getoobjectofinterestlabels()
            .mockImplementationOnce(() => new Promise(() => {})) // getalertlist()
            .mockImplementation(() => new Promise(() => {}));     // getimagebycameraname() and others

        render(
            <Provider store={store}>
                <Alerts camera_name={CAMERA_NAME} />
            </Provider>
        );

        // Check for the loading indicator within AlertListComponent
        expect(screen.getByTestId('alert-list-loader')).toBeInTheDocument();
        
        // Assert that the alert list data is NOT present
        expect(screen.queryByText(/Test Alert/i)).not.toBeInTheDocument();
    });

    // ---
    
    it('4. handles API errors gracefully', async () => {
    // 1. Alerts fetch fails
    (axiosJWT.get as jest.Mock)
      .mockImplementationOnce(() => Promise.reject(new Error('Alerts API Error'))) // Alerts fail
      .mockImplementationOnce(() => Promise.resolve(mockLabelsResponse))          // Labels succeed
      .mockImplementation(() => Promise.resolve(mockCameraResponse));            // Other calls succeed

    render(
      <Provider store={store}>
        <Alerts />
      </Provider>
    );

    // Wait for the component to finish its error process (API calls finish/fail).
    await waitFor(() => expect(axiosJWT.get).toHaveBeenCalled());
    
    // The list component container should still be present
    expect(screen.getByTestId('alert-list')).toBeInTheDocument();
    });
    

     it('5. shows "No alerts configured" when alert list is empty', async () => {
        // Overwrite the alerts mock for this test only, while keeping others
        (axiosJWT.get as jest.Mock).mockImplementation((url: string) => {
            if (url.includes('/api/alerts/')) {
                return Promise.resolve({ data: { success: true, alerts: [] } }); // Empty list
            }
            if (url.includes('/api/labels')) {
                return Promise.resolve(mockLabelsResponse);
            }
            if (url.includes('/api/cameras')) {
                return Promise.resolve(mockCameraResponse);
            }
            if (url.includes('/api/camera-image/')) {
                return Promise.resolve(mockImageResponse);
            }
            return Promise.resolve({ data: { success: true, list: [] } }); 
        });
    
        render(
            <Provider store={store}>
                <Alerts camera_name={CAMERA_NAME} />
            </Provider>
        );
    
        // Wait for the 'No alerts configured' message to appear after API call finishes
        const noAlertsMessage = await screen.findByTestId('no-alerts');
        expect(noAlertsMessage).toBeInTheDocument();
        expect(screen.queryByText(/Test Alert/i)).not.toBeInTheDocument();
    });
});