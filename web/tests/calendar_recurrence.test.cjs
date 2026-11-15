"use strict";

const assert = require("node:assert/strict");

const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const {initialize_user_settings} = zrequire("user_settings");

initialize_user_settings({user_settings: {default_language: "en"}});

const calendar_recurrence = zrequire("calendar_recurrence");

const MOSCOW = "Europe/Moscow";
// Thursday.
const DATE = "2026-11-12";

run_test("parse_rrule and format_rrule", () => {
    const rrule = "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20270506T205959Z";
    const recurrence = calendar_recurrence.parse_rrule(rrule, MOSCOW);
    assert.deepEqual(recurrence, {
        frequency: "WEEKLY",
        interval: 2,
        weekdays: ["MO", "WE"],
        until: "2027-05-06",
    });
    assert.equal(calendar_recurrence.format_rrule(recurrence, MOSCOW), rrule);

    // The last day is that of the event's timezone.
    assert.equal(
        calendar_recurrence.parse_rrule("FREQ=DAILY;UNTIL=20270506T205959Z", "America/New_York")
            .until,
        "2027-05-06",
    );
    assert.equal(
        calendar_recurrence.parse_rrule("FREQ=DAILY;UNTIL=20270506T205959Z", "Asia/Tokyo").until,
        "2027-05-07",
    );

    // Weekdays are in the order of the week.
    assert.deepEqual(calendar_recurrence.parse_rrule("FREQ=WEEKLY;BYDAY=WE,MO", MOSCOW), {
        frequency: "WEEKLY",
        interval: 1,
        weekdays: ["MO", "WE"],
        until: undefined,
    });
    assert.equal(
        calendar_recurrence.format_rrule(
            {frequency: "MONTHLY", interval: 1, weekdays: ["MO"], until: undefined},
            MOSCOW,
        ),
        "FREQ=MONTHLY",
    );
    assert.equal(
        calendar_recurrence.format_rrule(
            {frequency: "WEEKLY", interval: 1, weekdays: [], until: undefined},
            MOSCOW,
        ),
        "FREQ=WEEKLY",
    );

    for (const unsupported of [
        "",
        "FREQ",
        "FREQ=HOURLY",
        "FREQ=DAILY;INTERVAL=0",
        "FREQ=DAILY;INTERVAL=100",
        "FREQ=DAILY;INTERVAL=1.5",
        "FREQ=WEEKLY;BYDAY=XX",
        "FREQ=DAILY;UNTIL=20270506",
    ]) {
        assert.equal(calendar_recurrence.parse_rrule(unsupported, MOSCOW), undefined, unsupported);
    }
});

run_test("get_weekday and get_default_recurrence", () => {
    assert.equal(calendar_recurrence.get_weekday(DATE), "TH");
    assert.equal(calendar_recurrence.get_weekday("2026-11-15"), "SU");
    assert.deepEqual(calendar_recurrence.get_default_recurrence(DATE), {
        frequency: "WEEKLY",
        interval: 1,
        weekdays: ["TH"],
        until: undefined,
    });
});

run_test("get_first_date", () => {
    const weekly = {frequency: "WEEKLY", interval: 1, weekdays: ["MO", "WE"], until: undefined};
    assert.equal(calendar_recurrence.get_first_date(weekly, DATE), "2026-11-16");
    assert.equal(calendar_recurrence.get_first_date(weekly, "2026-11-11"), "2026-11-11");
    assert.equal(
        calendar_recurrence.get_first_date({...weekly, weekdays: []}, DATE),
        DATE,
    );
    assert.equal(calendar_recurrence.get_first_date({...weekly, frequency: "DAILY"}, DATE), DATE);
});

run_test("get_occurrence_dates", () => {
    const dates = (recurrence, date, max_count = 4, max_days = 62) =>
        calendar_recurrence.get_occurrence_dates(
            {interval: 1, weekdays: [], until: undefined, ...recurrence},
            date,
            max_count,
            max_days,
        );
    assert.deepEqual(dates({frequency: "DAILY", interval: 3}, DATE), [
        "2026-11-12",
        "2026-11-15",
        "2026-11-18",
        "2026-11-21",
    ]);
    // A weekly series starts on its first weekday.
    assert.deepEqual(dates({frequency: "WEEKLY", interval: 2, weekdays: ["MO", "TH"]}, "2026-11-13"), [
        "2026-11-16",
        "2026-11-19",
        "2026-11-30",
        "2026-12-03",
    ]);
    assert.deepEqual(dates({frequency: "WEEKLY"}, DATE, 2), ["2026-11-12", "2026-11-19"]);
    // Months without the 31st are skipped.
    assert.deepEqual(dates({frequency: "MONTHLY"}, "2027-01-31", 3, 366), [
        "2027-01-31",
        "2027-03-31",
        "2027-05-31",
    ]);
    assert.deepEqual(dates({frequency: "YEARLY"}, "2028-02-29", 2, 3000), [
        "2028-02-29",
        "2032-02-29",
    ]);
    // The series ends on its last day, or the dates within max_days.
    assert.deepEqual(dates({frequency: "DAILY", until: "2026-11-13"}, DATE), [
        "2026-11-12",
        "2026-11-13",
    ]);
    assert.deepEqual(dates({frequency: "DAILY"}, DATE, 10, 2), ["2026-11-12", "2026-11-13"]);
});

run_test("describe_pattern", () => {
    const describe = (frequency, interval, weekdays = []) =>
        calendar_recurrence.describe_pattern(
            {frequency, interval, weekdays, until: undefined},
            DATE,
        );
    assert.equal(describe("DAILY", 1), "translated: every day");
    assert.equal(describe("DAILY", 3), "translated: every 3 days");
    assert.equal(describe("WEEKLY", 1, ["TH"]), "translated: every Thursday");
    assert.equal(describe("WEEKLY", 1), "translated: every Thursday");
    assert.equal(describe("WEEKLY", 1, ["MO", "WE"]), "translated: every week on Mon and Wed");
    assert.equal(describe("WEEKLY", 2, ["TH"]), "translated: every 2 weeks on Thu");
    assert.equal(describe("MONTHLY", 1), "translated: every month on day 12");
    assert.equal(describe("MONTHLY", 3), "translated: every 3 months on day 12");
    assert.equal(describe("YEARLY", 1), "translated: every year on November 12");
    assert.equal(describe("YEARLY", 2), "translated: every 2 years on November 12");
});

run_test("describe", () => {
    const weekly = {frequency: "WEEKLY", interval: 1, weekdays: ["TH"], until: undefined};
    const time_range = {start: "10:00 AM", end: "10:30 AM"};
    assert.equal(
        calendar_recurrence.describe(weekly, DATE, time_range),
        "translated: Repeats translated: every Thursday, from 10:00 AM to 10:30 AM, starting Thu 11/12/2026",
    );
    assert.equal(
        calendar_recurrence.describe(weekly, DATE, undefined),
        "translated: Repeats translated: every Thursday, starting Thu 11/12/2026",
    );
    const until = {...weekly, until: "2027-05-06"};
    assert.equal(
        calendar_recurrence.describe(until, DATE, time_range),
        "translated: Repeats translated: every Thursday, from 10:00 AM to 10:30 AM, from Thu 11/12/2026 until Thu 05/06/2027",
    );
    assert.equal(
        calendar_recurrence.describe(until, DATE, undefined),
        "translated: Repeats translated: every Thursday, from Thu 11/12/2026 until Thu 05/06/2027",
    );
    // A weekly series starts on its first weekday.
    assert.equal(
        calendar_recurrence.describe({...weekly, weekdays: ["MO"]}, DATE, undefined),
        "translated: Repeats translated: every Monday, starting Mon 11/16/2026",
    );
});
