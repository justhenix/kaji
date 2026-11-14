# Offline spoken feedback

ElevenLabs voice `CwhRBWXzGAHq8TQ4Fs17` is recorded once for the phrases in `manifest.json`. English and Indonesian MP3 files are embedded in the desktop binary. Playback uses the configured speaker and response volume and respects Read replies aloud.

Settings confirmations, readiness, thanks, and voice tests use these recordings. Exact basic replies from the agent also reuse them. Other replies use live speech synthesis with the selected ElevenLabs voice.

Try “Hey Kaji, move the command bar to the top island,” “use floating window,” or “move the command bar to the taskbar dock.” Voice commands also cover Agent, Assist and Guide modes, light, dark and system themes, head control, dwell, spoken feedback and response volume.

For a real headset/microphone walkthrough in the main window, run `bun app/scripts/verify-voice-commands.ts`, wait for Ready, and speak the requested commands. It checks live capture, transcription, mode/theme changes, and audio hashes against the bundled recordings. It uses the Windows default microphone and the provisioned gateway login for transcription.

To verify the recordings without provider calls:

```sh
bun app/scripts/generate-voice-assets.ts
```

To generate missing recordings, provide the provisioned runtime gateway token through `KAJI_GATEWAY_TOKEN` and run:

```sh
bun app/scripts/generate-voice-assets.ts --generate
```

Generation requires FFmpeg for validation and spends credits only for missing files. Existing recordings are never regenerated automatically during builds. Speech recognition still uses the configured transcription service.
