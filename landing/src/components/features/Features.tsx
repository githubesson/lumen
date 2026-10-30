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
      <div className="reveal mx-auto max-w-6xl px-5">
        <SectionHeading eyebrow="Features">Everything a streaming app does, minus the subscription</SectionHeading>

        <div className="mt-16 grid gap-4 lg:grid-cols-6">
          <FeatureCard
            className="lg:col-span-4"
            title="Scrub anywhere"
            line="Range requests straight from your disk: hover the waveform, click to seek"
          >
            <ScrubDemo />
          </FeatureCard>
          <FeatureCard
            className="lg:col-span-2"
            title="Pick up on any device"
            line="Live sync over WebSockets, with remote control"
          >
            <HandoffDemo />
          </FeatureCard>

          <FeatureCard className="lg:col-span-2" title="Replay, every year" line="Your listening recap, ready to share">
            <ReplayDemo />
          </FeatureCard>
          <FeatureCard
            className="lg:col-span-2"
            title="Links that unfurl"
            line="Public shares with previews, signed so they can't be forged"
          >
            <ShareDemo />
          </FeatureCard>
          <FeatureCard
            className="lg:col-span-2"
            title="Invite-only by design"
            line="Mint invites with a role, max uses, and expiry"
          >
            <InviteDemo />
          </FeatureCard>

          <FeatureCard className="lg:col-span-3" title="Playlists, together" line="Invite collaborators to any playlist">
            <PlaylistDemo />
          </FeatureCard>
          <FeatureCard
            className="lg:col-span-3"
            title="Importers that keep watch"
            line="Poll external sources and file new music into the right folder"
          >
            <ImportersDemo />
          </FeatureCard>
        </div>

        <MiniFeatures />

        <p className="mt-8 text-center text-sm text-muted-foreground">
          Plus CarPlay, AirPlay, lock-screen controls, and offline downloads on mobile
        </p>
      </div>
    </section>
  );
}
