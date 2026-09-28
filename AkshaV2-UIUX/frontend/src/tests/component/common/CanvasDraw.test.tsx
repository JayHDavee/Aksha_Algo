import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import CanvasDraw from '../../../component/common/CanvasDraw';
import { coordinatesSelected } from '../../../global_store/reducers/investigationReducer';

// -------------------------------
// Mock redux
// -------------------------------
jest.mock('react-redux', () => {
  const dispatchMock = jest.fn();
  return {
    useDispatch: () => dispatchMock,
    useSelector: jest.fn(),
    __esModule: true,
    getDispatchMock: () => dispatchMock, // expose for tests
  };
});

// -------------------------------
// Mock global reducer action
// -------------------------------
jest.mock('../../../global_store/reducers/investigationReducer', () => ({
  coordinatesSelected: jest.fn(() => ({ type: 'COORDINATE_SELECTED' })),
}));

// -------------------------------
// Mock use-image hook
// -------------------------------
jest.mock('use-image', () => () => [null, 'loaded']);

// -------------------------------
// Mock react-konva
// -------------------------------
jest.mock('react-konva', () => ({
  Stage: ({ children, onMouseDown }: any) => (
    <div
      data-testid="stage"
      onMouseDown={(e) =>
        onMouseDown &&
        onMouseDown({
          evt: {
            clientX: e.clientX,
            clientY: e.clientY,
            offsetX: e.clientX,
            offsetY: e.clientY,
            layerX: e.clientX,
            layerY: e.clientY,
          },
          target: {
            getStage: () => ({
              getPointerPosition: () => ({
                x: e.clientX,
                y: e.clientY,
              }),
            }),
          },
        })
      }
    >
      {children}
    </div>
  ),
  Layer: ({ children }) => <div data-testid="layer">{children}</div>,
  Line: ({ points }: any) => <div data-testid="line">{points?.join(',')}</div>,
  Rect: ({ x, y, width, height }: any) => (
    <div data-testid="rect">{`${x},${y},${width},${height}`}</div>
  ),
}));




describe('CanvasDraw', () => {
  let dispatchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const redux = require('react-redux');
    dispatchMock = redux.getDispatchMock();
  });

  const mockProps = {
    imageUrl: 'http://example.com/image.jpg',
    setAIPolygen: jest.fn(),
    width: 300,
    height: 200,
  };

  it('renders canvas correctly', () => {
    const { getByTestId } = render(<CanvasDraw {...mockProps} />);
    expect(getByTestId('stage')).toBeInTheDocument();
  });
  it('dispatches coordinatesSelected on click', () => {
    const { getByTestId } = render(<CanvasDraw {...mockProps} />);
    const stage = getByTestId('stage');

    fireEvent.mouseDown(stage, { clientX: 20, clientY: 20 });

    expect(coordinatesSelected).toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith({ type: 'COORDINATE_SELECTED' });
  });


});
