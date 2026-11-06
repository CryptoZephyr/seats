import "@fontsource/besley/400.css";
import "@fontsource/besley/600.css";
import "@fontsource/besley/700.css";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/500.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "@fontsource/atkinson-hyperlegible-mono/500.css";
import "@near-wallet-selector/modal-ui/styles.css";
import "./tokens.css";
import "./app.css";
import { Buffer } from "buffer";
import { createRoot } from "react-dom/client";
import { App } from "./App";

declare global {
  var Buffer: typeof import("buffer").Buffer;
}

globalThis.Buffer ??= Buffer;

createRoot(document.getElementById("root")!).render(<App />);
