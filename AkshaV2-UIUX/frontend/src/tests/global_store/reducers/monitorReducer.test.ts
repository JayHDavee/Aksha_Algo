import monitorReducer, { fetchUser, getAllSpotLight, notifications } from '../../../../src/global_store/reducers/monitorReducer';

describe('monitorReducer', () => {
  const initialState = {
    cameraDetails: {
      info: [],
      message: '',
    },
    spotLightCameras: {
      info: [],
      message: '',
    },
    notificationsCount: 0,
  };

  it('should return the initial state', () => {
    expect(monitorReducer(undefined, { type: undefined })).toEqual(initialState);
  });

  it('should handle fetchUser', () => {
    const payload = { info: [{ id: 1 }], message: 'User cameras' };
    const action = fetchUser(payload);
    const expectedState = { ...initialState, cameraDetails: payload };
    expect(monitorReducer(initialState, action)).toEqual(expectedState);
  });

  it('should handle getAllSpotLight', () => {
    const payload = { info: [{ id: 2 }], message: 'Spotlight cameras' };
    const action = getAllSpotLight(payload);
    const expectedState = { ...initialState, spotLightCameras: payload };
    expect(monitorReducer(initialState, action)).toEqual(expectedState);
  });

  it('should handle notifications', () => {
    const action = notifications({ notificationsCount: 5 });
    const expectedState = { ...initialState, notificationsCount: 5 };
    expect(monitorReducer(initialState, action)).toEqual(expectedState);
  });
});
