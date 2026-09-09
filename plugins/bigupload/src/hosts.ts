export interface LocalFile {
    uri: string;
    filename: string;
    mimeType?: string;
}

export interface Host {
    key: string;
    name: string;
    maxBytes: number;
    note: string;
    /**
     * Whether Discord's link unfurler reliably turns a direct URL from this
     * host into an inline image/video embed. Catbox and Litterbox serve the
     * raw file with a sane Content-Type; 0x0.st is inconsistent about it.
     */
    embedsMedia: boolean;
    upload: (file: LocalFile, opts: { litterboxTime: string }) => Promise<string>;
}

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

/**
 * Extensions Discord will unfurl into a real inline player or image.
 * .mov and .heic are deliberately absent — Discord's proxy handles the first
 * inconsistently and refuses the second outright.
 */
const EMBEDDABLE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm"];

const MIME_EXT: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heic",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
};

export function extensionOf(name: string): string {
    const match = /\.([a-z0-9]{1,5})$/i.exec(name || "");
    return match ? match[1].toLowerCase() : "";
}

export function willEmbed(name: string): boolean {
    return EMBEDDABLE_EXTS.includes(extensionOf(name));
}

/**
 * Catbox names the stored file after the `name` we put in the form part, and
 * Discord decides whether to embed based on the extension in the resulting
 * URL. iOS hands us names like "IMG_0042.MOV" or sometimes no extension at
 * all, either of which quietly costs us the preview — so fix the name up
 * before it ever reaches the host.
 */
export function normalizeName(file: LocalFile): LocalFile {
    const fromMime = file.mimeType ? MIME_EXT[file.mimeType.toLowerCase().split(";")[0]] : "";
    const current = extensionOf(file.filename);

    let filename = file.filename || "upload";

    if (!current && fromMime) {
        filename = `${filename}.${fromMime}`;
    } else if (current) {
        // Lowercase the extension; the unfurler is fussier than it should be.
        filename = filename.replace(/\.[a-z0-9]{1,5}$/i, `.${current}`);
    }

    return { ...file, filename };
}

/**
 * React Native's fetch accepts a { uri, name, type } object as a FormData value
 * and streams the file straight from disk, so we never hold the bytes in JS.
 */
function filePart(file: LocalFile) {
    return {
        uri: file.uri,
        name: file.filename,
        type: file.mimeType || "application/octet-stream",
    } as unknown as Blob;
}

async function postForm(url: string, form: FormData): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        body: form,
        headers: { "User-Agent": UA },
    });

    const text = (await res.text()).trim();

    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 120) || "no response body"}`);
    if (!/^https?:\/\//.test(text)) throw new Error(text.slice(0, 120) || "host returned no URL");

    return text;
}

export const HOSTS: Record<string, Host> = {
    catbox: {
        key: "catbox",
        name: "Catbox",
        maxBytes: 200 * 1024 * 1024,
        note: "Permanent · 200 MB max · previews work",
        embedsMedia: true,
        async upload(file) {
            const form = new FormData();
            form.append("reqtype", "fileupload");
            form.append("fileToUpload", filePart(file));
            return postForm("https://catbox.moe/user/api.php", form);
        },
    },

    litterbox: {
        key: "litterbox",
        name: "Litterbox",
        maxBytes: 1024 * 1024 * 1024,
        note: "Temporary · 1 GB max · previews work",
        embedsMedia: true,
        async upload(file, { litterboxTime }) {
            const form = new FormData();
            form.append("reqtype", "fileupload");
            form.append("time", litterboxTime);
            form.append("fileToUpload", filePart(file));
            return postForm("https://litterbox.catbox.moe/resources/internals/api.php", form);
        },
    },

    nullpointer: {
        key: "nullpointer",
        name: "0x0.st",
        maxBytes: 512 * 1024 * 1024,
        note: "Expiry scales with size · 512 MiB · previews unreliable",
        embedsMedia: false,
        async upload(file) {
            const form = new FormData();
            form.append("file", filePart(file));
            return postForm("https://0x0.st", form);
        },
    },
};

/** Ordered best-to-worst for getting an inline preview. */
export const EMBED_PREFERENCE = ["catbox", "litterbox"];

export const HOST_LIST = Object.values(HOSTS);
export const LITTERBOX_TIMES = ["1h", "12h", "24h", "72h"];
