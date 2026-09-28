import React from "react";
import { render } from "@testing-library/react";
import { Provider } from "react-redux";
import configureStore from "redux-mock-store";
import thunk from "redux-thunk";
import App from "../App";
import '@testing-library/jest-dom'; // Make sure this is included

const middlewares = [thunk];
const mockStore = configureStore(middlewares);
jest.mock("react-markdown", () => (props) => {
  return <div>{props.children}</div>;
});

jest.mock("../utils/envHelper", () => ({
  getEnvVar: jest.fn((key: string) => {
    const envs: Record<string, string> = {
      VITE_BASE_URL_PROTOCOL: "http",
      VITE_BASE_URL_PORT: "3000",
      VITE_SOME_API_PATH: "/api/sample",
    };
    return envs[key] || "";
  }),
}));
jest.mock('react-konva', () => ({
  Stage: () => <div>Mocked Stage</div>,
  Layer: () => <div>Mocked Layer</div>,
  Line: () => <div>Mocked Line</div>,
  Rect: () => <div>Mocked Rect</div>,
}));

describe("App Component", () => {
  it("renders toast message from Redux", async () => {
    const initialState = {
      snackBar: {
        toast: {
          show: true,
          indicator: "success",
          message: "Hello World",
        },
      },
    };

    const store = mockStore(initialState);

    const { findByText } = render(
      <Provider store={store}>
        <App />
      </Provider>
    );

    // Wait for the toast to appear
    expect(await findByText("Hello World")).toBeInTheDocument();
  });
});
