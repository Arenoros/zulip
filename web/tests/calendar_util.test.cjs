"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const calendar_util = zrequire("calendar_util");

// Saturday, November 14, 2026.
const today = new Date(2026, 10, 14);

run_test("parse_calendar_hash", () => {
    const parse = (hash) => calendar_util.parse_calendar_hash(hash, today, "workweek");

    assert.deepEqual(parse("#calendar"), {view: "workweek", week_start: "2026-11-09"});
    assert.deepEqual(parse("#calendar/"), {view: "workweek", week_start: "2026-11-09"});
    // Without a view, the calendar opens in the user's default view.
    assert.deepEqual(calendar_util.parse_calendar_hash("#calendar", today, "week"), {
        view: "week",
        week_start: "2026-11-09",
    });
    assert.deepEqual(parse("#calendar/week"), {view: "week", week_start: "2026-11-09"});
    assert.deepEqual(parse("#calendar/workweek/2026-11-09"), {
        view: "workweek",
        week_start: "2026-11-09",
    });
    // Any day picks the week that contains it, Sunday included.
    assert.deepEqual(parse("#calendar/week/2026-11-15"), {
        view: "week",
        week_start: "2026-11-09",
    });
    assert.deepEqual(parse("#calendar/week/2027-01-01"), {
        view: "week",
        week_start: "2026-12-28",
    });

    assert.equal(parse("#calendar/day/2026-11-09"), undefined);
    assert.equal(parse("#calendar/week/2026-02-30"), undefined);
    assert.equal(parse("#calendar/week/2026-1-9"), undefined);
    assert.equal(parse("#calendar/week/tomorrow"), undefined);
    assert.equal(parse("#calendar/week/2026-11-09/extra"), undefined);
    assert.equal(parse("#calendars"), undefined);
});

run_test("parse_calendar_event_hash", () => {
    assert.deepEqual(calendar_util.parse_calendar_event_hash("#calendar/event/12/1763276400"), {
        event_id: 12,
        start: 1763276400,
    });
    assert.equal(calendar_util.parse_calendar_event_hash("#calendar/event/12"), undefined);
    assert.equal(calendar_util.parse_calendar_event_hash("#calendar/event/x/1"), undefined);
    assert.equal(calendar_util.parse_calendar_event_hash("#calendar/week/2026-11-16"), undefined);
});

run_test("visibility", () => {
    assert.ok(!calendar_util.is_visible());
    calendar_util.set_visible(true);
    assert.ok(calendar_util.is_visible());
    calendar_util.set_visible(false);
    assert.ok(!calendar_util.is_visible());
});

run_test("is_calendar_hash", () => {
    assert.ok(calendar_util.is_calendar_hash("#calendar"));
    assert.ok(calendar_util.is_calendar_hash("#calendar/week/2026-11-09"));
    assert.ok(!calendar_util.is_calendar_hash("#calendars"));
    assert.ok(!calendar_util.is_calendar_hash("#inbox"));
    assert.ok(!calendar_util.is_calendar_hash(""));
    assert.ok(!calendar_util.is_calendar_hash(undefined));
});

run_test("calendar_hash", () => {
    assert.equal(
        calendar_util.calendar_hash({view: "week", week_start: "2026-11-09"}),
        "#calendar/week/2026-11-09",
    );
});

run_test("get_shown_days", () => {
    const days = (view, work_days = [1, 2, 3, 4, 5]) =>
        calendar_util
            .get_shown_days({view, week_start: "2026-11-09"}, work_days)
            .map((day) => calendar_util.format_date(day));

    assert.deepEqual(days("workweek"), [
        "2026-11-09",
        "2026-11-10",
        "2026-11-11",
        "2026-11-12",
        "2026-11-13",
    ]);
    // Work days that are not Monday to Friday.
    assert.deepEqual(days("workweek", [7, 1, 2, 3, 4]), [
        "2026-11-09",
        "2026-11-10",
        "2026-11-11",
        "2026-11-12",
        "2026-11-15",
    ]);
    assert.deepEqual(days("week", [1]), [
        "2026-11-09",
        "2026-11-10",
        "2026-11-11",
        "2026-11-12",
        "2026-11-13",
        "2026-11-14",
        "2026-11-15",
    ]);
});

run_test("get_month_weeks", () => {
    const weeks = (year, month) =>
        calendar_util
            .get_month_weeks(new Date(year, month, 1))
            .map((week) => calendar_util.format_date(week[0]));

    // November 2026 starts on a Sunday.
    assert.deepEqual(weeks(2026, 10), [
        "2026-10-26",
        "2026-11-02",
        "2026-11-09",
        "2026-11-16",
        "2026-11-23",
        "2026-11-30",
    ]);
    // February 2027 starts on a Monday and fits in four weeks, but
    // the small calendar still shows six.
    assert.deepEqual(weeks(2027, 1), [
        "2027-02-01",
        "2027-02-08",
        "2027-02-15",
        "2027-02-22",
        "2027-03-01",
        "2027-03-08",
    ]);
    for (const week of calendar_util.get_month_weeks(new Date(2026, 10, 1))) {
        assert.equal(week.length, 7);
    }
});

run_test("capitalize", () => {
    assert.equal(calendar_util.capitalize("пн", "ru"), "Пн");
    assert.equal(calendar_util.capitalize("Mon", "en"), "Mon");
    assert.equal(calendar_util.capitalize("", "en"), "");
});

run_test("snap_minutes", () => {
    assert.equal(calendar_util.snap_minutes(22, 15), 15);
    assert.equal(calendar_util.snap_minutes(23, 15), 30);
    assert.equal(calendar_util.snap_minutes(-8, 15), -15);
    assert.equal(calendar_util.snap_minutes(-7, 15), 0);
});
