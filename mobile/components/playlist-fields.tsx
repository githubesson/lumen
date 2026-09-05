import type { Visibility } from "@music-library/core";
import { FormField, FormTextInput } from "./form-field";
import { SegmentedControl } from "./segmented-control";

interface Props {
  name: string;
  description: string;
  visibility: Visibility;
  setName: (value: string) => void;
  setDescription: (value: string) => void;
  setVisibility: (value: Visibility) => void;
}

export function PlaylistFields({
  name,
  description,
  visibility,
  setName,
  setDescription,
  setVisibility,
}: Props) {
  return (
    <>
      <FormField label="Name">
        <FormTextInput
          placeholder="Playlist name"
          value={name}
          onChangeText={setName}
          returnKeyType="next"
        />
      </FormField>

      <FormField label="Description" optional>
        <FormTextInput
          placeholder="Add a description"
          value={description}
          onChangeText={setDescription}
          style={{ minHeight: 96, textAlignVertical: "top" }}
          multiline
        />
      </FormField>

      <FormField
        label="Visibility"
        hint={
          visibility === "private"
            ? "Only you can see this playlist."
            : "Invite others to add and reorder tracks."
        }
      >
        <SegmentedControl<Visibility>
          options={[
            { label: "Private", value: "private" },
            { label: "Collaborative", value: "collaborative" },
          ]}
          value={visibility}
          onChange={setVisibility}
        />
      </FormField>
    </>
  );
}
