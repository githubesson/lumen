import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { playlistPermissions } from "@music-library/core/playlist-permissions";
import type { Collaborator, EffectiveRole, Visibility } from "../src/api";
import CollaboratorsPanel from "../src/pages/playlist/CollaboratorsPanel";

const mock = vi.hoisted(() => ({
  inviteCollaborator: vi.fn(),
  removeCollaborator: vi.fn(),
  setCollaboratorRole: vi.fn(),
}));
vi.mock("../../core/src/api", async (original) => ({
  ...(await original<typeof import("../../core/src/api")>()),
  api: mock,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const collaborators: Collaborator[] = [
  { user_id: "u2", username: "bea", role: "editor", status: "accepted", invited_at: "2026-01-01T00:00:00Z" },
  { user_id: "u3", username: "cy", role: "viewer", status: "pending", invited_at: "2026-01-02T00:00:00Z" },
];

function renderPanel(
  role: EffectiveRole,
  visibility: Visibility,
  me: { id: string },
) {
  const onChanged = vi.fn(() => Promise.resolve());
  const onLeft = vi.fn();
  render(
    <CollaboratorsPanel
      playlistId="p1"
      collaborators={collaborators}
      permissions={playlistPermissions({ effective_role: role, visibility }, me)}
      me={me}
      onChanged={onChanged}
      onLeft={onLeft}
    />,
  );
  return { onChanged, onLeft };
}

it("lets a collaborator leave but not remove others, change roles or invite", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  mock.removeCollaborator.mockResolvedValue(undefined);
  const { onLeft, onChanged } = renderPanel("editor", "collaborative", { id: "u2" });

  expect(screen.queryByLabelText("Invite by username")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Leave" }));
  await act(async () => {});
  expect(mock.removeCollaborator).toHaveBeenCalledWith("p1", "u2");
  expect(onLeft).toHaveBeenCalledTimes(1);
  expect(onChanged).not.toHaveBeenCalled();
});

it("lets the owner of a private playlist manage leftover collaborators without inviting", () => {
  renderPanel("owner", "private", { id: "u1" });
  expect(screen.queryByLabelText("Invite by username")).toBeNull();
  // Roles change only on accepted collaborators; anyone can be removed.
  expect(screen.getAllByRole("combobox")).toHaveLength(1);
  expect(screen.getByLabelText("Role for bea")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
});

it("offers invites to the owner of a collaborative playlist", () => {
  renderPanel("owner", "collaborative", { id: "u1" });
  expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
});
