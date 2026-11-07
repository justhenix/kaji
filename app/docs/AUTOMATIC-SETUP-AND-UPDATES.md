# Automatic setup and Windows updates

From v0.1.2, a new Windows account generates and enrolls its own device login. There is no owner-login copy, terminal setup, or provider key entry. Windows DPAPI protects the login at `%LOCALAPPDATA%/Kaji/gateway-token.dpapi`. The native capability client and managed agent use the same connection code. Registration failures stay retryable; server-side device and aggregate quotas remain enforced. See `gateway/README.md` for admission and usage limits.

Settings → General checks for signed releases and offers **Install and restart**. The existing **Check for updates** preference controls the automatic launch check. Checks do not install or interrupt a running task. Installation requires an idle task, verifies the package signature and signed version, and runs the per-user NSIS updater silently. Downloads can be retried. SQLite, settings, and the device credential are outside the replaced application payload.

The public feed is `https://kaji.henix.my.id/updates/latest.json`. It uses Tauri's static update format with a `windows-x86_64` platform entry. Installer URLs are immutable versioned HTTPS downloads. TLS validation, signature validation and signed-version matching remain enabled. The updater uses Windows TLS and no archive-extraction dependency because this product distributes NSIS executables.

## Publishing a release

Keep the updater private key outside the repository. This machine stores it at `%LOCALAPPDATA%/KajiRelease/updater.key`; the public verification key is committed in `tauri.conf.json`. Back up the private key securely before moving the release process to another machine. Losing it prevents compatible future updates.

1. Bump the Cargo, Tauri and app versions and update the displayed version.
2. Set `TAURI_SIGNING_PRIVATE_KEY` to the private-key path and run `bun run --cwd app package:windows`. Tauri creates the NSIS `.exe` and `.exe.sig` together and binds the signature to the app version. Never generate a new key for each release.
3. Run the existing checks, silently upgrade a test installation, and verify automatic enrollment from an empty credential path plus a real composer reply.
4. Upload the installer under `windows/vVERSION/Kaji-VERSION-x64-setup.exe` without a random suffix. Run `bun app/scripts/update-feed.ts INSTALLER SIGNATURE HTTPS_URL` to verify version metadata and write the public feed. Publish the site only after the installer upload is available, then verify the anonymous download hash and native update check.

Versions before v0.1.2 have no updater; their users need this installer once. Later versions can update through Kaji.
