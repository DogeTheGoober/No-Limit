import { React, ReactNative, clipboard } from "@vendetta/metro/common";
import { showToast } from "@vendetta/ui/toasts";
import { findByProps } from "@vendetta/metro";
import { useProxy } from "@vendetta/storage";
import { storage } from "@vendetta/plugin";
import { Forms } from "@vendetta/ui/components";

import { HOST_LIST, LITTERBOX_TIMES } from "./hosts";
import { canShrink } from "./shrink";

const { FormSection, FormRow, FormSwitchRow, FormRadioRow, FormInput, FormDivider } = Forms;

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
            hit = !!findByPro
