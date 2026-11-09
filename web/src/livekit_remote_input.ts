import assert from "minimalistic-assert";
import * as z from "zod/mini";

const position = {
    x: z.number().check(z.minimum(0), z.maximum(1)),
    y: z.number().check(z.minimum(0), z.maximum(1)),
};

export const mouse_event_schema = z.discriminatedUnion("type", [
    z.object({type: z.literal("move"), ...position}),
    z.object({
        type: z.literal("button"),
        ...position,
        button: z.enum(["left", "middle", "right"]),
        down: z.boolean(),
    }),
    z.object({
        type: z.literal("wheel"),
        ...position,
        dx: z.int().check(z.minimum(-12_000), z.maximum(12_000)),
        dy: z.int().check(z.minimum(-12_000), z.maximum(12_000)),
    }),
]);
export type MouseEvent = z.infer<typeof mouse_event_schema>;
// A physical key, by its KeyboardEvent.code.
export type KeyEvent = {type: "key"; code: string; down: boolean};
type Position = {x: number; y: number};

export function video_position(
    point: {clientX: number; clientY: number},
    rect: {left: number; top: number; width: number; height: number},
    video_width: number,
    video_height: number,
): Position | undefined {
    if (video_width <= 0 || video_height <= 0 || rect.width <= 0 || rect.height <= 0) {
        return undefined;
    }
    const scale = Math.min(rect.width / video_width, rect.height / video_height);
    const width = video_width * scale;
    const height = video_height * scale;
    const x = (point.clientX - rect.left - (rect.width - width) / 2) / width;
    const y = (point.clientY - rect.top - (rect.height - height) / 2) / height;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return undefined;
    }
    return {x, y};
}

export function wheel_pixels(delta: number, mode: number, page_size: number): number {
    return delta * (mode === 1 ? 40 : mode === 2 ? page_size : 1);
}

function bounded_wheel_delta(pixels: number): number {
    return Math.round(Math.max(-12_000, Math.min(12_000, pixels)));
}

// One mouse and keyboard sender per remote video. Moves and scrolling
// are sent at most 60 times a second: only the latest pending move is
// sent, and scrolling is summed until then. Button transitions,
// scrolling, and keys use the reliable channel. Keys go to the shared
// screen while the video has the focus, which clicking it gives.
export class RemoteInput {
    private readonly video: HTMLVideoElement;
    private readonly send: (
        token: string,
        sequence: number,
        event: MouseEvent | KeyEvent,
    ) => Promise<void>;
    private readonly on_keyboard_change: () => void;
    private readonly listeners = new AbortController();
    private token: string | undefined;
    private sequence = 0;
    private pending_position: Position | undefined;
    // Where the latest scrolling happened, and its sum in CSS pixels.
    private pending_wheel: (Position & {dx: number; dy: number}) | undefined;
    private last_position: Position | undefined;
    private flush_timer: ReturnType<typeof setTimeout> | undefined;
    private move_in_flight = false;
    private readonly pressed_buttons = new Set<"left" | "middle" | "right">();
    private readonly pressed_keys = new Set<string>();
    private focused = false;

    constructor(video: HTMLVideoElement, send: RemoteInput["send"], on_keyboard_change: () => void) {
        this.video = video;
        this.send = send;
        this.on_keyboard_change = on_keyboard_change;
        const options = {signal: this.listeners.signal};
        video.tabIndex = -1;
        video.addEventListener(
            "pointermove",
            (event) => {
                if (this.token === undefined || event.pointerType !== "mouse") {
                    return;
                }
                const point = this.position(event);
                if (point === undefined) {
                    this.release_buttons();
                    return;
                }
                this.last_position = point;
                this.pending_position = point;
                this.schedule_flush();
            },
            options,
        );
        video.addEventListener(
            "pointerdown",
            (event) => {
                const button = this.button(event.button);
                const point = this.position(event);
                if (
                    this.token === undefined ||
                    event.pointerType !== "mouse" ||
                    button === undefined ||
                    point === undefined
                ) {
                    return;
                }
                event.preventDefault();
                video.focus({preventScroll: true});
                video.setPointerCapture(event.pointerId);
                this.pressed_buttons.add(button);
                this.last_position = point;
                this.pending_position = undefined;
                this.publish({type: "button", ...point, button, down: true});
            },
            options,
        );
        video.addEventListener(
            "pointerup",
            (event) => {
                const button = this.button(event.button);
                if (button === undefined || !this.pressed_buttons.delete(button)) {
                    return;
                }
                event.preventDefault();
                const point = this.position(event) ?? this.last_position;
                if (point !== undefined) {
                    this.pending_position = undefined;
                    this.publish({type: "button", ...point, button, down: false});
                }
            },
            options,
        );
        for (const event of ["lostpointercapture", "pointercancel", "pointerleave"]) {
            video.addEventListener(event, () => this.release_buttons(), options);
        }
        for (const event of ["contextmenu", "dragstart"]) {
            video.addEventListener(
                event,
                (event) => {
                    if (this.token !== undefined) {
                        event.preventDefault();
                    }
                },
                options,
            );
        }
        video.addEventListener(
            "wheel",
            (event) => {
                const point = this.position(event);
                if (this.token === undefined || point === undefined) {
                    return;
                }
                event.preventDefault();
                this.pending_position = undefined;
                this.last_position = point;
                this.pending_wheel = {
                    ...point,
                    dx:
                        (this.pending_wheel?.dx ?? 0) +
                        wheel_pixels(event.deltaX, event.deltaMode, video.clientWidth),
                    dy:
                        (this.pending_wheel?.dy ?? 0) +
                        wheel_pixels(event.deltaY, event.deltaMode, video.clientHeight),
                };
                this.schedule_flush();
            },
            {...options, passive: false},
        );
        for (const type of ["keydown", "keyup"] as const) {
            video.addEventListener(
                type,
                (event) => {
                    // The Windows keys stay with the controller's computer.
                    if (
                        this.token === undefined ||
                        event.code === "" ||
                        event.code.startsWith("Meta")
                    ) {
                        return;
                    }
                    event.preventDefault();
                    const down = type === "keydown";
                    if (down) {
                        this.pressed_keys.add(event.code);
                    } else if (!this.pressed_keys.delete(event.code)) {
                        // Pressed before the keyboard went to the shared screen.
                        return;
                    }
                    this.publish({type: "key", code: event.code, down});
                },
                options,
            );
        }
        video.addEventListener(
            "focus",
            () => {
                this.focused = true;
                this.on_keyboard_change();
            },
            options,
        );
        video.addEventListener(
            "blur",
            () => {
                this.focused = false;
                this.release_keys();
                this.on_keyboard_change();
            },
            options,
        );
        window.addEventListener("blur", () => this.release_all(), options);
        document.addEventListener(
            "visibilitychange",
            () => {
                if (document.hidden) {
                    this.release_all();
                }
            },
            options,
        );
    }

    get keyboard_active(): boolean {
        return this.token !== undefined && this.focused;
    }

    private button(button: number): "left" | "middle" | "right" | undefined {
        return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : undefined;
    }

    private position(event: {clientX: number; clientY: number}): Position | undefined {
        return video_position(
            event,
            this.video.getBoundingClientRect(),
            this.video.videoWidth,
            this.video.videoHeight,
        );
    }

    private publish(event: MouseEvent | KeyEvent): void {
        assert(this.token !== undefined);
        if (event.type === "button" || event.type === "key") {
            // Scrolling before a click or key must reach the screen before it.
            this.publish_pending_wheel();
        }
        this.sequence += 1;
        const token = this.token;
        void this.send(token, this.sequence, event).catch(() => {
            if (this.token === token) {
                this.set_token(undefined);
            }
        });
    }

    private publish_pending_wheel(): void {
        if (this.pending_wheel === undefined) {
            return;
        }
        const {x, y, dx, dy} = this.pending_wheel;
        this.pending_wheel = undefined;
        this.publish({
            type: "wheel",
            x,
            y,
            dx: bounded_wheel_delta(dx),
            dy: bounded_wheel_delta(dy),
        });
    }

    private schedule_flush(): void {
        this.flush_timer ??= setTimeout(() => {
            this.flush_timer = undefined;
            this.flush();
        }, 1000 / 60);
    }

    // Sends at most one event per turn, so that moving while scrolling
    // stays within the input rate the desktop app accepts: pending
    // scrolling, which carries its own position, before the latest move.
    private flush(): void {
        assert(this.token !== undefined);
        if (this.pending_wheel !== undefined) {
            this.publish_pending_wheel();
            if (this.pending_position !== undefined) {
                this.schedule_flush();
            }
            return;
        }
        const point = this.pending_position;
        if (point === undefined || this.move_in_flight) {
            return;
        }
        this.pending_position = undefined;
        this.sequence += 1;
        this.move_in_flight = true;
        void this.send(this.token, this.sequence, {type: "move", ...point})
            // A later move replaces a lost position.
            .catch(() => undefined)
            .finally(() => {
                this.move_in_flight = false;
                if (this.pending_position !== undefined) {
                    this.schedule_flush();
                }
            });
    }

    private release_buttons(): void {
        this.pending_position = undefined;
        if (this.last_position !== undefined) {
            for (const button of this.pressed_buttons) {
                this.publish({type: "button", ...this.last_position, button, down: false});
            }
        }
        this.pressed_buttons.clear();
    }

    private release_keys(): void {
        for (const code of this.pressed_keys) {
            this.publish({type: "key", code, down: false});
        }
        this.pressed_keys.clear();
    }

    private release_all(): void {
        this.release_buttons();
        this.release_keys();
    }

    set_token(token: string | undefined): void {
        if (this.token === token) {
            return;
        }
        this.release_all();
        clearTimeout(this.flush_timer);
        this.flush_timer = undefined;
        this.pending_wheel = undefined;
        this.token = token;
        this.sequence = 0;
        this.on_keyboard_change();
    }

    destroy(): void {
        this.set_token(undefined);
        this.listeners.abort();
    }
}
