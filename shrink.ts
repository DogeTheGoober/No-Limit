import { ReactNative } from "@vendetta/metro/common";
import { logger } from "@vendetta";

import { LocalFile } from "./hosts";

/**
 * The only way to get a *genuine* Discord attachment — with the native inline
 * player and no third-party host involved — is to get the file under the
 * server-side cap. For photos that's often just a matter of resolution, so if
 * the runtime still exposes ImageEditor we downscale and re-check.
 *
 * This is best-effort by design: React Native core deprecated ImageEditor, and
 * whether Discord's bundle still ships it varies by build. Every failure path
 * returns null and the caller falls back to offloading.
 */

const ImageEditor: any = (ReactNative as any).ImageEditor;

export const canShrink = typeof ImageEditor?.cropImage === "function";

function getSize(uri: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        ReactNative.Image.getSize(
            uri,
            (width: number, height: number) => resolve({ width, height }),
            reject,
        );
    });
}

function crop(uri: string, cropData: any): Promise<string> {
    return new Promise((resolve, reject) => ImageEditor.cropImage(uri, cropData, resolve, reject));
}

async function byteSize(uri: string): Promise<number> {
    const blob = await (await fetch(uri)).blob();
    return blob?.size ?? 0;
}

/**
 * Try to bring `file` under `targetBytes` by reducing resolution. Returns the
 * new file on success, or null if it isn't an image, isn't supported, or we
 * couldn't get under the cap without gutting the picture.
 */
export async function shrinkImage(
    file: LocalFile,
    size: number,
    targetBytes: number,
): Promise<LocalFile | null> {
    if (!canShrink) return null;
    if (!/^image\//i.test(file.mimeType ?? "")) return null;
    if (/heic|heif/i.test(file.mimeType ?? "")) return null; // ImageEditor won't read it

    try {
        const { width, height } = await getSize(file.uri);
        let scale = Math.sqrt(targetBytes / size) * 0.9;
        let uri = file.uri;

        // Byte size isn't linear in pixel count, so converge rather than guess.
        for (let attempt = 0; attempt < 3; attempt++) {
            const w = Math.max(320, Math.round(width * scale));
            const h = Math.max(320, Math.round(height * scale));

            uri = await crop(file.uri, {
                offset: { x: 0, y: 0 },
                size: { width, height },
                displaySize: { width: w, height: h },
                resizeMode: "contain",
            });

            const newSize = await byteSize(uri);
            if (newSize > 0 && newSize <= targetBytes) {
                return {
                    uri,
                    mimeType: "image/jpeg",
                    filename: file.filename.replace(/\.[a-z0-9]{1,5}$/i, "") + ".jpg",
                };
            }

            if (w <= 320 || h <= 320) break; // any smaller isn't worth sending
            scale *= 0.7;
        }
    } catch (err) {
        logger.warn("[BigUpload] shrink failed, offloading instead", err);
    }

    return null;
}
