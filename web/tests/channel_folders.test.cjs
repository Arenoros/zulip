"use strict";

const assert = require("node:assert/strict");

const {make_user_group} = require("./lib/example_group.cjs");
const {make_realm} = require("./lib/example_realm.cjs");
const {make_stream} = require("./lib/example_stream.cjs");
const {zrequire} = require("./lib/namespace.cjs");
const {run_test} = require("./lib/test.cjs");

const channel_folders = zrequire("channel_folders");
const {set_current_user, set_realm} = zrequire("state_data");
const stream_data = zrequire("stream_data");
const user_groups = zrequire("user_groups");

const current_user = {};
set_current_user(current_user);
set_realm(make_realm());

run_test("basics", () => {
    const params = {};
    const frontend_folder = {
        name: "Frontend",
        description: "Channels for frontend discussions",
        rendered_description: "<p>Channels for frontend discussions</p>",
        creator_id: null,
        date_created: 1596710000,
        id: 1,
        is_archived: false,
        order: 0,
    };
    const backend_folder = {
        name: "Backend",
        description: "Channels for backend discussions",
        rendered_description: "<p>Channels for backend discussions</p>",
        creator_id: null,
        date_created: 1596720000,
        id: 2,
        is_archived: false,
        order: 1,
    };
    params.channel_folders = [frontend_folder, backend_folder];
    channel_folders.initialize(params);

    assert.deepEqual(channel_folders.get_channel_folders(), [frontend_folder, backend_folder]);
    assert.deepEqual(
        channel_folders.get_active_folder_ids(),
        new Set([frontend_folder.id, backend_folder.id]),
    );

    const devops_folder = {
        name: "Devops",
        description: "",
        rendered_description: "",
        creator_id: 1,
        date_created: 1596810000,
        id: 3,
        is_archived: false,
        order: 2,
    };
    channel_folders.add(devops_folder);
    assert.deepEqual(channel_folders.get_channel_folders(), [
        frontend_folder,
        backend_folder,
        devops_folder,
    ]);

    devops_folder.is_archived = true;
    assert.deepEqual(channel_folders.get_channel_folders(), [frontend_folder, backend_folder]);

    assert.deepEqual(channel_folders.get_channel_folders(true), [
        frontend_folder,
        backend_folder,
        devops_folder,
    ]);

    assert.deepEqual(
        channel_folders.get_all_folder_ids(),
        new Set([frontend_folder.id, backend_folder.id, devops_folder.id]),
    );

    assert.ok(channel_folders.is_valid_folder_id(frontend_folder.id));
    assert.ok(!channel_folders.is_valid_folder_id(999));

    assert.equal(channel_folders.get_channel_folder_by_id(frontend_folder.id), frontend_folder);

    const new_order = [backend_folder.id, devops_folder.id, frontend_folder.id];
    channel_folders.reorder(new_order);
    assert.equal(backend_folder.order, 0);
    assert.equal(devops_folder.order, 1);
    assert.equal(frontend_folder.order, 2);

    const stream_1 = make_stream({
        stream_id: 1,
        name: "Stream 1",
        folder_id: null,
    });
    const stream_2 = make_stream({
        stream_id: 2,
        name: "Stream 2",
        folder_id: frontend_folder.id,
    });
    const stream_3 = make_stream({
        stream_id: 3,
        name: "Stream 3",
        folder_id: devops_folder.id,
    });
    const stream_4 = make_stream({
        stream_id: 4,
        name: "Stream 4",
        folder_id: frontend_folder.id,
    });
    const stream_5 = make_stream({
        stream_id: 5,
        name: "channel 5",
        folder_id: frontend_folder.id,
    });
    stream_data.add_sub_for_tests(stream_1);

    assert.deepEqual(channel_folders.user_has_folders(), false);

    stream_data.add_sub_for_tests(stream_2);
    stream_data.add_sub_for_tests(stream_3);
    stream_data.add_sub_for_tests(stream_4);
    stream_data.add_sub_for_tests(stream_5);

    assert.deepEqual(channel_folders.get_stream_ids_in_folder(frontend_folder.id), [
        stream_2.stream_id,
        stream_4.stream_id,
        stream_5.stream_id,
    ]);
    assert.deepEqual(channel_folders.get_stream_ids_in_folder(devops_folder.id), [
        stream_3.stream_id,
    ]);
    assert.deepEqual(channel_folders.get_stream_ids_in_folder(backend_folder.id), []);

    assert.deepEqual(channel_folders.get_sorted_streams_in_folder(frontend_folder.id), [
        stream_5,
        stream_2,
        stream_4,
    ]);

    const subscribed_streams = new Set([
        stream_1.stream_id,
        stream_2.stream_id,
        stream_3.stream_id,
        stream_4.stream_id,
    ]);

    // Tests for get_channels_in_folders_matching_search_term_in_folder_name
    // Should match 'Frontend' folder and return its streams
    assert.deepEqual(
        channel_folders.get_channels_in_folders_matching_search_term_in_folder_name(
            "Front",
            subscribed_streams,
        ),
        [stream_2.stream_id, stream_4.stream_id],
    );

    // Should match 'Backend' folder and return no streams
    assert.deepEqual(
        channel_folders.get_channels_in_folders_matching_search_term_in_folder_name(
            "Back",
            subscribed_streams,
        ),
        [],
    );

    // Should match no folder and return empty array
    assert.deepEqual(
        channel_folders.get_channels_in_folders_matching_search_term_in_folder_name(
            "Nonexistent",
            subscribed_streams,
        ),
        [],
    );

    assert.deepEqual(channel_folders.user_has_folders(), true);

    // Unarchive the folder for further tests.
    devops_folder.is_archived = false;
    assert.deepEqual(channel_folders.get_folders_with_accessible_channels(), [
        devops_folder,
        frontend_folder,
    ]);

    // Remove a stream to test case of an inaccessible stream.
    stream_data.delete_sub(stream_3.stream_id);
    assert.deepEqual(channel_folders.get_folders_with_accessible_channels(), [frontend_folder]);
});

run_test("administering folders", ({override}) => {
    const me_id = 30;
    const designers = make_user_group({
        name: "Designers",
        id: 101,
        members: [me_id],
    });
    const researchers = make_user_group({
        name: "Researchers",
        id: 102,
        members: [31],
    });
    user_groups.initialize({realm_user_groups: [designers, researchers]});
    override(current_user, "user_id", me_id);
    override(current_user, "is_admin", false);
    override(current_user, "is_guest", false);

    function make_folder(id, name, can_administer_group) {
        return {
            name,
            description: "",
            rendered_description: "",
            creator_id: null,
            date_created: 1596710000,
            id,
            is_archived: false,
            order: id,
            can_administer_group,
        };
    }
    const mine = make_folder(11, "Mine", {direct_members: [me_id], direct_subgroups: []});
    const design = make_folder(12, "Design", designers.id);
    const research = make_folder(13, "Research", researchers.id);
    channel_folders.initialize({channel_folders: [mine, design, research]});

    assert.equal(channel_folders.is_user_appointed_administrator(mine.id), true);
    assert.equal(channel_folders.is_user_appointed_administrator(design.id), true);
    assert.equal(channel_folders.is_user_appointed_administrator(research.id), false);
    assert.equal(channel_folders.can_user_manage_folder(mine.id), true);
    assert.equal(channel_folders.can_user_manage_folder(research.id), false);

    // Organization administrators administer every folder without
    // being appointed, and guests none.
    override(current_user, "is_admin", true);
    assert.equal(channel_folders.is_user_appointed_administrator(research.id), false);
    assert.equal(channel_folders.can_user_manage_folder(research.id), true);
    override(current_user, "is_admin", false);
    override(current_user, "is_guest", true);
    assert.equal(channel_folders.can_user_manage_folder(mine.id), false);
    override(current_user, "is_guest", false);

    const administered_channel = make_stream({
        stream_id: 21,
        name: "administered",
        folder_id: null,
        can_administer_channel_group: {direct_members: [me_id], direct_subgroups: []},
    });
    const other_channel = make_stream({
        stream_id: 22,
        name: "other",
        folder_id: null,
        can_administer_channel_group: researchers.id,
    });

    // A channel in no folder is moved by those who administer the
    // channel and the folder it is moved to.
    const can_move = channel_folders.can_user_move_channel_to_folder;
    assert.equal(can_move(administered_channel, null), true);
    assert.equal(can_move(administered_channel, mine.id), true);
    assert.equal(can_move(administered_channel, research.id), false);
    assert.equal(can_move(other_channel, mine.id), false);

    // A channel in a folder is moved by those who administer its
    // folder and the folder it is moved to, if any.
    other_channel.folder_id = mine.id;
    assert.equal(can_move(other_channel, mine.id), true);
    assert.equal(can_move(other_channel, null), true);
    assert.equal(can_move(other_channel, design.id), true);
    assert.equal(can_move(other_channel, research.id), false);
    administered_channel.folder_id = research.id;
    assert.equal(can_move(administered_channel, research.id), true);
    assert.equal(can_move(administered_channel, null), false);
    assert.equal(can_move(administered_channel, mine.id), false);

    channel_folders.update({
        channel_folder_id: research.id,
        data: {can_administer_group: designers.id},
    });
    assert.equal(channel_folders.can_user_manage_folder(research.id), true);
    assert.equal(can_move(administered_channel, mine.id), true);
});

run_test("names of channels in folders", () => {
    const design = {
        name: "Design",
        description: "",
        rendered_description: "",
        creator_id: null,
        date_created: 1596710000,
        id: 31,
        is_archived: false,
        order: 31,
        can_administer_group: 1,
    };
    channel_folders.initialize({channel_folders: [design]});

    const in_folder = make_stream({stream_id: 41, name: "Design/sketches", folder_id: design.id});
    assert.equal(channel_folders.get_folder_prefix_of_channel_name(in_folder), "Design/");
    assert.equal(channel_folders.get_short_channel_name(in_folder), "sketches");

    const in_no_folder = make_stream({stream_id: 42, name: "Design/sketches", folder_id: null});
    assert.equal(channel_folders.get_folder_prefix_of_channel_name(in_no_folder), "");
    assert.equal(channel_folders.get_short_channel_name(in_no_folder), "Design/sketches");

    // The name of a channel can be behind the name of its folder
    // while events about a renamed folder are arriving.
    const renamed_folder = make_stream({stream_id: 43, name: "Art/sketches", folder_id: design.id});
    assert.equal(channel_folders.get_folder_prefix_of_channel_name(renamed_folder), "");
    assert.equal(channel_folders.get_short_channel_name(renamed_folder), "Art/sketches");

    assert.equal(
        channel_folders.get_qualified_channel_name("sketches", design.id),
        "Design/sketches",
    );
    assert.equal(channel_folders.get_qualified_channel_name("sketches", null), "sketches");
});
