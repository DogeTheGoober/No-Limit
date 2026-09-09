import { React, ReactNative } from "@vendetta/metro/common";
import { useProxy } from "@vendetta/storage";
import { storage } from "@vendetta/plugin";
import { Forms } from "@vendetta/ui/components";

import { HOST_LIST, LITTERBOX_TIMES } from "./hosts";

const { FormSection, FormRow, FormSwitchRow, FormRadioRow, FormInput, FormDivider } = Forms;
const { ScrollView } = ReactNative;

export default function Settings() {
    useProxy(storage);

    return (
        <ScrollView>
            <FormSection title="Host" titleStyleType="no_border">
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
                    subLabel="Anyone with the link can open it. Nothing is encrypted, and the file is not a real Discord attachment — no inline preview for video."
                />
            </FormSection>
        </ScrollView>
    );
}
