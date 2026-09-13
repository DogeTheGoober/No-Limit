import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { clipboard } from "@vendetta/metro/common";
import { showToast } from "@vendetta/ui/toasts";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { logger } from "@vendetta";

import { HOSTS, EMBED_PREFERENCE, LocalFile, normalizeName, willEmbed } from "./hosts";
import {
    CloudUpload,
    CloudUploadStatus,
    FileUtils,
    MessageActions,
    fileSize,
    limitTargets,
} from "./modules";
import { shrinkImage, canShrink } from "./shrink";
import Settings from "./Settings";

storage.host ??= "catbox";
storage.litterboxTime ??= "24h";
storage.limitMiB ??= 10;
storage.autoSend ??= true;
storage.spoiler ??= false;
storage.raiseClientLimit ??= true;
storage.preferEmbedHost ??= true;
storage.shrinkImages ??= false;

const patches: (() => void)[] = [];

function icon(name: string) {
    try {
        return getAssetIDByName(name);
    } catch {
        return undefined;
    }
}

function limitBytes() {
    return Math.max(1, Number(storage.limitMiB)) * 1024 * 1024;
}

function sendLink(channelId: string, content: string) {
    MessageActions?.sendMessage?.(
        channelId,
        { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
        undefined,
        {},
    );
}

/**
 * Discord refuses the file in the picker before it ever reaches the upload
 * queue, so we lift the *client-side* ceiling to let it through to our hook.
 * This does nothing to the server-side limit — oversized files still never
 * become real Discord attachments.
 */
function raiseClientLimit() {
    const targets = limitTargets();

    // Zeroing the running total makes uploadSumTooLarge fall out false even
    // when it computes the comparison internally rather than calling the
    // exported gate.
    if (FileUtils && typeof FileUtils.getUploadFileSizeSum === "function") {
        targets.push({ module: FileUtils, key: "getUploadFileSizeSum", value: 0 });
    }

    if (targets.length === 0) {
        showToast("BigUpload: found no size checks to lift", icon("Small"));
        return;
    }

    // Assigned directly rather than through the patcher: routing these through
    // instead() returned a constant `true` for every gate no matter what value
    // was supplied, so the replacement never took effect. A plain assignment
    // with the original stashed for unload has no such ambiguity.
    for (const { module, key, value } of targets) {
        const original = module[key];

        try {
            module[key] = () => value;
        } catch {
            try {
                Object.defineProperty(module, key, {
                    value: () => value,
                    configurable: true,
                    writable: true,
                });
            } catch (err) {
                logger.warn(`[BigUpload] could not patch ${key}`, err);
                continue;
            }
        }

        patches.push(() => {
            try {
                module[key] = original;
            } catch {
                /* best effort on unload */
            }
        });
    }

    logger.log(`[BigUpload] lifted ${patches.length} gate(s)`);
}

/**
 * A link only becomes an inline preview if the host serves the raw bytes with
 * a usable Content-Type, so when the file is something Discord can render we
 * override the configured host rather than silently costing the user a
 * preview. Falls back to their choice if nothing better fits the size.
 */
function pickHost(file: LocalFile, size: number) {
    const chosen = HOSTS[storage.host] ?? HOSTS.catbox;

    if (!storage.preferEmbedHost || chosen.embedsMedia || !willEmbed(file.filename)) return chosen;

    for (const key of EMBED_PREFERENCE) {
        const candidate = HOSTS[key];
        if (candidate && size <= candidate.maxBytes) return candidate;
    }

    return chosen;
}

/** Pull a {uri, filename, mimeType} out of whatever shape the instance holds. */
function toLocalFile(upload: any): LocalFile {
    const item = upload?.item ?? upload;
    return {
        uri: item?.uri ?? upload?.uri ?? "",
        filename: item?.filename ?? upload?.filename ?? "upload",
        mimeType: item?.mimeType ?? upload?.mimeType ?? item?.type,
    };
}

/**
 * Take the file off Discord's hands entirely: clear it from the pending draft
 * so the composer doesn't sit on "Sending…" waiting for an upload that will
 * never complete, then post the hosted link as an ordinary message.
 */
function detach(upload: any) {
    try {
        upload.setStatus?.(CloudUploadStatus?.CANCELED ?? "CANCELED");
    } catch {
        /* status enum shape varies; not fatal */
    }
    try {
        upload.removeFromMsgDraft?.();
    } catch {
        /* ditto */
    }
}

async function offload(channelId: string, raw: LocalFile, size: number) {
    const file = normalizeName(raw);
    const host = pickHost(file, size);

    if (size < 0) {
        showToast(`Couldn't read ${file.filename}'s size — offloading to be safe`, icon("Small"));
    } else if (size > host.maxBytes) {
        showToast(`${file.filename} is too big for ${host.name} (${host.note})`, icon("Small"));
        return;
    }

    showToast(`Uploading ${file.filename} to ${host.name}…`, icon("ic_upload"));

    try {
        const link = await host.upload(file, { litterboxTime: storage.litterboxTime });

        // Spoiler tags suppress the unfurl entirely, and so do angle brackets —
        // the link has to be the whole message body to get a preview.
        const content = storage.spoiler ? `||${link}||` : link;

        if (storage.autoSend) {
            sendLink(channelId, content);

            if (!storage.spoiler && !willEmbed(file.filename)) {
                showToast("Sent as a link — Discord won't preview this file type", icon("Small"));
            }
        } else {
            clipboard.setString(content);
            showToast("Link copied to clipboard", icon("toast_copy_link"));
        }
    } catch (err: any) {
        logger.error("[BigUpload] upload failed", err);
        showToast(`${host.name} upload failed: ${err?.message ?? err}`, icon("Small"));
    }
}

function hookUploads() {
    if (!CloudUpload?.prototype) {
        showToast("BigUpload: couldn't hook Discord's uploader", icon("Small"));
        return;
    }

    patches.push(
        instead("upload", CloudUpload.prototype, function (args: any[], orig: Function) {
            const upload = this;

            // upload() is fire-and-forget, so doing the sizing asynchronously
            // and deciding afterwards is safe — nothing is awaiting a result.
            (async () => {
                try {
                    const limit = limitBytes();
                    const size = await fileSize(upload);

                    if (size >= 0 && size <= limit) return orig.apply(upload, args);

                    const file = toLocalFile(upload);

                    // Squeezing it under the cap beats any link we could post,
                    // so try that before giving up on a real attachment.
                    if (storage.shrinkImages && size > 0) {
                        const shrunk = await shrinkImage(file, size, limit);
                        if (shrunk) {
                            if (upload.item) Object.assign(upload.item, shrunk);
                            upload.filename = shrunk.filename;
                            showToast(`Resized ${shrunk.filename} to fit`, icon("ic_image"));
                            return orig.apply(upload, args);
                        }
                    }

                    detach(upload);
                    await offload(upload.channelId, file, size);
                } catch (err) {
                    logger.error("[BigUpload] triage failed, falling back to Discord", err);
                    try {
                        orig.apply(upload, args);
                    } catch {
                        /* nothing left to try */
                    }
                }
            })();

            return undefined; // swallow the original synchronous call
        }),
    );
}

export const onLoad = () => {
    if (storage.raiseClientLimit) raiseClientLimit();
    if (storage.shrinkImages && !canShrink) {
        logger.warn("[BigUpload] ImageEditor unavailable; resize option will no-op");
    }
    hookUploads();
};

export const onUnload = () => {
    for (const unpatch of patches.splice(0)) unpatch();
};

export const settings = Settings;
