# Slack Channel Auto-Sort

A Chrome extension that automatically moves new Slack channels into the correct sidebar section based on the channel's name prefix. Set the rules once, and every new channel that matches a prefix gets dropped into the right section without you doing anything.

Example: a channel called `vsl-newclient` gets moved into the **VSL** section automatically.

---

## Install (one-time setup, ~30 seconds)

1. **Download** the latest `slack-auto-sort-*.zip` from the [**Releases page**](https://github.com/unorthodox-digital/slack-auto-sort/releases/latest) — click the `.zip` under **Assets** (the newest version is always at the top).
2. **Unzip** it somewhere you'll keep it (e.g. `~/Documents/slack-auto-sort/`). Don't delete the folder after — Chrome loads from it directly.
3. Open Chrome and go to **`chrome://extensions`** (paste that into the address bar).
4. Toggle **Developer mode** ON (top-right corner of the page).
5. Click **Load unpacked** (top-left), then select the unzipped `slack-auto-sort` folder.
6. The extension's icon (a puzzle piece) will appear in your Chrome toolbar. Pin it for easy access.

That's it. Reload Slack (`app.slack.com`) and the extension will start working in the background.

---

## Configure your rules

1. Click the extension's icon in the Chrome toolbar.
2. The popup shows your **Channel → Section Rules**. Each row is one rule:
   - **Left field** = channel name prefix (e.g. `vsl-`, `systems-`)
   - **Right field** = the exact name of a section in your Slack sidebar (e.g. `VSL`)
3. Click **+ Add Rule** to add another row, or the red `✕` to remove one.
4. Click **Save Rules** when done.

The defaults that ship with the extension are:

| Prefix      | Section      |
|-------------|--------------|
| `vsl-`      | VSL          |
| `systems-`  | Systems      |
| `funnel-`   | Funnel Build |
| `internal-` | Internal     |

Tweak them however you want.

---

## Auto-read (optional — off by default)

The extension can also keep noisy channels out of your **Activity** feed by marking them read for you every minute. This is **off until you turn it on**. Open the popup and you'll see three lists:

- **Auto-Read Prefixes** — channels matching these get *all* messages marked read every minute.
- **Auto-Read Invitations to:** — auto-clears "you were added to a channel" notices for matching prefixes.
- **Auto-Read Broadcasts in:** — auto-clears `@channel` / `@here`, bot, and system messages in matching channels.

Add the prefixes you want (e.g. `vsl-`), click **Save**, and reload Slack. Your direct **@-mentions always stay unread** — Slack still notifies you on those.

---

## How it works (briefly)

- Every 60 seconds, the extension reads your channel list from Slack's API and checks whether any channel's name starts with one of your prefixes but isn't already in the matching section. If it finds a mismatch, it moves the channel into the right section.
- It only moves channels — it never creates, archives, leaves, or deletes anything.
- The section must already exist in your Slack sidebar. The extension won't create a section for you. (If a rule references a section that doesn't exist yet, it'll log a warning and skip those channels.)

---

## Troubleshooting

**Channels aren't moving.**
- Make sure the section name in the rule matches your Slack sidebar exactly — spelling and capitalization both matter.
- Make sure the section exists in your Slack sidebar already. Create it manually first if needed.
- Reload the Slack tab. The extension polls every 60s after a 5s boot delay.

**Open the browser console to see what it's doing.**
- In Slack, right-click → Inspect → Console tab. Filter for `[auto-sort]`. You'll see lines like `Moved #vsl-newclient → VSL` when it acts.

**Updating the extension.**
- Download the newest `.zip` from the [Releases page](https://github.com/unorthodox-digital/slack-auto-sort/releases/latest), unzip it, and replace the contents of your existing extension folder with the new files. Then click the **reload** icon (⟳) on the extension's card at `chrome://extensions`. Your saved rules are kept.

---

## Privacy

The extension runs entirely in your browser. It uses your existing Slack session — no separate login, no data sent anywhere except to Slack itself. Rules are stored in Chrome's `storage.sync` (synced across your Chrome profiles, scoped to you).
