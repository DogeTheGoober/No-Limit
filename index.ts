import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { clipboard } from "@vendetta/metro/common";
import { showToast } from "@vendetta/ui/toasts";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { logger } from "@vendetta";

import { HOSTS, LocalFile } from "./hosts";
import { Uploader, MessageActions, PremiumLimits, fileSize } from "./modules";
import Settings from "./Settings";

storage.host ??= "catbox";
storage.litterboxTime ??= "24h";
storage.limitMiB ??= 10;
storage.autoSend ??= true;
storage.spoiler ??= false;
storage.raiseClientLimit ??= true;

const patches: (() => void)[] = [];
const FAKE_LIMIT = 4 * 1024 * 1024 * 1024; // 4 GiB, purely so the picker stops complaining

function icon(name: string) {
    try {
        return getAssetIDByName(name);
    } catch {
        return undefined;
    }
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
    if (!PremiumLimits) return;

    for (const key of ["getUserMaxFileSize", "getUploadLimit", "getMaxFileSizeMB"]) {
        if (typeof PremiumLimits[key] !== "function") continue;
        const asMegabytes = key === "getMaxFileSizeMB";
        patches.push(
            instead(key, PremiumLimits, () => (asMegabytes ? FAKE_LIMIT / 1048576 : FAKE_LIMIT)),
        );
    }
}

async function offload(channelId: string, file: LocalFile, size: number) {
    const host = HOSTS[storage.host] ?? HOSTS.catbox;

    if (size > host.maxBytes) {
        showToast(
            `${file.filename} is too big for ${host.name} (${host.note})`,
            icon("Small"),
        );
        return;
    }

    showToast(`Uploading ${file.filename} to ${host.name}…`, icon("ic_upload"));

    try {
        const link = await host.upload(file, { litterboxTime: storage.litterboxTime });
        const content = storage.spoiler ? `|| ${link} ||` : link;

        if (storage.autoSend) {
            sendLink(channelId, content);
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
    if (!Uploader) {
        showToast("BigUpload: couldn't hook Discord's uploader", icon("Small"));
        return;
    }

    patches.push(
        instead("uploadLocalFiles", Uploader, function (args: any[], orig: Function) {
            const opts = args[0];
            const items: any[] = opts?.items;

            if (!Array.isArray(items) || items.length === 0) return orig.apply(this, args);

            const limit = Math.max(1, Number(storage.limitMiB)) * 1024 * 1024;

            // Sizing is async but the original call is sync, so we cancel here
            // and re-dispatch the under-limit files ourselves a tick later.
            (async () => {
                try {
                    const sized = await Promise.all(
                        items.map(async entry => {
                            const file = entry?.item ?? entry;
                            return { entry, file, size: await fileSize(file) };
                        }),
                    );

                    const small = sized.filter(x => x.size <= limit);
                    const large = sized.filter(x => x.size > limit);

                    if (small.length) {
                        orig.call(this, { ...opts, items: small.map(x => x.entry) });
                    }

                    for (const { file, size } of large) {
                        await offload(opts.channelId, file, size);
                    }
                } catch (err) {
                    logger.error("[BigUpload] triage failed, falling back to Discord", err);
                    orig.apply(this, args);
                }
            })();

            return undefined; // swallow the original synchronous call
        }),
    );
}

export const onLoad = () => {
    if (storage.raiseClientLimit) raiseClientLimit();
    hookUploads();
};

export const onUnload = () => {
    for (const unpatch of patches.splice(0)) unpatch();
};

export const settings = Settings;
