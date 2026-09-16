import type { JSX } from "solid-js";
import { Clients } from "./components/Clients";
import { Downloads } from "./components/Downloads";
import { Features } from "./components/Features";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { Nav } from "./components/Nav";
import { Platforms } from "./components/Platforms";
import { SelfHost } from "./components/SelfHost";

export function App(): JSX.Element {
  return (
    <>
      {/* Fixed rather than absolute so it appears wherever the reader tabs from. */}
      <a
        href="#features"
        class="btn fixed top-0 left-4 z-[60] -translate-y-24 focus-visible:translate-y-4"
      >
        Skip to content
      </a>
      {/* Sits behind the nav and hero so the colour runs under the header

         instead of stopping at its edge. Three blobs drift independently. */}

      <div class="glow" aria-hidden="true">
        <div class="glow-blob glow-blob-a" />

        <div class="glow-blob glow-blob-b" />

        <div class="glow-blob glow-blob-c" />
      </div>

      <Nav />
      <main>
        <Hero />
        <Platforms />
        <Features />
        <Clients />
        <SelfHost />
        <Downloads />
      </main>
      <Footer />
    </>
  );
}
