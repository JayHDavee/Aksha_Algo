import authReducer, { loginSuccess, logout } from '../../../../src/global_store/reducers/authReducer';

describe('authReducer', () => {
  interface AuthState {
    token: string | null;
    email: string | null;
    role: string | null;
  }

  const initialState = {
    token: null,
    email: null,
    role: null,
  };

  it('should return the initial state', () => {
    expect(authReducer(undefined, { type: undefined })).toEqual(initialState);
  });

  it('should handle loginSuccess', () => {
    const action = loginSuccess({ token: 'abc123', email: 'test@example.com', role: 'admin' } as any);
    const expectedState = {
      token: 'abc123',
      email: 'test@example.com',
      role: 'admin',
    };
    expect(authReducer(initialState, action)).toEqual(expectedState);
  });

  it('should handle logout', () => {
    const loggedInState = {
      token: 'abc123',
      email: 'test@example.com',
      role: 'admin',
    };
    const action = logout();
    const expectedState = {
      token: null as string | null,
      email: null as string | null,
      role: null as string | null,
    };
    expect(authReducer(loggedInState, action)).toEqual(expectedState);
  });
});
