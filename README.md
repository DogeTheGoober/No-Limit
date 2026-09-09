# BigUpload — Kettu / Bunny / Revenge plugin

Intercepts files that exceed your Discord upload limit, uploads them to an external
host, and sends the resulting link in chat.

## What this does and doesn't do

Discord enforces the attachment size cap **server-side**. No client patch can make a
300 MB file land as a genuine Discord attachment — the upload endpoint rejects it
before your client's opinion matters. So this plugin does the only thing that
actually works: it hands oversized files to Catbox / Litterbox / 0x0.st and posts
the link.

Consequences worth knowing before you use it:

- No inline video player or image embed for the offloaded file. Discord may unfurl a
  link preview for common image types; video will just be a link.
- The file lives on a public third-party host. Anyone with the URL can fetch it, and
  it isn't encrypted. Don't route anything private through it.
- Litterbox files expire on the schedule you pick. Catbox is permanent but has been
  known to prune inactive files.
- Client modding is against Discord's ToS in general, and this leans on that further.
  Account actions over client mods are rare in practice but not impossible.

## Build

The plugin is written against the Vendetta plugin API, which Kettu shims.

```bash
git clone https://github.com/vendetta-mod/plugin-template
cd plugin-template
cp -r /path/to/kettu-bigupload/plugins/bigupload plugins/
bun install          # or npm install
bun run build        # emits dist/bigupload/{index.js,manifest.json}
```

Serve `dist/` over HTTP and install from that URL in
**Settings → Kettu → Plugins → +**, or push `dist/` to GitHub Pages and install from
`https://<user>.github.io/<repo>/bigupload/`.

## If it silently does nothing

Discord reshuffles its internal module names often, and mobile diverges from desktop.
`src/modules.ts` tries several candidate shapes for each module and logs a warning to
the Kettu debug log when it can't resolve one. If you see
`could not resolve uploader`, open Kettu's developer tools and search the module
registry for the current upload function, then add its prop signature to the
`findFirst` call for `Uploader`. Same pattern for `PremiumLimits`.

The upload item shape (`opts.items[].item.uri`) is also a moving target. If sizing
comes back as 0 for everything, log `opts` inside the `uploadLocalFiles` patch in
`src/index.ts` and adjust.

## Adding a host

`src/hosts.ts` — add an entry with `maxBytes`, a `note` for the settings row, and an
`upload` function returning the final URL. RN's `fetch` streams files from disk when
you pass `{ uri, name, type }` as a FormData value, so large files never sit in JS
memory.
