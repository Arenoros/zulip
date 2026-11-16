import {$} from "jquery";
import * as z from "zod/mini";

import render_search_filters from "../templates/search_filters.hbs";

import * as channel from "./channel.ts";
import {Filter} from "./filter.ts";
import * as hash_util from "./hash_util.ts";
import {$t} from "./i18n.ts";
import * as message_fetch from "./message_fetch.ts";
import {page_params} from "./page_params.ts";
import type {NarrowCanonicalTerm} from "./state_data.ts";

type SearchFilterKind = "all" | "direct" | "channels";

const SEARCH_FILTER_KINDS: SearchFilterKind[] = ["all", "direct", "channels"];

const message_count_response_schema = z.object({
    count: z.number(),
    count_is_limited: z.boolean(),
});

// The search whose filters are shown.
let shown_filter: Filter | undefined;

// Counts that arrive after newer counts were requested, for this search
// or an earlier one, are dropped.
let latest_counts_request = 0;

function is_dm_term(term: NarrowCanonicalTerm): boolean {
    return term.operator === "is" && term.operand === "dm";
}

function terms_without_filter(filter: Filter): NarrowCanonicalTerm[] {
    return filter.terms().filter((term) => !is_dm_term(term));
}

export function terms_for_kind(filter: Filter, kind: SearchFilterKind): NarrowCanonicalTerm[] {
    const terms = terms_without_filter(filter);
    switch (kind) {
        case "all":
            return terms;
        case "direct":
            return [...terms, {operator: "is", operand: "dm", negated: false}];
        default:
            kind satisfies "channels";
            return [...terms, {operator: "is", operand: "dm", negated: true}];
    }
}

export function active_kind(filter: Filter): SearchFilterKind {
    if (filter.has_operand("is", "dm")) {
        return "direct";
    }
    if (filter.has_negated_operand("is", "dm")) {
        return "channels";
    }
    return "all";
}

export function has_search_filters(filter: Filter): boolean {
    // Searches already limited to channels or to direct messages
    // have nothing to filter.
    const unfiltered = new Filter(terms_without_filter(filter));
    return (
        !page_params.is_spectator &&
        unfiltered.is_keyword_search() &&
        !unfiltered.contains_only_private_messages() &&
        !unfiltered.includes_full_stream_history() &&
        !unfiltered.has_operator("topic")
    );
}

export function count_label(count: number, count_is_limited: boolean): string {
    return count_is_limited ? `${count}+` : `${count}`;
}

function kind_label(kind: SearchFilterKind): string {
    switch (kind) {
        case "all":
            return $t({defaultMessage: "All"});
        case "direct":
            return $t({defaultMessage: "Direct and group messages"});
        default:
            kind satisfies "channels";
            return $t({defaultMessage: "Channels"});
    }
}

export function update_counts(): void {
    const filter = shown_filter;
    if (filter === undefined) {
        return;
    }
    latest_counts_request += 1;
    for (const kind of SEARCH_FILTER_KINDS) {
        update_count(filter, kind, latest_counts_request);
    }
}

function update_count(filter: Filter, kind: SearchFilterKind, counts_request: number): void {
    const kind_filter = new Filter(terms_for_kind(filter, kind));
    void channel.get({
        url: "/json/messages/count",
        data: {narrow: message_fetch.get_narrow_for_message_fetch(kind_filter)},
        success(raw_data) {
            if (counts_request !== latest_counts_request) {
                return;
            }
            const data = message_count_response_schema.parse(raw_data);
            $(`.search-filter[data-search-filter="${kind}"] .search-filter-count`).text(
                count_label(data.count, data.count_is_limited),
            );
        },
    });
}

export function handle_narrow_activated(filter: Filter): void {
    const $container = $("#search-filters-container");
    if (!has_search_filters(filter)) {
        shown_filter = undefined;
        $container.empty();
        return;
    }
    shown_filter = filter;
    const current_kind = active_kind(filter);
    $container.html(
        render_search_filters({
            search_filters: SEARCH_FILTER_KINDS.map((kind) => ({
                kind,
                label: kind_label(kind),
                url: hash_util.search_terms_to_hash(terms_for_kind(filter, kind)),
                is_active: kind === current_kind,
            })),
        }),
    );
    // In a narrow window, the filters scroll sideways, and browsers
    // don't scroll a partly visible filter into view when it gets focus.
    $container.find(".search-filter").on("focus", (event) => {
        event.currentTarget.scrollIntoView({block: "nearest", inline: "nearest"});
    });
    update_counts();
}
