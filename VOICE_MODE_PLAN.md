# Voice Mode + Live Transcription Plan

## What is implemented now

- `examples/demo-route.html` includes voice controls with live transcription display.
- `examples/js/VoiceOrchestrator.js` parses spoken commands into route/player intents:
  - play/continue
  - pause/stop
  - next/previous
  - reroute via phrases like `go to <location>`

This provides immediate speech control for demo playback and alternate-location rerouting.

## OpenAI Voice Mode integration path

For production-grade voice mode, use OpenAI Realtime voice pipeline for:

1. low-latency speech-to-intent,
2. robust transcription and correction,
3. conversational clarifications when route intent is ambiguous.

Recommended split:
- **Client:** captures mic audio + displays live transcript.
- **Voice agent service:** streams to OpenAI Realtime and receives transcripts/intents.
- **Journey orchestrator:** executes deterministic commands and route updates.

## Command contract

Normalize voice output into:

```json
{
  "type": "play|pause|next|prev|reroute|camera_style|freeform",
  "text": "raw utterance",
  "params": {}
}
```

Example:
- “go to Smithfield and continue” -> `{"type":"reroute","params":{"destination":"Smithfield, Dublin"}}`
- “slow down and look left at the river” -> `{"type":"camera_style","params":{"speed":"slow","yaw":"left","focus":"river"}}`

## Safety/UX guardrails

- Require explicit confirmation for large reroutes (“Should I reroute to Smithfield now?”).
- Keep push-to-talk and mute controls visible.
- Always allow immediate manual override on playback controls.
- Log transcript + command events to session files for replay/debugging.
