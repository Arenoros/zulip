"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const calendar_layout = zrequire("calendar_layout");

const MOSCOW = "Europe/Moscow";
const WORK_WEEK = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];

// A time in Moscow, which is UTC+3 all year, in seconds.
function moscow(day, hour, minute = 0) {
    return Date.UTC(2026, 10, day, hour - 3, minute) / 1000;
}

function timed(title, start, end) {
    return {title, start, end, is_all_day: false, timezone: MOSCOW};
}

function summary(placement) {
    return [
        placement.event.title,
        placement.start_minute,
        placement.end_minute,
        placement.column,
        placement.column_count,
    ];
}

run_test("overlapping events share the width of their day", () => {
    const layout = calendar_layout.get_week_layout(
        [
            timed("standup", moscow(9, 10), moscow(9, 11)),
            timed("review", moscow(9, 10, 30), moscow(9, 11, 30)),
            timed("lunch", moscow(9, 13), moscow(9, 14)),
            // Starts when the review ends, so it joins its group, and
            // takes the first column, which the standup freed.
            timed("sync", moscow(9, 11), moscow(9, 12)),
        ],
        WORK_WEEK,
        MOSCOW,
        0,
    );
    assert.deepEqual(layout.days[0].map(summary), [
        ["standup", 600, 660, 0, 2],
        ["review", 630, 690, 1, 2],
        ["sync", 660, 720, 0, 2],
        ["lunch", 780, 840, 0, 1],
    ]);
    assert.deepEqual(layout.days.slice(1), [[], [], [], []]);
    assert.deepEqual(layout.all_day, []);
    assert.equal(layout.all_day_lane_count, 0);
});

run_test("short events overlap what they are drawn over", () => {
    const events = [
        timed("call", moscow(10, 9), moscow(10, 9, 5)),
        timed("next", moscow(10, 9, 10), moscow(10, 9, 30)),
    ];
    const layout = calendar_layout.get_week_layout(events, WORK_WEEK, MOSCOW, 15);
    assert.deepEqual(layout.days[1].map(summary), [
        ["call", 540, 545, 0, 2],
        ["next", 550, 570, 1, 2],
    ]);
    const unpadded = calendar_layout.get_week_layout(events, WORK_WEEK, MOSCOW, 0);
    assert.deepEqual(unpadded.days[1].map(summary), [
        ["call", 540, 545, 0, 1],
        ["next", 550, 570, 0, 1],
    ]);
});

run_test("events over midnight show on both days", () => {
    const layout = calendar_layout.get_week_layout(
        [
            timed("release", moscow(11, 22), moscow(12, 2)),
            timed("until midnight", moscow(13, 23), moscow(14, 0)),
            timed("reminder", moscow(12, 9), moscow(12, 9)),
        ],
        WORK_WEEK,
        MOSCOW,
        0,
    );
    const ends = (placement) => [
        placement.event.title,
        placement.start_minute,
        placement.end_minute,
        placement.continues_before,
        placement.continues_after,
    ];
    assert.deepEqual(layout.days[2].map(ends), [["release", 1320, 1440, false, true]]);
    assert.deepEqual(layout.days[3].map(ends), [
        ["release", 0, 120, true, false],
        ["reminder", 540, 540, false, false],
    ]);
    assert.deepEqual(layout.days[4].map(ends), [["until midnight", 1380, 1440, false, false]]);
});

run_test("all-day events cover their dates everywhere", () => {
    // November 10 in Moscow, seen from New York, where it starts on
    // the evening of November 9.
    const holiday = {
        title: "holiday",
        start: moscow(10, 0),
        end: moscow(11, 0),
        is_all_day: true,
        timezone: MOSCOW,
    };
    const layout = calendar_layout.get_week_layout([holiday], WORK_WEEK, "America/New_York", 0);
    assert.deepEqual(
        layout.all_day.map((placement) => [placement.first_day, placement.last_day]),
        [[1, 1]],
    );
    assert.deepEqual(layout.days, [[], [], [], [], []]);
});

run_test("events of a day or more go in lanes above the hours", () => {
    const all_day = (title, first_day, end_day) => ({
        title,
        start: moscow(first_day, 0),
        end: moscow(end_day, 0),
        is_all_day: true,
        timezone: MOSCOW,
    });
    const layout = calendar_layout.get_week_layout(
        [
            all_day("tuesday", 10, 11),
            timed("trip", moscow(9, 10), moscow(11, 12)),
            all_day("thursday", 12, 13),
            // Before and after the shown days.
            all_day("weekend", 14, 16),
            all_day("last week", 2, 9),
            all_day("over the weekend", 13, 17),
        ],
        WORK_WEEK,
        MOSCOW,
        0,
    );
    assert.deepEqual(
        layout.all_day.map((placement) => [
            placement.event.title,
            placement.first_day,
            placement.last_day,
            placement.lane,
        ]),
        [
            ["trip", 0, 2, 0],
            ["tuesday", 1, 1, 1],
            ["thursday", 3, 3, 0],
            ["over the weekend", 4, 4, 0],
        ],
    );
    assert.equal(layout.all_day_lane_count, 2);
    assert.deepEqual(layout.days, [[], [], [], [], []]);
    assert.ok(calendar_layout.is_all_day_row_event(timed("day", moscow(9, 9), moscow(10, 9))));
    assert.ok(!calendar_layout.is_all_day_row_event(timed("night", moscow(9, 22), moscow(10, 6))));
});

run_test("the hours stay put when daylight saving time ends", () => {
    // October 25, 2026, when Berlin moves from UTC+2 to UTC+1.
    const berlin_sunday = ["2026-10-25"];
    const meeting = {
        title: "meeting",
        // 10:00 to 11:00 in Berlin.
        start: Date.UTC(2026, 9, 25, 9) / 1000,
        end: Date.UTC(2026, 9, 25, 10) / 1000,
        is_all_day: false,
        timezone: "Europe/Berlin",
    };
    const layout = calendar_layout.get_week_layout(
        [meeting],
        berlin_sunday,
        "Europe/Berlin",
        0,
    );
    assert.deepEqual(layout.days[0].map(summary), [["meeting", 600, 660, 0, 1]]);
});
