export type NotificationData = {
    title: string;
    dir: NotificationDirection;
    lang: string;
    body: string;
    tag: string;
    icon: string;
    data: unknown;
    close: () => void;
};

export type ClipboardDecrypter = {
    version: number;
    key: Uint8Array;
    pasted: Promise<string>;
};

export type ElectronBridge = {
    send_event: (eventName: string | symbol, ...args: unknown[]) => boolean;
    on_event: ((
        eventName:
            | "logout"
            | "screen_share_change_source"
            | "screen_share_stop"
            | "show-keyboard-shortcuts"
            | "show-notification-settings",
        listener: () => void,
    ) => void) &
        ((
            eventName: "send_notification_reply_message",
            listener: (message_id: number, reply: string) => void,
        ) => void) &
        ((eventName: "remote_control_state", listener: (state: unknown) => void) => void);
    new_notification?: (
        title: string,
        options: NotificationOptions,
        dispatch: (type: string, eventInit: EventInit) => boolean,
    ) => NotificationData;
    get_idle_on_system?: () => boolean;
    get_last_active_on_system?: () => number;
    get_send_notification_reply_message_supported?: () => boolean;
    set_send_notification_reply_message_supported?: (value: boolean) => void;
    decrypt_clipboard?: (version: number) => ClipboardDecrypter;
    get_remote_control_supported?: () => boolean;
    send_remote_control_input?: (identity: string, message: unknown) => void;
    request_remote_control?: (identity: string, name: string) => void;
    stop_remote_control?: () => void;
    remote_control_participant_left?: (identity: string) => void;
    get_screen_share_source_kind?: () => "screen" | "window" | null;
    screen_share_stopped?: () => void;
};

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        electron_bridge?: ElectronBridge | Element;
    }
}

// Check for Element for extra defense against DOM clobbering attacks
export const electron_bridge: ElectronBridge | undefined =
    window.electron_bridge instanceof Element ? undefined : window.electron_bridge;
