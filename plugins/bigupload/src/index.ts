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
storage.showDetachToast ??= true;

const patches: (() => void)[] = [];

function icon(name: string) {
    try {
        return getAssetIDByName(name);
    } catch {
        return undefined;
    }
}

/**
 * Hermes does not reliably give each loop iteration its own binding for a
 * captured variable, so building these replacements inline inside the loop made
 * every gate return the last value assigned. A function call always gets a
 * fresh frame, which makes the capture correct regardless of the engine.
 */
function constantFn(value: any) {
    return () => value;
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

    for (const { module, key, value } of targets) {
        const original = module[key];
        const replacement = constantFn(value);

        try {
            module[key] = replacement;
        } catch {
            try {
                Object.defineProperty(module, key, {
                    value: replacement,
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
 * Take the file off Discord's hands entirely.
 *
 * Clearing the draft alone isn't enough: by the time upload() runs, Discord has
 * already queued an outgoing message carrying this attachment, so it goes ahead,
 * fails against the server-side cap, and leaves a "Failed to send message"
 * corpse above the link. cancel() and delete() tear down the pending message
 * itself, which is what actually stops that.
 *
 * Each step is attempted independently — the prototype varies between builds and
 * a missing method shouldn't stop the rest from running.
 */
function detach(upload: any) {
    const steps: [string, () => any][] = [
        ["cancel", () => upload.cancel?.()],
        ["_cancel", () => upload._cancel?.()],
        ["removeFromMsgDraft", () => upload.removeFromMsgDraft?.()],
        ["delete", () => upload.delete?.()],
        ["setStatus", () => upload.setStatus?.(CloudUploadStatus?.CANCELED ?? "CANCELED")],
    ];

    const done: string[] = [];

    for (const [name, run] of steps) {
        try {
            run();
            done.push(name);
        } catch (err) {
            logger.warn(`[BigUpload] detach step ${name} failed`, err);
        }
    }

    const summary = done.join(", ") || "nothing";
    logger.log(`[BigUpload] detached via: ${summary}`);

    // Surfaced as a toast rather than a log line: Kettu on iPadOS has no log
    // viewer without a desktop devtools server, and this is the one fact needed
    // to tell whether the teardown ran or threw.
    if (storage.showDetachToast) showToast(`detached: ${summary}`, icon("ic_info_24px"));
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
