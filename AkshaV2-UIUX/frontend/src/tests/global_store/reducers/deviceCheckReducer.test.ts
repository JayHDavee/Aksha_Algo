import deviceCheckReducer, { mobileDevice } from '../../../../src/global_store/reducers/deviceCheckReducer';

describe('deviceCheckReducer', () => {
  const initialState = {
    is_mobile: false,
  };

  it('should return the initial state', () => {
    expect(deviceCheckReducer(undefined, { type: undefined })).toEqual(initialState);
  });

  it('should handle mobileDevice action', () => {
    const action = mobileDevice(true);
    const expectedState = { is_mobile: true };
    expect(deviceCheckReducer(initialState, action)).toEqual(expectedState);
  });
});
