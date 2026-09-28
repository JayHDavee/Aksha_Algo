import React from "react";
import ReactDOM from "react-dom/client";
import "./index.scss";

import App from "./App";
import { Provider } from "react-redux";
import store from "./global_store/store";
import * as serviceWorkerRegistration from "./serviceWorkerRegistration";
import reportWebVitals from "./reportWebVitals";

// Get the root container
const container = document.getElementById("root");

if (!container) {
  throw new Error("Root container not found");
}

// Create root
const root = ReactDOM.createRoot(container);

// Render
root.render(
  <Provider store={store}>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </Provider>
);

// Optional: register service worker for PWA support
serviceWorkerRegistration.unregister(); // Or `register();` to enable

// Optional: measure performance
reportWebVitals();
