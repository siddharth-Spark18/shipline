# Use Shipline from your phone

Answer a waiting gate or permission prompt from your phone while you are away from your computer.

[Back to the README](../README.md)

A chat that stops at a gate or a permission prompt waits for you. With phone access you open the same UI on your own
phone, over your own [Tailscale](https://tailscale.com) network, and answer it from there. A paired phone can do
everything the laptop page can. It works only while your computer is awake and `shipline ui` is running, and only
for an installed repo (not in the install wizard).

1. Install Tailscale on the computer and the phone, and sign in to the same account on both.
2. In the Tailscale admin console, turn on **HTTPS certificates** (DNS page).
3. Start the UI with `--remote`, or open **Setup > Phone access** and switch it on. Shipline runs
   `tailscale serve` for you and removes it when you stop the UI or switch it off.
4. In **Setup > Phone access** press **Pair a phone** and scan the QR code with the phone. The link works once and
   expires after 5 minutes. Name the device on the phone's screen.
5. Optional: **Add to home screen** (Safari: Share > Add to Home Screen) to open Shipline full screen like an app. A
   home-screen app may not share Safari's pairing, so if it opens as "not paired", press **Enter pairing code** there and
   type the 8-character code (`XXXX-XXXX`, any case, dash optional) that **Pair a phone** shows under the QR code. The
   code and the QR link are one pairing: using either uses up both, and after 5 wrong codes in a row the pairing is
   cancelled and you make a new one.

On a phone the UI switches to a phone layout (narrower than 768 px): a tab bar with Chats, New and Setup, and a chat
that waits for you shows its question or tool approval in a bar above the message box, answered with one large tap.

Paired devices are kept in `~/.shipline/devices.json` (or `$SHIPLINE_HOME`), for every repo, and stay paired until you
**Revoke** them in the same panel (which cuts them off at once). Turning phone access off keeps the pairings.

Security notes:

- Traffic goes only through your tailnet, over HTTPS. Nothing is public and there is no relay.
- A request must come from the same Tailscale user that is signed in on the computer, and from a paired device
  (a secret cookie; only its hash is stored). Another person on your tailnet cannot use it, even on a shared machine.
- The phone can do what you can do in the UI, so treat a paired phone like a logged-in terminal. Revoke a lost phone.
- Device actions are written to the repo's `ui.log` (who, method, path, status; never message text).
- If port 443 is taken on your tailnet name, Shipline uses 8443 or 10000 and never changes a mapping it didn't make.

## If the phone can't open the page

- **"This site can't be reached" / "Safari can't find the server".** In the Tailscale app on the phone, turn on
  **Use Tailscale DNS** (it resolves the `*.ts.net` name), and check the VPN switch is on. On an iPhone, turn off
  **iCloud Private Relay** for the network or in Settings, since it can bypass Tailscale's DNS.
- **It opens "not paired".** Pair again from **Setup > Phone access** on the computer, or press **Enter pairing
  code** on the phone.
- **It worked and then stopped.** `shipline ui` was stopped or the computer went to sleep. Start it again with
  `--remote`; the phone stays paired.
