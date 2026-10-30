import { ArrowRight, Download } from "lucide-react";
import Showcase from "./devices/Showcase";
import { ButtonLink, delay } from "./ui";

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pb-24 pt-28 sm:pt-40">
      <div className="mx-auto flex max-w-6xl flex-col items-center px-5 text-center">
        <h1 className="enter max-w-4xl text-balance text-5xl font-medium leading-[1.04] tracking-[-0.03em] sm:text-7xl">
          Your music library, on your own server
        </h1>

        {/* Stacked on phones at one shared width; side by side from sm up. */}
        <div className="enter mt-10 flex w-full max-w-xs flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row" style={delay(80)}>
          <ButtonLink href="#self-host" size="lg">
            Set up your server <ArrowRight />
          </ButtonLink>
          <ButtonLink href="#download" size="lg" variant="outline">
            <Download /> Get the apps
          </ButtonLink>
        </div>
      </div>

      <div className="enter mx-auto mt-16 max-w-6xl px-5" style={delay(160)}>
        <Showcase />
      </div>
    </section>
  );
}
