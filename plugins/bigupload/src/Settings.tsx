import { React, ReactNative, clipboard } from "@vendetta/metro/common";
import { showToast } from "@vendetta/ui/toasts";
import { findByProps } from "@vendetta/metro";
import { useProxy } from "@vendetta/storage";
import { storage } from "@vendetta/plugin";
import { Forms } from "@vendetta/ui/components";

import { HOST_LIST, LITTERBOX_TIMES } from "./hosts";
import { canShrink } from "./shrink";

const { FormSection, FormRow, FormSwitchRow, FormRadioRow, FormInput, FormDivider } = Forms;
const { ScrollView } = ReactNative;
/**
 * Dumps what the plugin can actually see in Discord's module registry onto the
 * clipboard. Module names drift between Discord builds, so when a lookup starts
 * failing this is the only way to find out what it should be looking for
 * instead — without needing to dig through the debug log on a tablet.
 */
function copyDiagnostics() {
    const out: string[] = [];
    const metro: any = (globalThis as any).vendetta?.metro ?? {};

    out.push(`metro API: ${Object.keys(metro).join(", ") || "(none visible)"}`);

    for (const probe of [
        ["uploadLocalFiles"],
        ["uploadFiles", "cancelUpload"],
        ["upload", "cancel", "getUploads"],
        ["sendMessage", "receiveMessage"],
    ]) {
        let hit = false;
        try {
            hit = !!findByProps(...probe);
        } catch {
            /* report as a miss */
        }
        out.push(`findByProps(${probe.join(",")}) -> ${hit ? "FOUND" : "null"}`);
    }

    // Anything upload-shaped, whatever it happens to be called this week.
    try {
        const seen = new Set<string>();
        const matches = metro.findAll?.((m: any) => {
            try {
                return Object.keys(m ?? {}).some(k => /upload|attach/i.test(k));
            } catch {
                return false;
            }
        });

        for (const m of matches ?? []) {
            const keys = Object.keys(m).filter(k => /upload|attach|file|size|limit/i.test(k));
            if (keys.length) seen.add(keys.sort().join(","));
            if (seen.size >= 25) break;
        }

        out.push(`upload-ish modules (${seen.size}):`);
        for (const k of seen) out.push(`  ${k}`);
    } catch (err: any) {
        out.push(`sweep failed: ${err?.message ?? err}`);
    }

    const FM: any =
        ReactNative.NativeModules.DCDFileManager ??
        ReactNative.NativeModules.RNFileManager ??
        ReactNative.NativeModules.FileManager;
    out.push(`FileManager: ${FM ? Object.keys(FM).join(", ") : "(not found)"}`);

    const text = out.join("\n");
    clipboard.setString(text);
    showToast(`Diagnostics copied (${text.length} chars)`);
}

export default function Settings() {
    useProxy(storage);

    return (
        <ScrollView>
            <FormSection title="Diagnostics" titleStyleType="no_border">
                <FormRow
                    label="Copy diagnostics to clipboard"
                    subLabel="Lists what the plugin can see in Discord's module registry — paste it wherever you're getting help"
                    onPress={copyDiagnostics}
                />
            </FormSection>

            <FormSection title="Host">
                {HOST_LIST.map((host, i) => (
                    <React.Fragment key={host.key}>
                        <FormRadioRow
                            label={host.name}
                            subLabel={host.note}
                            selected={storage.host === host.key}
                            onPress={() => (storage.host = host.key)}
                        />
                        {i < HOST_LIST.length - 1 && <FormDivider />}
                    </React.Fragment>
                ))}
            </FormSection>

            {storage.host === "litterbox" && (
                <FormSection title="Litterbox retention">
                    {LITTERBOX_TIMES.map((time, i) => (
                        <React.Fragment key={time}>
                            <FormRadioRow
                                label={time}
                                selected={storage.litterboxTime === time}
                                onPress={() => (storage.litterboxTime = time)}
                            />
                            {i < LITTERBOX_TIMES.length - 1 && <FormDivider />}
                        </React.Fragment>
                    ))}
                </FormSection>
            )}

            <FormSection title="Previews">
                <FormSwitchRow
                    label="Use a preview-friendly host for media"
                    subLabel="Sends images and videos via Catbox even if another host is selected, so they play inline instead of showing a bare link"
                    value={storage.preferEmbedHost}
                    onValueChange={(v: boolean) => (storage.preferEmbedHost = v)}
                />
                <FormDivider />
                <FormSwitchRow
                    label="Resize oversized photos to fit"
                    subLabel={
                        canShrink
                            ? "Downscales a photo until it fits the real limit, so it uploads as a genuine attachment instead of a link. Costs image quality."
                            : "Unavailable on this Discord build"
                    }
                    value={storage.shrinkImages && canShrink}
                    onValueChange={(v: boolean) => (storage.shrinkImages = v && canShrink)}
                />
            </FormSection>

            <FormSection title="Behaviour">
                <FormInput
                    title="Offload files larger than (MiB)"
                    value={String(storage.limitMiB)}
                    keyboardType="numeric"
                    onChange={(v: string) => {
                        const n = parseInt(v.replace(/\D/g, ""), 10);
                        storage.limitMiB = Number.isFinite(n) && n > 0 ? n : 10;
                    }}
                />
                <FormDivider />
                <FormSwitchRow
                    label="Send link automatically"
                    subLabel="Off: copy the link to your clipboard instead"
                    value={storage.autoSend}
                    onValueChange={(v: boolean) => (storage.autoSend = v)}
                />
                <FormDivider />
                <FormSwitchRow
                    label="Wrap link in spoiler"
                    subLabel="Hides the link behind a tap — but a spoilered link never previews, so nobody sees the media inline"
                    value={storage.spoiler}
                    onValueChange={(v: boolean) => (storage.spoiler = v)}
                />
                <FormDivider />
                <FormSwitchRow
                    label="Lift client-side size check"
                    subLabel="Needed so the file picker lets oversized files through"
                    value={storage.raiseClientLimit}
                    onValueChange={(v: boolean) => (storage.raiseClientLimit = v)}
                />
            </FormSection>

            <FormSection title="Note">
                <FormRow
                    label="Files go to a third-party host"
                    subLabel="Anyone with the link can open it and nothing is encrypted. Offloaded files are not real Discord attachments: jpg, png, gif, webp, mp4 and webm normally preview inline, but .mov and .heic will show as a plain link."
                />
            </FormSection>
        </ScrollView>
    );
}
