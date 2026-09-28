import investigationReducer, {
  fetchAllCamerasName,
  fetchAllObjectOfInterestLabels,
  fetchAreaOfInterestImage,
  getDurationTime,
  coordinatesSelected,
} from '../../../../src/global_store/reducers/investigationReducer';

describe('investigationReducer', () => {
  const initialState = {
    allCameraNames: [],
    allObjectOfInterestLabels: [],
    areaOfInterestImage: '',
    durationTime: 0,
    isCoordinatesSelected: null,
  };

  it('should return the initial state', () => {
    expect(investigationReducer(undefined, { type: undefined })).toEqual(initialState);
  });

  it('should handle fetchAllCamerasName', () => {
    const action = fetchAllCamerasName(['Camera1', 'Camera2']);
    const expectedState = { ...initialState, allCameraNames: ['Camera1', 'Camera2'] };
    expect(investigationReducer(initialState, action)).toEqual(expectedState);
  });

  it('should handle fetchAllObjectOfInterestLabels', () => {
    const action = fetchAllObjectOfInterestLabels(['Label1', 'Label2']);
    const expectedState = { ...initialState, allObjectOfInterestLabels: ['Label1', 'Label2'] };
    expect(investigationReducer(initialState, action)).toEqual(expectedState);
  });

  it('should handle fetchAreaOfInterestImage', () => {
    const image = 'base64imageString';
    const action = fetchAreaOfInterestImage(image);
    const expectedState = { ...initialState, areaOfInterestImage: image };
    expect(investigationReducer(initialState, action)).toEqual(expectedState);
  });

  it('should handle getDurationTime', () => {
    const duration = 120;
    const action = getDurationTime(duration);
    const expectedState = { ...initialState, durationTime: duration };
    expect(investigationReducer(initialState, action)).toEqual(expectedState);
  });

  it('should handle coordinatesSelected', () => {
    const action = coordinatesSelected(true);
    const expectedState = { ...initialState, isCoordinatesSelected: true };
    expect(investigationReducer(initialState, action)).toEqual(expectedState);
  });
});
