import { AudioLines } from "lucide-react";
import { SectionHeading } from "../ui";
import FeatureCard from "./FeatureCard";
import HandoffDemo from "./HandoffDemo";
import ImportersDemo from "./ImportersDemo";
import InviteDemo from "./InviteDemo";
import MiniFeatures from "./MiniFeatures";
import PlaylistDemo from "./PlaylistDemo";
import ReplayDemo from "./ReplayDemo";
import ScrubDemo from "./ScrubDemo";
import ShareDemo from "./ShareDemo";

export default function Features() {
  return (
    <section id="features" className="relative py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading eyebrow="Features">Everything a streaming app does. Minus the subscription.</SectionHeading>

        <div className="mt-16 grid gap-4 lg:grid-cols-6">
          <FeatureCard
            className="lg:col-span-4"
            title="Scrub anywhere, instantly"
            line="Range-request streaming from your disk. Hover the waveform, click to seek."
          >
            <ScrubDemo />
          </FeatureCard>
          <FeatureCard
            className="lg:col-span-2"
            title="Pick up on any device"
            line="Live sync over WebSockets, with remote control."
            stagger={80}
          >
            <HandoffDemo />
          </FeatureCard>

          <FeatureCard className="lg:col-span-2" title="Replay, every year" line="Your listening recap, ready to share.">
            <ReplayDemo />
          </FeatureCard>
          <FeatureCard
            className="lg:col-span-2"
            title="Links that unfurl"
            line="Public shares with previews, signed so they can't be forged."
            stagger={80}
          >
            <ShareDemo />
          </FeatureCard>
          <FeatureCard
            className="lg:col-span-2"
            title="Invite-only by design"
            line="Mint invites with a role, max uses, and expiry."
            stagger={160}
          >
            <InviteDemo />
          </FeatureCard>

          <FeatureCard className="lg:col-span-3" title="Playlists, together" line="Invite collaborators to any playlist.">
            <PlaylistDemo />
          </FeatureCard>
          <FeatureCard
            className="lg:col-span-3"
            title="Importers that keep watch"
            line="Poll external sources and file new music into the right folder."
            stagger={80}
          >
            <ImportersDemo />
          </FeatureCard>
        </div>

        <MiniFeatures />

        <p className="reveal mt-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <AudioLines className="size-4 text-brand" />
          Plus CarPlay, AirPlay, lock-screen controls, and offline downloads on mobile.
        </p>
      </div>
    </section>
  );
}
