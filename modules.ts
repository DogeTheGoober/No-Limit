import { findByProps } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { logger } from "@vendetta";

/**
 * Discord renames and reshuffles its internal modules constantly, and mobile
 * lags desktop. Rather than pinning one prop name, try several candidate
 * shapes and log loudly if none hit, so the plugin degrades to a no-op
 * instead of throwing on load.
 */
export function findFirst(label: string, ...propSets: string[][]) {
    for (const props of propSets) {
        try {
            const mod = findByProps(...props);
            if (mod) return mod;
        } catch {
            /* keep trying */
        }
    }
    logger.warn(`[BigUpload] could not resolve ${label} — tried ${propSets.length} candidates`);
    return null;
}

export const Uploader = findFirst(
    "uploader",
    ["uploadLocalFiles"],
    ["uploadFiles", "cancelUpload"],
    ["upload", "cancel", "getUploads"],
);

export const MessageActions = findFirst(
    "MessageActions",
    ["sendMessage", "receiveMessage"],
    ["sendMessage", "editMessage"],
);

export const PremiumLimits = findFirst(
    "PremiumLimits",
    ["getUserMaxFileSize", "getPremiumSubscriptionType"],
    ["getUploadLimit"],
    ["getMaxFileSizeMB"],
);

export const FileManager: any =
    ReactNative.NativeModules.DCDFileManager ??
    ReactNative.NativeModules.RNFileManager ??
    ReactNative.NativeModules.FileManager;

/** Best-effort byte size for a picked file. */
export async function fileSize(item: any): Promise<number> {
    if (typeof item?.size === "number" && item.size > 0) return item.size;

    try {
        const reported = await FileManager?.getSize?.(item.uri);
        if (reported) return Number(reported);
    } catch {
        /* fall through */
    }

    // Last resort: let the platform read it. Costs a copy, so it's the fallback.
    try {
        const blob = await (await fetch(item.uri)).blob();
        if (blob?.size) return blob.size;
    } catch {
        /* fall through */
    }

    logger.warn(`[BigUpload] no size for ${item?.filename ?? "file"}; treating as under limit`);
    return 0;
}
