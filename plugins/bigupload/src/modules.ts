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

/**
 * Current Discord mobile has no `uploadLocalFiles`. Each attachment gets its
 * own CloudUpload instance and `upload()` on that instance is what actually
 * ships the bytes, so that prototype method is the interception point.
 */
const CloudUploadModule: any = findFirst("CloudUpload", ["CloudUpload"]);

export const CloudUpload: any = CloudUploadModule?.CloudUpload ?? null;
export const CloudUploadStatus: any = CloudUploadModule?.CloudUploadStatus ?? null;

export const MessageActions = findFirst(
    "MessageActions",
    ["sendMessage", "receiveMessage"],
    ["sendMessage", "editMessage"],
);

/** Client-side size gates. Real names, read off the running app. */
export const FileUtils = findFirst("fileUtils", ["anyFileTooLarge", "maxFileSize"]);
export const PremiumLimits = findFirst("premiumLimits", [
    "getUserMaxFileSize",
    "canUploadLargeFiles",
]);

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
    for (const candidate of [
        item?.size,
        item?.fileSize,
        item?.currentSize,
        item?.item?.size,
        item?.file?.size,
    ]) {
        const n = Number(candidate);
        if (Number.isFinite(n) && n > 0) return n;
    }

    const uri: string = item?.uri ?? item?.item?.uri ?? "";

    if (FileManager && uri) {
        // DCDFileManager wants a bare path, not a file:// URL — passing the
        // URL through is a silent no-result rather than an error.
        const paths = [uri.replace(/^file:\/\//, ""), uri];

        for (const method of ["getSize", "calculateSize"]) {
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
    }

    logger.warn(`[BigUpload] no size for ${item?.filename ?? "file"}; assuming oversized`);
    return -1;
}

/**
 * The functions Discord consults before letting a file through the picker.
 * Targeted rather than swept: these names came off the running app, and a
 * blanket sweep risks patching unrelated getters.
 */
export function limitTargets(): { module: any; key: string; value: any }[] {
    const HUGE = 4 * 1024 * 1024 * 1024; // 4 GiB
    const out: { module: any; key: string; value: any }[] = [];

    const add = (module: any, key: string, value: any) => {
        if (module && typeof module[key] === "function") out.push({ module, key, value });
    };

    add(FileUtils, "maxFileSize", HUGE);
    add(FileUtils, "getMaxRequestSize", HUGE);
    add(FileUtils, "anyFileTooLarge", false);
    add(FileUtils, "uploadSumTooLarge", false);
    add(PremiumLimits, "getUserMaxFileSize", HUGE);
    add(PremiumLimits, "canUploadLargeFiles", true);

    logger.log(`[BigUpload] size gates found: ${out.map(t => t.key).join(", ") || "NONE"}`);
    return out;
}
