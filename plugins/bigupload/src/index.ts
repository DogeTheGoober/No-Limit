import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { clipboard } from "@vendetta/metro/common";
import { showToast } from "@vendetta/ui/toasts";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { logger } from "@vendetta";

import { HOSTS, EMBED_PREFERENCE, LocalFile, normalizeName, willEmbed } from "./hosts";
import { Uploader, MessageActions, fileSize, findLimitTargets } from "./modules";
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
    const targets = findLimitTargets();

    if (targets.length === 0) {
        showToast("BigUpload: found no size checks to lift", icon("Small"));
        return;
    }

    for (const { module, key, megabytes, predicate } of targets) {
        try {
            patches.push(
                instead(key, module, () =>
                    predicate ? false : megabytes ? FAKE_LIMIT / 1048576 : FAKE_LIMIT,
                ),
            );
        } catch (err) {
            logger.warn(`[BigUpload] could not patch ${key}`, err);
        }
    }

    logger.log(`[BigUpload] lifted ${patches.length} size check(s)`);
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
