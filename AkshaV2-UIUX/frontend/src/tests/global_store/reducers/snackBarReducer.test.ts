import snackBarReducer, { showToast } from '../../../../src/global_store/reducers/snackBarReducer';

describe('snackBarReducer', () => {
  const initialState = {
    toast: {
      show: false,
      indicator: '',
      message: '',
    },
  };

  it('should return the initial state', () => {
    expect(snackBarReducer(undefined, { type: undefined })).toEqual(initialState);
  });

  it('should handle showToast', () => {
    const toastPayload = { show: true, indicator: 'success', message: 'Test message' };
    const action = showToast(toastPayload);
    const expectedState = { toast: toastPayload };
    expect(snackBarReducer(initialState, action)).toEqual(expectedState);
  });
});
