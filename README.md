# BigUpload — Kettu / Bunny / Revenge plugin

Intercepts files that exceed your Discord upload limit, uploads them to an external
host, and sends the resulting link in chat.

## Install

```
https://dogethegoober.github.io/No-Limit/bigupload/
```

Copy that URL — don't click it — and paste it into **Settings → Kettu → Plugins → +**.

## What this does and doesn't do

Discord enforces the attachment size cap **server-side**. No client patch can make a
300 MB file land as a genuine Discord attachment — the upload endpoint rejects it
before your client's opinion matters. So this plugin does the only thing that
actually works: it hands oversized files to Catbox / Litterbox / 0x0.st and posts
the link.

### Will other people see the media inline?

Usually yes, for images and video. Discord unfurls a direct media URL into a real
embed — an image renders in the channel, and an `.mp4` or `.webm` gets a play button
your friends can hit without leaving the chat. It renders as an embed rather than a
native attachment, but nobody has to open another site.

Three things have to hold for that to work, and the plugin now handles all three:

- **The link must be the entire message.** No surrounding text, no `<>`, and no
  spoiler tags — any of those suppress the unfurl. The "wrap link in spoiler"
  setting still exists, but turning it on means no preview for anyone.
- **The host must serve the raw bytes with a sane Content-Type.** Catbox and
  Litterbox do; 0x0.st is inconsistent. With *Use a preview-friendly host for media*
  on, media gets routed through Catbox even if you've selected another host.
- **The URL must end in an extension Discord recognises.** iOS hands over names like
  `IMG_0042.MOV`, or sometimes no extension at all, which quietly costs the preview.
  Filenames are normalised before upload.

Reliably previews: `jpg` `jpeg` `png` `gif` `webp` `mp4` `webm`.
Won't preview: `mov`, `heic`, archives, documents — those stay plain links, and you
get a toast saying so. If you shoot photos on an iPhone or iPad, turning off
**Settings → Camera → Formats → High Efficiency** gets you JPEGs instead of HEICs and
is the single biggest fix here.

Very large videos may also exceed what Discord's proxy will fetch and degrade to a
plain link card. Test in a channel with just you before relying on it.

### Getting a real attachment instead

The only way to get a genuine Discord attachment is to get under the cap. *Resize
oversized photos to fit* downscales a photo until it fits and uploads it normally —
no third-party host, native preview, at the cost of resolution. It depends on
`ImageEditor` still being present in Discord's bundle, and the toggle greys itself
out when it isn't. There's no equivalent for video: transcoding isn't possible from
inside the client.

### Other consequences worth knowing

- The file lives on a public third-party host. Anyone with the URL can fetch it, and
  it isn't encrypted. Don't route anything private through it.
- Litterbox files expire on the schedule you pick. Catbox is permanent but has been
  known to prune inactive files.
- Client modding is against Discord's ToS in general, and this leans on that further.
  Account actions over client mods are rare in practice but not impossible.

## Build

Pushing to `main` builds and publishes to GitHub Pages automatically — see
`.github/workflows/deploy.yml`. To build locally:

```
npm install
node build.mjs      # emits dist/bigupload/{index.js,manifest.json}
```

Serve `dist/` over HTTP and install from that URL to test an unpublished change.

## If it silently does nothing

Discord reshuffles its internal module names often, and mobile diverges from desktop.
`src/modules.ts` tries several candidate shapes for each module and logs a warning to
the Kettu debug log when it can't resolve one. If you see `could not resolve uploader`,
open Kettu's developer tools and search the module registry for the current upload
function, then add its prop signature to the `findFirst` call for `Uploader`. Same
pattern for `PremiumLimits`.

The upload item shape (`opts.items[].item.uri`) is also a moving target. If sizing
comes back as 0 for everything, log `opts` inside the `uploadLocalFiles` patch in
`src/index.ts` and adjust.

## Adding a host

`src/hosts.ts` — add an entry with `maxBytes`, a `note` for the settings row,
`embedsMedia` (whether Discord will unfurl its URLs), and an `upload` function
returning the final URL. RN's `fetch` streams files from disk when you pass
`{ uri, name, type }` as a FormData value, so large files never sit in JS memory.
