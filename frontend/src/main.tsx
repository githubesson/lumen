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
import { LyricsPanelProvider } from "./context/LyricsPanel";
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
                <LyricsPanelProvider>
                  <TrackInfoProvider>
                    <ShareProvider>
                      <App />
                    </ShareProvider>
                  </TrackInfoProvider>
                </LyricsPanelProvider>
              </PlayerProvider>
            </FavoritesProvider>
          </AuthProvider>
        </BrowserRouter>
      </KeyBindingsProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
