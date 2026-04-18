import React from "react";
import ReactDOM from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import App from "../app/hawks.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <>
    <App />
    <Analytics />
  </>
);
