import React from 'react';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import configureStore from 'redux-mock-store';
import AreaOfInterest from "../../../../component/investigation/ObjectOfInterest/AreaOfInterest";

const mockStore = configureStore([]);

jest.mock('../../../../component/common/CanvasDraw', () => (props: any) => (
  <div data-testid="canvas-draw">CanvasDraw Component</div>
));


describe('AreaOfInterest Component', () => {
  let store: any;
  const mockSetAIPolygen = jest.fn();
  const mockOnChangeActiveCss = jest.fn();

  beforeEach(() => {
    store = mockStore({
      investigation: {
        areaOfInterestImage: 'test-image-url',
      },
    });
  });

  it('renders AreaOfInterest component', () => {
    const { getByText } = render(
      <Provider store={store}>
        <AreaOfInterest
          heading="Area of Interest"
          text="AOI"
          active={false}
          index={0}
          onChangeActiveCss={mockOnChangeActiveCss}
          setAIPolygen={mockSetAIPolygen}
          mobile={false}
        />
      </Provider>
    );

    expect(getByText('AOI')).toBeInTheDocument();
  });
});
