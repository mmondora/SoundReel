# ADR-0016: Mondrop reaches the family through TestFlight, uploaded and managed with an App Store Connect API key

## Status
**Accepted** (2026-11-08). The build pipeline is in the repository. **Lesson of 8 November:** the Apple ID login of Xcode on the build Mac expired within hours ("Failed to Use Accounts") and a Developer-level API key cannot sign in the cloud or manage groups; the route that works and does not expire is a **team API key with the Admin role** (`KXRWH399D2`), which uploaded build 9 with no Xcode account involved (spec §7).

## Date
2026-11-08

## Owners
Michele Mondora

## Related
- spec `2026-11-08-mondrop-testflight-design.md` (T1–T7)
- ADR-0015 (the inbox and the push use the same paid Apple Developer account), `ios/README.md`, `ios/scripts/testflight.sh`

---

## 1. Context
Mondrop has so far been installed on Michele's iPhone from Xcode (`install-iphone.sh`, a development build). His request of 8 November: "publish Mondrop on TestFlight and put the family group as testers". Archi and Sara cannot install a development build; TestFlight is the way to give them the app without the App Store.
- The Mac that builds (vulcano, Xcode 27.2) has only an **Apple Development** identity and no provisioning profiles; the signing keychain works only in Michele's graphical session, never in an SSH session.
- The App Store Connect API cannot create an app record; it can upload through Xcode's export, manage TestFlight groups and testers, and submit for beta review.
- The Apple account is a paid Developer Program (confirmed 2026-11-08).

## 2. Decision
1. **Distribution is TestFlight, to an external group "Family"** (T1): the relatives are testers, not users of the developer account. The groups called Family that already exist in the team are internal and hold only Michele, so the testers are the relatives' email addresses, given by Michele (8 November), attached to a new external group of Mondrop (an internal group of the same name already exists on the app, so the name may need a suffix).
2. **Everything that can be done through the App Store Connect API is done with an API key** (T2, T6): group, testers, test information, build assignment, beta review submission. Michele creates the key once and the app record (the one step the API cannot do; done on 8 November). **The key needs the Admin role**: with a lower role (what happened on 8 November) reading works but the cloud-signing export fails ("Cloud signing permission error") and creating a group is `403`. **Upload and signing do not depend on it**: `testflight.sh` without the `ASC_*` variables signs and uploads with the Apple ID Xcode is signed in with (the Account Holder of the team, which already has a managed distribution certificate), and that worked.
3. **The build is made by `ios/scripts/testflight.sh`** (T3–T5): Release archive, export `app-store-connect` with destination `upload`, automatic signing. It runs in the graphical session of the Mac through `open -a Terminal` (the keychain is available there), with the key passed by environment.
4. **The Release configuration is push-ready** (T3): `aps-environment` only in the Release entitlements, so the Debug build installed on the phone does not depend on the App ID's capabilities, and the server turns the push on when it has the APNs key, with no new build.
5. **App Store Connect's static requirements live in the repository** (T4): privacy manifests for the app and the extension, the export-compliance key, the iPad orientations.
6. **Secrets stay out of the repository** (T6): the `.p8` is kept in `~/.config/soundreel/appstoreconnect/` (0600) on both machines, never in a commit, `.env`, chat or log. Key ID and Issuer ID are identifiers, kept in a configuration file outside the public repository.

## 3. Alternatives considered
| Option | Why not |
|---|---|
| Internal testers (relatives as App Store Connect users) | No beta review, but the relatives become users of the developer account. Kept as an option if the review is a problem |
| Michele runs the script and clicks the group by hand | Works, but he asked for it to be done; the API key does both and leaves the process repeatable for every new build |
| Manual `.ipa` ad-hoc distribution | Needs each device registered (UDID) and a new profile per device; no update flow; TestFlight does all of that |
| Signing over SSH with `security unlock-keychain` | Needs Michele's login password on the command line: never |

## 4. Consequences
- ✅ The relatives install and update Mondrop from TestFlight; a new build is one command and a few API calls.
- ✅ No distribution certificate lives on the Mac (cloud-managed), and the key can be revoked at any time.
- ⚠️ A new secret (the API key); an App Manager (or Admin) key can manage the team's apps, so it is kept 0600 and revoked if it leaks.
- ⚠️ The first build of a version for external testers goes through Apple's beta review; builds expire after 90 days.
- ⚠️ The build number must grow with every upload of the same version.
- ✅ **The relatives are external testers, never developers** (Michele, 11 November: «Archimede […] non ha e non vuole account developer»): they receive Mondrop from the external group («FamilyPlus») with a plain Apple ID and the TestFlight app. The internal group needs App Store Connect users of the team (only Michele is one) and development builds need a registered device and Developer Mode: neither is a way to give the app to the family.
- ⚠️ TestFlight builds use the **production** APNs environment: development tokens (Xcode builds) and production tokens (TestFlight) coexist on the server, which picks the host by the environment each token registered with.

## 5. Open questions
See the spec, section 5: whether the app record exists, whether the existing "Family" group may be copied, whether Apple will ask for a privacy-policy URL, internal versus external testers.
