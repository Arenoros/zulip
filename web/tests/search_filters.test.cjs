"use strict";

const assert = require("node:assert/strict");

const {mock_esm, zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");
const {$} = require("./lib/zjquery.cjs");
const {page_params} = require("./lib/zpage_params.cjs");

const channel = mock_esm("../src/channel");
const message_fetch = mock_esm("../src/message_fetch", {
    get_narrow_for_message_fetch: (filter) => JSON.stringify(filter.terms()),
});

const {Filter} = zrequire("filter");
const search_filters = zrequire("search_filters");

const search = {operator: "search", operand: "lunch", negated: false};
const is_dm = {operator: "is", operand: "dm", negated: false};
const not_dm = {operator: "is", operand: "dm", negated: true};
const starred = {operator: "is", operand: "starred", negated: false};

function count_text(kind) {
    return $(`.search-filter[data-search-filter="${kind}"] .search-filter-count`).text();
}

run_test("has_search_filters", () => {
    page_params.is_spectator = false;
    const has_search_filters = (terms) => search_filters.has_search_filters(new Filter(terms));

    assert.ok(has_search_filters([search]));
    assert.ok(has_search_filters([search, is_dm]));
    assert.ok(has_search_filters([search, not_dm]));
    assert.ok(has_search_filters([search, starred]));
    assert.ok(has_search_filters([search, {operator: "sender", operand: 5}]));

    // Not a search.
    assert.ok(!has_search_filters([starred]));
    assert.ok(!has_search_filters([is_dm]));

    // Searches already limited to channels or to direct messages.
    assert.ok(!has_search_filters([search, {operator: "channel", operand: "1"}]));
    assert.ok(!has_search_filters([search, {operator: "channels", operand: "public"}]));
    assert.ok(!has_search_filters([search, {operator: "topic", operand: "lunch"}]));
    assert.ok(!has_search_filters([search, {operator: "dm-including", operand: [5]}]));
    assert.ok(!has_search_filters([search, {operator: "dm", operand: [5]}]));

    page_params.is_spectator = true;
    assert.ok(!has_search_filters([search]));
    page_params.is_spectator = false;
});

run_test("active_kind and terms_for_kind", () => {
    for (const [terms, kind] of [
        [[search], "all"],
        [[search, is_dm], "direct"],
        [[not_dm, search], "channels"],
    ]) {
        const filter = new Filter(terms);
        assert.equal(search_filters.active_kind(filter), kind);
        assert.deepEqual(search_filters.terms_for_kind(filter, "all"), [search]);
        assert.deepEqual(search_filters.terms_for_kind(filter, "direct"), [search, is_dm]);
        assert.deepEqual(search_filters.terms_for_kind(filter, "channels"), [search, not_dm]);
    }
});

run_test("count_label", () => {
    assert.equal(search_filters.count_label(0, false), "0");
    assert.equal(search_filters.count_label(12, false), "12");
    assert.equal(search_filters.count_label(1000, true), "1000+");
});

run_test("handle_narrow_activated", ({mock_template, override}) => {
    let rendered;
    mock_template("search_filters.hbs", false, (data) => {
        rendered = data;
        // The rendered filters have no counts yet.
        for (const {kind} of data.search_filters) {
            $(`.search-filter[data-search-filter="${kind}"] .search-filter-count`).text("");
        }
        return "<search-filters-stub>";
    });
    const requests = [];
    override(channel, "get", (opts) => {
        requests.push(opts);
    });
    const $container = $("#search-filters-container");
    const $filters = $.create(".search-filter-stub");
    $container.set_find_results(".search-filter", $filters);

    const filter = new Filter([search, is_dm]);
    search_filters.handle_narrow_activated(filter);
    assert.deepEqual(rendered.search_filters, [
        {kind: "all", label: "translated: All", url: "#narrow/search/lunch", is_active: false},
        {
            kind: "direct",
            label: "translated: Direct and group messages",
            url: "#narrow/search/lunch/is/dm",
            is_active: true,
        },
        {
            kind: "channels",
            label: "translated: Channels",
            url: "#narrow/search/lunch/-is/dm",
            is_active: false,
        },
    ]);
    assert.equal($container.html(), "<search-filters-stub>");

    // A focused filter scrolls into view.
    const focus_handler = $filters.get_on_handler("focus");
    let scrolled_into_view_with;
    focus_handler({
        currentTarget: {
            scrollIntoView(options) {
                scrolled_into_view_with = options;
            },
        },
    });
    assert.deepEqual(scrolled_into_view_with, {block: "nearest", inline: "nearest"});

    // The three counts are requested at once, each for its filter.
    assert.deepEqual(
        requests.map((request) => [request.url, request.data.narrow]),
        [
            ["/json/messages/count", JSON.stringify([search])],
            ["/json/messages/count", JSON.stringify([search, is_dm])],
            ["/json/messages/count", JSON.stringify([search, not_dm])],
        ],
    );
    const [all_request, direct_request, channels_request] = requests;
    all_request.success({result: "success", msg: "", count: 1000, count_is_limited: true});
    direct_request.success({result: "success", msg: "", count: 12, count_is_limited: false});
    assert.equal(count_text("all"), "1000+");
    assert.equal(count_text("direct"), "12");
    assert.equal(count_text("channels"), "");

    // New matching messages update the counts, and counts requested
    // before them are dropped.
    requests.length = 0;
    search_filters.update_counts();
    assert.equal(requests.length, 3);
    channels_request.success({result: "success", msg: "", count: 4, count_is_limited: false});
    assert.equal(count_text("channels"), "");
    requests[1].success({result: "success", msg: "", count: 13, count_is_limited: false});
    assert.equal(count_text("direct"), "13");

    // Counts for an earlier search don't reach a later one.
    const stale_requests = [...requests];
    requests.length = 0;
    // Rendering the filters again makes new elements.
    $container.set_find_results(".search-filter", $.create(".search-filter-stub-rerendered"));
    search_filters.handle_narrow_activated(new Filter([search, not_dm]));
    assert.equal(rendered.search_filters[2].is_active, true);
    stale_requests[2].success({result: "success", msg: "", count: 99, count_is_limited: false});
    assert.equal(count_text("channels"), "");
    requests[2].success({result: "success", msg: "", count: 7, count_is_limited: false});
    assert.equal(count_text("channels"), "7");

    // Views other than searches have no filters, and no counts to
    // update.
    requests.length = 0;
    search_filters.handle_narrow_activated(new Filter([starred]));
    assert.equal($container.html(), "");
    search_filters.update_counts();
    assert.equal(requests.length, 0);
});
