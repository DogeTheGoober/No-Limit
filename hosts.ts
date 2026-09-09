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
    upload: (file: LocalFile, opts: { litterboxTime: string }) => Promise<string>;
}

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

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
        note: "Permanent · 200 MB max",
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
        note: "Temporary · 1 GB max",
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
        note: "Expiry scales with size · 512 MiB max",
        async upload(file) {
            const form = new FormData();
            form.append("file", filePart(file));
            return postForm("https://0x0.st", form);
        },
    },
};

export const HOST_LIST = Object.values(HOSTS);
export const LITTERBOX_TIMES = ["1h", "12h", "24h", "72h"];
