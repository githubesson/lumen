import Download from "./components/Download";
import Faq from "./components/Faq";
import Features from "./components/features/Features";
import Footer, { FinalCta } from "./components/Footer";
import Hero from "./components/Hero";
import Nav from "./components/Nav";
import Platforms from "./components/Platforms";
import SelfHost from "./components/SelfHost";
import { useRepoInfo } from "./lib/github";
import { useRevealOnScroll, useTheme } from "./lib/hooks";

export default function App() {
  const repo = useRepoInfo();
  const { theme, toggle } = useTheme();
  useRevealOnScroll();

  return (
    <>
      <Nav repo={repo} theme={theme} onToggleTheme={toggle} />
      <main>
        <Hero repo={repo} />
        <Platforms />
        <Features />
        <SelfHost />
        <Download repo={repo} />
        <Faq />
        <FinalCta repo={repo} />
      </main>
      <Footer />
      {/* Polite status messages from `announce()`, e.g. copy confirmations. */}
      <div id="live-region" role="status" aria-live="polite" className="sr-only" />
    </>
  );
}
