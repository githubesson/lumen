import { useSearchParams } from "react-router-dom";
import SegmentedControl from "../components/SegmentedControl";
import { LibraryAdminSection } from "./AdminLibrary";
import { InvitesAdminSection } from "./AdminInvites";

const SECTIONS = [
  { id: "library", label: "Library", Component: LibraryAdminSection },
  { id: "invites", label: "Invites", Component: InvitesAdminSection },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

function isSection(v: string | null): v is Section {
  return SECTIONS.some((s) => s.id === v);
}

/**
 * Unified admin page — a single sidebar tab that owns both the library/root
 * management UI and invite management UI. The active section lives in the
 * URL (`?section=library|invites`) so links and back/forward work.
 */
export default function Admin() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("section");
  const section: Section = isSection(raw) ? raw : "library";

  const setSection = (s: Section) => {
    const next = new URLSearchParams(params);
    if (s === "library") next.delete("section");
    else next.set("section", s);
    setParams(next, { replace: true });
  };

  const ActiveComponent =
    SECTIONS.find((s) => s.id === section)?.Component ?? LibraryAdminSection;

  return (
    <div className="view" style={{ display: "grid", gap: 18 }}>
      <header>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            margin: 0,
          }}
        >
          Admin
        </h1>
      </header>

      <SegmentedControl
        aria-label="Admin section"
        style={{ justifySelf: "start" }}
        value={section}
        onChange={setSection}
        options={SECTIONS.map((s) => ({ value: s.id, label: s.label }))}
      />

      <ActiveComponent />
    </div>
  );
}
