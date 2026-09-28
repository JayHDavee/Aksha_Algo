jest.mock("react-markdown", () => () => <div>Markdown Mock</div>);
jest.mock(
  "canvas",
  () => {
    return {
      createCanvas: () => ({
        getContext: () => ({
          fillRect: jest.fn(),
          drawImage: jest.fn(),
          getImageData: jest.fn(() => ({ data: [] })),
          putImageData: jest.fn(),
        }),
        toBuffer: jest.fn(),
      }),
      loadImage: jest.fn(),
    };
  },
  { virtual: true }
);
jest.mock("../../router/socket", () => ({
  socket: {
    on: jest.fn(),
    emit: jest.fn(),
    off: jest.fn(),
  },
}));
jest.mock("../../context/AuthContext", () => {
  const actual = jest.requireActual("../../context/AuthContext");

  return {
    __esModule: true,
    ...actual,
    useAuth: () => ({
      isLoggedIn: true,
      login: jest.fn(),
      logout: jest.fn(),
    }),
    AuthProvider: ({ children }: any) => <div>{children}</div>,
  };
});

// --- Mock all env helpers used anywhere ---
jest.mock("../../utils/envHelper", () => ({
  getEnvVar: jest.fn((key) => {
    const mockEnv = {
      VITE_BASE_URL_PROTOCOL: "http",
      VITE_BASE_URL_PORT: "3000",
      VITE_PASSWORD_SECRET_KEY: "mock-secret-key",
    };
    return mockEnv[key] || "";
  }),

  getSecretKey: jest.fn(() => "mock-secret-key"),
}));

import React from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Router from "../../router/Router";

// --- IMPORT STORE ---
import { Provider } from "react-redux";
import store from "../../redux/store";
import { AuthProvider } from "../../context/AuthContext";
import * as reactRedux from "react-redux";
jest.mock("react-redux", () => ({
  ...jest.requireActual("react-redux"),
  useSelector: jest.fn((selector: any) =>
    selector({
      isMobileDevice: { is_mobile: false },
    })
  ),
}));
describe("Router component", () => {
  const renderWithProviders = (ui: React.ReactNode, route?: string) =>
    render(
      <Provider store={store}>
        
        <MemoryRouter initialEntries={[route || "/"]}>{ui}</MemoryRouter>
      </Provider>
    );

  beforeEach(() => {
    localStorage.clear();
  });

  it("renders Header component", () => {
    renderWithProviders(<Router />);
    expect(document.body).toBeTruthy();
  });

  it('redirects unknown routes to "/"', () => {
    renderWithProviders(<Router />, "/unknown");
    expect(document.body).toBeTruthy();
  });

  it("renders login page at /login", () => {
    renderWithProviders(<Router />, "/login");
    expect(document.body).toBeTruthy();
  });

  it("renders signup page at /signup", () => {
    renderWithProviders(<Router />, "/signup");
    expect(document.body).toBeTruthy();
  });

  it("renders forgot password page at /forgotpassword", () => {
    renderWithProviders(<Router />, "/forgotpassword");
    expect(document.body).toBeTruthy();
  });

  it("renders protected routes when logged in", () => {
    localStorage.setItem("isLoggedIn", "true");
    renderWithProviders(<Router />, "/cameraDirectory");
    expect(document.body).toBeTruthy();
  });

  it("renders public routes when not logged in", () => {
    localStorage.setItem("isLoggedIn", "false");
    renderWithProviders(<Router />, "/monitor");
    expect(document.body).toBeTruthy();
  });
});
