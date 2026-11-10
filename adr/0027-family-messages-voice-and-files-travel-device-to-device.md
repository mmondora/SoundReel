# ADR-0027: Family chat, walkie-talkie and file exchange travel from device to device, end-to-end encrypted; SoundReel is only the key directory and the doorbell

## Status
**Proposed** (roadmap item of 10 November; nothing implemented; the decisions below are defaults to be confirmed, see the spec's open questions D1–D7)

## Date
2026-11-10

## Owners
Michele Mondora

## Related
- spec `2026-11-10-mondrop-family-walkie-talkie-chat-design.md` (D1–D7)
- ADR-0015 (the server keeps the inbox, push is only the doorbell), ADR-0016 (distribution through TestFlight), ADR-0018 (rule P: the clients talk only to SoundReel, about the library and its sources)
- `docs/share.md` (per-user, per-device API keys), `docs/mondrop-auth.md`, `docs/mcp.md`

---

## 1. Context
Michele (10 November): «roadmap: mondrop diventa un walkie talkie fra la famiglia, e una chat. integrata con gli strumenti di ai fa scambio files, usando protocolli fuo ed evitando server centrali sfruttando protocolli e reti diprossimira». (Typos are his; «fuo» could not be read, spec D2.)
- **What exists.** Mondrop (iOS 17, macOS 14) already has a per-user, per-device identity (`GET/POST /mondrop/connect`, bound to the Authelia `Remote-User`), an inbox whose push is only a doorbell (the APNs code is dormant until the key exists), a share pipeline that analyses what it is sent (`POST /api/share`, outcome back in the inbox) and a local AI (Whisper, TTS, Ollama, MCP; never Claude for the pipeline).
- **What iOS allows** (verified on 10 November, sources in the spec §4). A walkie-talkie that works with the phone in the pocket is the **PushToTalk framework, which delivers through APNs** (a server sends `pushtotalk` pushes to an ephemeral token); a peer-to-peer packet cannot wake a suspended app. **Multipeer Connectivity** drops its sessions in the background and Apple points to **Network.framework**. **Wi-Fi Aware** is in iOS 26 (Mondrop's minimum is 17). Two phones behind NAT, far apart, cannot find each other without a meeting point.
- **The tension to resolve.** «No central servers» and «works with the phone in the pocket and when we are apart» cannot both be fully true on an iPhone: the doorbell (APNs) and a meeting point are servers. The proposal below keeps **the content** off every server and lets SoundReel (Michele's own, at home) do only what cannot be done without one.
- Rule P («the clients talk only to SoundReel») was written about the library, the stores and the sources. Read literally it forbids two phones talking to each other.

## 2. Decision (proposed)
1. **Two planes.** The **content plane** (messages, voice, files) goes device to device, end-to-end encrypted, and is never stored or relayed in clear by any server. The **control plane** (who is who, the doorbell, optionally a meeting point) is the only thing SoundReel does.
2. **SoundReel's role is exactly three things:** a **key directory** (a device registers its public key through the existing per-user, per-device registration; the server binds it to `Remote-User` and publishes the family's keys), the **doorbell** (APNs, no content, like the inbox) and, **only if Michele accepts it for phase F4**, a **meeting point and blind relay** for phones that are apart. Never content, never history, no third-party service except Apple's APNs.
3. **Proximity first.** Transports in order: the home network (Bonjour and a direct connection authenticated with the devices' keys), Wi-Fi between nearby phones without an access point (Network.framework peer-to-peer; Wi-Fi Aware where iOS 26 is present), Bluetooth LE for discovery and very short messages, then the meeting point. **Multipeer Connectivity is not the base.**
4. **Open, documented protocol; standard primitives.** The wire format is written in `docs/`; CryptoKit primitives (Curve25519, ChaCha20-Poly1305) and a Noise-style handshake; **no home-made cipher**. Open stacks (libp2p and others) are evaluated in the spike, not assumed.
5. **Trust is in person.** Each device generates its own key pair; the server's list is a convenience, **not the root of trust**: two phones in the same room compare a QR code («safety number»).
6. **The walkie-talkie in the pocket needs PushToTalk, therefore APNs.** Until the APNs key exists the walkie-talkie works with the app open.
7. **Rule P is scoped, not repealed.** It keeps governing the library, the stores and the sources. Person-to-person traffic is another domain and lives in its own module (`MondropPeer`); `RulePTests` is adjusted so the module is not subject to the local-address ban, and a new test keeps the module and the library apart (neither imports the other).
8. **AI only when asked, and local.** A link or a file sent to SoundReel uses the existing share pipeline (no new route); «@SoundReel» is another device with its own key (a node at home with the local AI), not a door into the server; on-device transcription and translation use the system's tools; the chat is never read by the server silently; no external AI service.

## 3. Alternatives considered
| Option | Why not (as the default) |
|---|---|
| A central chat service (WhatsApp, Telegram, Signal groups) | The request is to avoid central servers |
| A self-hosted **Matrix** homeserver on geekom | Open protocol, end-to-end encryption, mature clients; but it is a central server (ours) that keeps the history, a heavy service to run and secure, and it gives no proximity. **Worth re-checking if D1 becomes «a server of ours is fine»** |
| **Multipeer Connectivity** | The easiest API for nearby phones; closes sessions in the background and has no background execution; Apple points to Network.framework |
| A Bluetooth LE mesh | Works with nothing around, but the bandwidth is too low for voice and files; kept for discovery and tiny messages |
| An **encrypted mailbox on SoundReel** (store and forward, like the inbox) | The most reliable way when phones are apart or the app is closed, but it is a server holding messages; **only if D1 says so** |
| libp2p, Nostr, Briar-like stacks | Open and built for this; Swift support and background limits unknown: **evaluate in phase F1** |

## 4. Consequences
- ✅ Nothing a third party can read: the family's conversations are on no disk but the phones'.
- ✅ Reuses what exists: the device registration (identity), APNs (the doorbell), the share pipeline (AI), the local AI.
- ✅ Works at home with no internet, phone to phone.
- ⚠️ **No server means no delivery to a phone that is closed or far away.** Only the doorbell (and, if D1 allows, the meeting point) change that; the app has to say what happened («Sara is not reachable now»).
- ⚠️ **The APNs key becomes necessary** (dormant today); PushToTalk needs its capability and a sender on the server.
- ⚠️ **Rule P changes shape** (scoped to the library): its tests change with it, and the separation between `MondropPeer` and the library becomes one more thing to keep clean.
- ⚠️ **Security-critical code** (keys, handshake, storage): standard primitives, test vectors and a review before the family trusts it; losing a phone needs a revocation story.
- ⚠️ New permissions and Info.plist text (Local Network, today described only for the server; Bonjour services; microphone), and beta-review notes that explain how to try the feature; possible App Review requirements for user-to-user messaging.

## 5. Open questions
See the spec, section 10: D1 (how strict «no server» is: may SoundReel be the key directory, the doorbell and the meeting point?), D2 (what «fuo…» was), D6 (what AI in the chat means), D3 (Apple only, or Android too), and when.
