# Frontend agent instructions

These instructions apply to all work under `frontend/`.

## macOS release signing and notarization

Do not describe a macOS artifact as distribution-ready until both the app and
the final DMG pass Gatekeeper assessment as `Notarized Developer ID`.

The macOS release has two nested artifacts. Replace `<arch>` and `<version>`
with the values produced by the current build:

1. `release/mac-<arch>/Lumen.app`
2. `release/Lumen-<version>-<arch>.dmg`, which contains the app

Signing or otherwise modifying either artifact after notarization changes its
bytes and invalidates the corresponding ticket. Always sign first, submit that
exact artifact, and staple only after Apple accepts it.

### Required identity

For a DMG distributed outside the Mac App Store, use a **Developer ID
Application** certificate. Do not substitute either of these:

- `Apple Development`: suitable for local development, not public distribution.
- `Apple Distribution`: intended for App Store submission, not a direct-download
  DMG.

The certificate must appear in Keychain Access under **My Certificates** and
must expand to show its matching private key.

List usable code-signing identities with:

```sh
security find-identity -v -p codesigning
```

Prefer the SHA-1 hash shown by that command over the display name. Names can be
ambiguous when the same-named certificate exists in multiple keychains.

The hash is not a secret, but it is developer- and certificate-specific. Never
hard-code a contributor's identity, Team ID, email address, or certificate hash
in tracked project files.

### One-time notarization credential setup

Generate an app-specific password at `https://account.apple.com/` under
**Sign-In and Security > App-Specific Passwords**. Never put the password in
the repository, a command argument, an `.env` file, or an agent response.

Store it in the login Keychain using an interactive secure prompt:

```sh
xcrun notarytool store-credentials "<KEYCHAIN_PROFILE>" \
  --apple-id "<APPLE_ACCOUNT_EMAIL>" \
  --team-id "<APPLE_TEAM_ID>"
```

Omitting `--password` is intentional: `notarytool` prompts without placing the
password in shell history. It validates the credentials before saving them.

Confirm the profile is usable:

```sh
xcrun notarytool history \
  --keychain-profile "<KEYCHAIN_PROFILE>" \
  --output-format json
```

### Local uncommitted defaults

Signing configuration belongs in the local shell profile, not Git. Add values
for the locally installed identity and Keychain profile to `~/.zprofile`:

```sh
export CSC_NAME="<DEVELOPER_ID_CERTIFICATE_SHA1>"
export APPLE_KEYCHAIN_PROFILE="<KEYCHAIN_PROFILE>"
```

After changing `~/.zprofile`, start a new login shell or run:

```sh
source ~/.zprofile
```

Verify both values before building:

```sh
printenv CSC_NAME APPLE_KEYCHAIN_PROFILE
```

If an automation runner has an older environment snapshot, pass the variables
explicitly for that invocation:

```sh
CSC_NAME="<DEVELOPER_ID_CERTIFICATE_SHA1>" \
APPLE_KEYCHAIN_PROFILE="<KEYCHAIN_PROFILE>" \
npm run electron:build:mac
```

Do not commit Apple IDs, app-specific passwords, API private keys, or Keychain
exports.

### Build the signed and notarized app

From `frontend/`:

```sh
npm run electron:build:mac             # DMG for this Mac's architecture
npm run electron:build:mac:universal   # universal DMG (the release artifact)
```

The script performs the web build, compiles the Electron sources, and invokes
electron-builder (config: `electron-builder.cjs`). With `CSC_NAME` and
`APPLE_KEYCHAIN_PROFILE` available, the build will:

1. Package the app.
2. Sign the app and all nested helpers/frameworks with Developer ID.
3. Submit the app to Apple's notary service and wait for acceptance.
4. Staple the app ticket.
5. Create the DMG.
6. Sign, notarize, and staple the DMG container itself (the
   `afterAllArtifactBuild` hook in `electron-builder.cjs`); the build fails
   if the DMG submission is not `Accepted`.

The expected log includes:

```text
identityName=Developer ID Application: <DEVELOPER_NAME> (<APPLE_TEAM_ID>)
notarization successful
```

If the log says `skipped macOS notarization`, do not treat the build as
notarized. Confirm `APPLE_KEYCHAIN_PROFILE` is present and the Keychain profile
validates.

### Sign and notarize the final DMG (manual fallback)

The `afterAllArtifactBuild` hook in `electron-builder.cjs` performs this
automatically whenever `CSC_NAME` and `APPLE_KEYCHAIN_PROFILE` are set, so
normally there is nothing to do here — skip to the final verification below.
The manual steps remain for recovering a build whose DMG step failed partway
(for example a notarization submission that timed out).

Set `APP` and `DMG` to the artifacts produced by the build:

```sh
APP="release/mac-<arch>/Lumen.app"
DMG="release/Lumen-<version>-<arch>.dmg"
```

Then run, in this exact order:

```sh
codesign --force \
  --timestamp \
  --sign "$CSC_NAME" \
  "$DMG"

codesign --verify --verbose=2 "$DMG"

xcrun notarytool submit "$DMG" \
  --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
  --wait \
  --output-format json

xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
```

The `notarytool submit` result must report `"status":"Accepted"`. Do not
staple or distribute a submission that is still `In Progress`, `Invalid`, or
has otherwise failed.

Never sign the DMG after submitting or stapling it. If that happens, submit the
newly signed DMG again and staple its new ticket.

### Required final verification

Verify the nested app:

```sh
codesign --verify --deep --strict --verbose=2 \
  "$APP"

xcrun stapler validate "$APP"

spctl --assess --type execute --verbose=4 \
  "$APP"
```

Verify the final DMG:

```sh
codesign --verify --verbose=2 "$DMG"
xcrun stapler validate "$DMG"

spctl --assess \
  --type open \
  --context context:primary-signature \
  --verbose=4 \
  "$DMG"
```

Both Gatekeeper assessments must end with:

```text
accepted
source=Notarized Developer ID
```

Also inspect the identity and timestamp when diagnosing a build:

```sh
codesign -dv --verbose=4 "$APP" 2>&1 | \
  rg 'Identifier=|Authority=|TeamIdentifier=|Timestamp='

codesign -dv --verbose=4 "$DMG" 2>&1 | \
  rg 'Identifier=|Authority=|TeamIdentifier=|Timestamp='
```

### Notarization diagnostics

Show recent submissions:

```sh
xcrun notarytool history \
  --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
  --output-format json
```

Fetch Apple's diagnostic log for a failed submission:

```sh
xcrun notarytool log "SUBMISSION_ID" \
  --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
  notarization-log.json
```

Do not commit `notarization-log.json`; it is a local diagnostic artifact.

### Known failures

#### `ambiguous` certificate name

The same certificate display name exists in multiple keychains. Set `CSC_NAME`
to the unique SHA-1 hash from `security find-identity`, not the display name.

#### `Please remove prefix "Developer ID Application:"`

electron-builder rejects a fully prefixed `CSC_NAME`. Use the SHA-1 hash.

#### `errSecInternalComponent`

The certificate's private key is inaccessible or Keychain is waiting for
approval. Confirm the certificate has a private key under **My Certificates**.
Approve the `codesign` Keychain prompt with **Always Allow** where appropriate.

#### `Unnotarized Developer ID`

The artifact is signed but lacks a valid notarization ticket. Check whether the
submission was accepted and whether stapling succeeded.

#### `source=no usable signature` for the DMG

The DMG was notarized or stapled without first being signed. Sign the DMG,
submit that exact signed file again, staple it, and reassess it.

#### `notarize options were unable to be generated`

electron-builder did not receive notarization credentials. Confirm
`APPLE_KEYCHAIN_PROFILE` is exported in the build process and names a valid
local Keychain profile.

#### Missing optional FH6 resource or package metadata warnings

Warnings about `_local/fh6-spotify-mod/lumen-radio/dist`, a missing package
description/author, or the existing Vite chunk-size warning are not signing or
notarization failures. Report them separately; do not confuse them with an
Apple signing failure.

## Release handoff

When handing off a macOS release, report:

- The exact DMG path and size.
- The Developer ID identity and Team ID used.
- The app notarization submission ID.
- The final DMG notarization submission ID.
- Successful `codesign`, `stapler validate`, and `spctl` results for both the
  app and DMG.

Do not claim the release is ready based only on a successful electron-builder
exit code. The final Gatekeeper checks are authoritative.
