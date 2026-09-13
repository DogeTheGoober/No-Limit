import * as metro from "@vendetta/metro";
const { findByProps } = metro;
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

/**
 * Discord checks the size in more than one place, and the name of the getter
 * differs between builds — which is why pinning three names missed the picker's
 * own check. Instead of guessing, sweep every loaded module for functions whose
 * name looks like a size limit and hand them all back to be patched.
 */
const LIMIT_RE = /^(get)?(user)?(max|upload)(file|attachment)?(size|limit)/i;
const TOO_LARGE_RE = /(isfile)?toolarge|exceedsmax/i;

export interface LimitTarget {
    module: any;
    key: string;
    /** true when the function reports megabytes rather than bytes */
    megabytes: boolean;
    /** true when it answers "is this too big?" and should return false */
    predicate: boolean;
}

export function findLimitTargets(): LimitTarget[] {
    const seen = new Set<any>();
    const targets: LimitTarget[] = [];

    const scan = (module: any) => {
        if (!module || seen.has(module) || typeof module !== "object") return;
        seen.add(module);

        for (const key of Object.keys(module)) {
            let value: any;
            try {
                value = module[key];
            } catch {
                continue; // some props throw on access
            }
            if (typeof value !== "function") continue;

            if (TOO_LARGE_RE.test(key)) {
                targets.push({ module, key, megabytes: false, predicate: true });
            } else if (LIMIT_RE.test(key)) {
                targets.push({ module, key, megabytes: /mb$/i.test(key), predicate: false });
            }
        }
    };

    // findAll isn't present on every Vendetta/Kettu build, so degrade gracefully.
    const findAll = (metro as any).findAll ?? (metro as any).findByPropsAll;

    try {
        if (typeof (metro as any).findAll === "function") {
            for (const m of (metro as any).findAll((m: any) => {
                try {
                    return Object.keys(m ?? {}).some(k => LIMIT_RE.test(k) || TOO_LARGE_RE.test(k));
                } catch {
                    return false;
                }
            })) scan(m);
        } else if (typeof findAll === "function") {
            for (const name of ["getUserMaxFileSize", "getUploadLimit", "getMaxFileSizeMB"]) {
                for (const m of findAll(name) ?? []) scan(m);
            }
        }
    } catch (err) {
        logger.warn("[BigUpload] module sweep failed", err);
    }

    // Always include the originally-targeted module, sweep or no sweep.
    scan(PremiumLimits);

    logger.log(
        `[BigUpload] size-limit functions found: ${
            targets.map(t => t.key).join(", ") || "NONE"
        }`,
    );

    return targets;
}
