import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/Auth";
import { ThemeProvider } from "./context/Theme";
import { PlayerProvider } from "./context/Player";
import { FavoritesProvider } from "./context/Favorites";
import { ShareProvider } from "./context/Share";
import { TrackInfoProvider } from "./context/TrackInfo";
import { KeyBindingsProvider } from "./lib/keybindings";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <KeyBindingsProvider>
        <BrowserRouter>
          <AuthProvider>
            <FavoritesProvider>
              <PlayerProvider>
                <TrackInfoProvider>
                  <ShareProvider>
                    <App />
                  </ShareProvider>
                </TrackInfoProvider>
              </PlayerProvider>
            </FavoritesProvider>
          </AuthProvider>
        </BrowserRouter>
      </KeyBindingsProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
