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

/**
 * Returns the file's size in bytes, or -1 when it genuinely cannot be
 * determined. -1 rather than 0 matters: the caller treats unknown as
 * "probably too big" and offloads, because guessing "small" hands the file
 * straight to Discord, which is exactly the failure this plugin exists to
 * avoid.
 */
export async function fileSize(item: any): Promise<number> {
    // The picked entry nests differently depending on where it came from.
    for (const candidate of [item?.size, item?.fileSize, item?.item?.size, item?.file?.size]) {
        const n = Number(candidate);
        if (Number.isFinite(n) && n > 0) return n;
    }

    const uri: string = item?.uri ?? item?.item?.uri ?? "";

    if (FileManager && uri) {
        // DCDFileManager generally wants a bare path, not a file:// URL —
        // passing the URL through is a silent no-result rather than an error.
        const paths = [uri.replace(/^file:\/\//, ""), uri];
        const methods = ["getSize", "getFileSize", "fileSize", "statFile", "stat", "getInfo"];

        for (const method of methods) {
            if (typeof FileManager[method] !== "function") continue;

            for (const path of paths) {
                try {
                    const result = await FileManager[method](path);
                    const n = Number(
                        result && typeof result === "object"
                            ? result.size ?? result.fileSize ?? result.length
                            : result,
                    );
                    if (Number.isFinite(n) && n > 0) {
                        logger.log(`[BigUpload] size ${n} via ${method}`);
                        return n;
                    }
                } catch {
                    /* try the next shape */
                }
            }
        }

        logger.warn(
            `[BigUpload] FileManager methods available: ${Object.keys(FileManager).join(", ")}`,
        );
    }

    // Reading the whole file just to measure it would mean holding a 240 MB
    // buffer in JS, so only try this for things small enough to be harmless.
    try {
        const blob = await (await fetch(uri)).blob();
        if (blob?.size) return blob.size;
    } catch {
        /* fall through */
    }

    logger.warn(`[BigUpload] no size for ${item?.filename ?? "file"}; assuming oversized`);
    return -1;
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
