/* AniLibria interaction plugin for Media Station X. ES5, no dependencies. */
(function () {
    "use strict";

    /* If the API refuses browser requests (CORS), deploy worker.js and put its URL here,
       e.g. "https://anilibria.example.workers.dev". */
    var PROXY = "";

    var SITE = "https://aniliberty.top";
    var HOSTS = (PROXY ? [PROXY.replace(/\/+$/, "")] : []).concat([SITE, "https://anilibria.top"]);
    var API_PATH = "/api/v1";
    var TIMEOUT_MS = 15000;
    var PAGE_SIZE = 48; /* 8 rows of 6 posters; the API maximum is 50 */
    var SEARCH_DELAY_MS = 400;
    var MAX_INPUT = 32;
    var QUALITIES = ["1080", "720", "480"];
    var QUALITY_KEY = "anilibria.quality";
    var SECTIONS = {
        fresh: { label: "Новинки", query: "f[sorting]=FRESH_AT_DESC" },
        top: { label: "Популярное", query: "f[sorting]=RATING_DESC" },
        movies: { label: "Фильмы", query: "f[sorting]=RATING_DESC&f[types]=MOVIE" }
    };
    var MIN_QUERY = 2;
    var KEY_ROWS = {
        ru: ["йцукенгшщзхъ", "фывапролджэё", "ячсмитьбю"],
        en: ["qwertyuiop", "asdfghjkl", "zxcvbnm"],
        num: ["1234567890", "-:.!?"]
    };
    var LAYOUT_NAMES = { ru: "РУС", en: "ENG", num: "123" };
    var LAYOUT_ORDER = ["ru", "en", "num"];
    var DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

    var pluginUrl = location.href.split(/[?#]/)[0];
    var hostIndex = 0;
    var search = { input: "", lang: "ru", results: null, error: null, timer: null, seq: 0 };

    /* ---------- helpers ---------- */

    function request(dataId) {
        return "request:interaction:" + dataId + "@" + pluginUrl;
    }

    function open(dataId) {
        return "content:" + request(dataId);
    }

    function storageGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function storageSet(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
    }

    function quality() {
        var stored = storageGet(QUALITY_KEY);
        return QUALITIES.indexOf(stored) >= 0 ? stored : "720";
    }

    function imageUrl(image) {
        var path = image && (image.src || image.preview || image.thumbnail);
        if (!path) { return null; }
        if (/^https?:/.test(path)) { return path; }
        return path.indexOf("//") === 0 ? "https:" + path : SITE + path;
    }

    /* Requested quality, then the nearest lower one, then anything available. */
    function hlsUrl(episode) {
        var order = QUALITIES.slice(QUALITIES.indexOf(quality())).concat(QUALITIES);
        for (var i = 0; i < order.length; i++) {
            if (episode["hls_" + order[i]]) { return episode["hls_" + order[i]]; }
        }
        return null;
    }

    function clip(text, length) {
        var clean = String(text || "").replace(/[\s ]+/g, " ").trim();
        return clean.length > length ? clean.slice(0, length - 1).trim() + "…" : clean;
    }

    function pad(number) {
        return number < 10 ? "0" + number : String(number);
    }

    function formatDuration(seconds) {
        return seconds > 0 ? Math.round(seconds / 60) + " мин" : "";
    }

    function get(path, done, fail, attempt) {
        attempt = attempt || 0;
        var index = (hostIndex + attempt) % HOSTS.length;
        var xhr = new XMLHttpRequest();
        var retry = function (message) {
            if (attempt + 1 < HOSTS.length) {
                get(path, done, fail, attempt + 1);
            } else {
                fail(message);
            }
        };
        xhr.open("GET", HOSTS[index] + API_PATH + path);
        xhr.timeout = TIMEOUT_MS;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
            if (xhr.status === 404 || xhr.status === 422) {
                fail("API ответил " + xhr.status);
                return;
            }
            if (xhr.status !== 200) {
                retry("API ответил " + xhr.status);
                return;
            }
            var data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                retry("API вернул не JSON");
                return;
            }
            hostIndex = index;
            done(data);
        };
        xhr.onerror = function () { retry("Нет доступа к API (сеть или CORS)"); };
        xhr.ontimeout = function () { retry("API не ответил вовремя"); };
        xhr.send();
    }

    /* ---------- content builders ---------- */

    function errorContent(headline, message) {
        return {
            type: "list",
            cache: false,
            headline: headline,
            template: { type: "control", layout: "0,0,12,1", enumerate: false },
            items: [
                { icon: "warning", label: message, enable: false },
                { icon: "refresh", label: "Повторить", action: "reload:content" }
            ]
        };
    }

    function posterTemplate() {
        return {
            type: "separate",
            layout: "0,0,2,4",
            color: "msx-glass",
            imageFiller: "cover",
            enumerate: false,
            truncation: "title|titleHeader|titleFooter"
        };
    }

    function posterItem(release, extra) {
        var item = {
            title: release.name && release.name.main,
            titleFooter: [release.year, release.type && release.type.description]
                .filter(Boolean).join(" · "),
            image: imageUrl(release.poster),
            action: open("title:" + release.id)
        };
        for (var key in extra || {}) { item[key] = extra[key]; }
        return item;
    }

    function menu() {
        var items = [];
        for (var id in SECTIONS) {
            items.push({
                icon: { fresh: "new-releases", top: "whatshot", movies: "movie" }[id],
                label: SECTIONS[id].label,
                data: request("list:" + id + ":1")
            });
        }
        items.push({ icon: "event", label: "Расписание", data: request("schedule") });
        items.push({ icon: "search", label: "Поиск", data: request("search") });
        return { name: "AniLibria", version: "1.0.0", headline: "AniLibria", menu: items };
    }

    function list(section, page, callback) {
        var config = SECTIONS[section];
        var query = "/anime/catalog/releases?" + config.query + "&limit=" + PAGE_SIZE + "&page=" + page;
        get(encodeBrackets(query), function (data) {
            var pagination = (data.meta && data.meta.pagination) || {};
            var items = (data.data || []).map(function (release) { return posterItem(release); });
            if (pagination.current_page < pagination.total_pages) {
                items.push({
                    type: "button",
                    icon: "arrow-forward",
                    label: "Страница " + (page + 1),
                    action: open("list:" + section + ":" + (page + 1))
                });
            }
            callback({
                type: "list",
                cache: false,
                headline: config.label + (page > 1 ? " · страница " + page : ""),
                important: page > 1,
                template: posterTemplate(),
                items: items
            });
        }, function (message) {
            callback(errorContent(config.label, message));
        });
    }

    function encodeBrackets(path) {
        return path.replace(/\[/g, "%5B").replace(/\]/g, "%5D");
    }

    function schedule(callback) {
        get("/anime/schedule/week", function (data) {
            var today = (new Date().getDay() + 6) % 7; /* 0 = Monday */
            var entries = data.map(function (entry) {
                var day = entry.release.publish_day ? entry.release.publish_day.value - 1 : 0;
                return { entry: entry, day: day, order: (day - today + 7) % 7 };
            }).sort(function (a, b) { return a.order - b.order; });
            callback({
                type: "list",
                cache: false,
                headline: "Расписание",
                template: posterTemplate(),
                items: entries.map(function (row, index) {
                    var next = row.entry.next_release_episode_number;
                    var first = index === 0 || entries[index - 1].day !== row.day;
                    return posterItem(row.entry.release, {
                        badge: row.order === 0 ? "Сегодня" : DAYS[row.day],
                        badgeColor: row.order === 0 ? "msx-red" : "msx-glass",
                        titleFooter: next ? next + " серия" : "",
                        "break": first && index > 0 ? "line" : null
                    });
                })
            });
        }, function (message) {
            callback(errorContent("Расписание", message));
        });
    }

    function episodeItems(release) {
        var name = release.name.main;
        return (release.episodes || []).filter(hlsUrl).map(function (episode) {
            var label = episode.ordinal + " серия";
            return {
                title: label,
                titleFooter: [episode.name, formatDuration(episode.duration)].filter(Boolean).join(" · "),
                image: imageUrl(episode.preview),
                playerLabel: name + " — " + label,
                action: "video:" + hlsUrl(episode)
            };
        });
    }

    function episodeTemplate() {
        return {
            type: "separate",
            layout: "0,0,3,3",
            color: "msx-glass",
            imageFiller: "cover",
            truncation: "title|titleFooter"
        };
    }

    function title(id, callback) {
        get("/anime/releases/" + encodeURIComponent(id), function (release) {
            var items = episodeItems(release);
            var facts = [
                release.year,
                release.type && release.type.description,
                release.age_rating && release.age_rating.label,
                (release.genres || []).slice(0, 3).map(function (genre) { return genre.name; }).join(", ")
            ].filter(Boolean).join(" · ");
            var header = [
                { type: "space", layout: "0,0,2,4", image: imageUrl(release.poster), imageFiller: "cover" },
                {
                    type: "space",
                    layout: "2,0,10,3",
                    headline: release.name.main,
                    text: [facts, "{br}", clip(release.description, 420)],
                    truncation: "text"
                }
            ];
            if (items.length > 0) {
                header.push({
                    type: "button",
                    layout: "2,3,3,1",
                    icon: "play-arrow",
                    label: "Смотреть",
                    action: "playlist:data",
                    data: { template: episodeTemplate(), items: items }
                });
            } else {
                header.push({
                    type: "button",
                    layout: "2,3,6,1",
                    icon: "warning",
                    label: release.is_blocked_by_geo || release.is_blocked_by_copyrights
                        ? "Недоступно: заблокировано" : "Серий пока нет",
                    enable: false
                });
            }
            header.push({
                type: "button",
                layout: items.length > 0 ? "5,3,3,1" : "8,3,4,1",
                icon: "high-quality",
                label: quality() + "p",
                action: "interaction:commit",
                data: { action: "quality" }
            });
            callback({
                type: "list",
                cache: false,
                headline: release.name.main,
                header: { items: header },
                template: episodeTemplate(),
                items: items.length > 0 ? items : [{ type: "space", enable: false }]
            });
        }, function (message) {
            callback(errorContent("AniLibria", message));
        });
    }

    function keyItem(id, layout, label, action) {
        return {
            id: id,
            type: "button",
            layout: layout,
            label: label,
            action: "interaction:commit",
            data: { action: action }
        };
    }

    function inputTitle() {
        return "{ico:search} " + (search.input || "Введите название");
    }

    function keyboard() {
        var items = [{
            id: "input",
            type: "space",
            layout: "0,0,12,1",
            color: "msx-glass",
            title: inputTitle(),
            centration: "title"
        }];
        KEY_ROWS[search.lang].forEach(function (row, rowIndex) {
            var left = Math.floor((12 - row.length) / 2);
            row.split("").forEach(function (key, index) {
                var layout = (left + index) + "," + (rowIndex + 1) + ",1,1";
                items.push(keyItem("key" + rowIndex + "_" + index, layout, key, "search:input:" + key));
            });
        });
        var next = LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(search.lang) + 1) % LAYOUT_ORDER.length];
        items.push(keyItem("lang", "0,4,2,1", LAYOUT_NAMES[next], "search:lang"));
        items.push(keyItem("space", "2,4,6,1", "{ico:space-bar}", "search:input: "));
        items.push(keyItem("clear", "8,4,2,1", "{ico:clear}", "search:clear"));
        items.push(keyItem("back", "10,4,2,1", "{ico:backspace}", "search:back"));
        return { items: items };
    }

    function searchHint() {
        if (search.error) { return "Ошибка поиска: " + search.error; }
        if (!search.input.trim()) { return "Начните вводить название"; }
        if (search.input.trim().length < MIN_QUERY) { return "Введите ещё хотя бы один символ"; }
        return search.results === null ? "Ищу…" : "Ничего не найдено";
    }

    function searchContent() {
        var results = search.results || [];
        return {
            type: "list",
            cache: false,
            flag: "anilibria_search",
            refocus: 1,
            headline: "Поиск",
            header: keyboard(),
            template: posterTemplate(),
            items: results.length > 0
                ? results.map(function (release) { return posterItem(release); })
                : [{ type: "default", layout: "0,0,12,1", title: searchHint(), enable: false }]
        };
    }

    function refreshSearch() {
        TVXInteractionPlugin.executeAction("reload:content");
    }

    /* The page is reloaded once per typing burst: overlapping reloads make MSX report errors. */
    function runSearch() {
        var seq = ++search.seq;
        var query = search.input.trim();
        clearTimeout(search.timer);
        TVXInteractionPlugin.executeAction("update:content:input", { title: inputTitle() });
        search.timer = setTimeout(function () {
            search.error = null;
            if (query.length < MIN_QUERY) {
                search.results = null;
                refreshSearch();
                return;
            }
            get("/app/search/releases?query=" + encodeURIComponent(query), function (data) {
                if (seq !== search.seq) { return; }
                search.results = data;
                refreshSearch();
            }, function (message) {
                if (seq !== search.seq) { return; }
                search.results = null;
                search.error = message;
                refreshSearch();
            });
        }, SEARCH_DELAY_MS);
    }

    function handleSearchAction(action) {
        if (action.indexOf("search:input:") === 0) {
            var key = action.slice(13);
            var doubleSpace = key === " " && (!search.input || / $/.test(search.input));
            if (search.input.length >= MAX_INPUT || doubleSpace) { return; }
            search.input += key;
        } else if (action === "search:back") {
            search.input = search.input.slice(0, -1);
        } else if (action === "search:clear") {
            search.input = "";
        } else if (action === "search:lang") {
            search.lang = LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(search.lang) + 1) % LAYOUT_ORDER.length];
            refreshSearch();
            return;
        }
        runSearch();
    }

    /* ---------- MSX handler ---------- */

    function Handler() {
        this.handleData = function (data) {
            var action = data && data.data && data.data.action;
            if (!action) { return; }
            if (action === "quality") {
                var next = QUALITIES[(QUALITIES.indexOf(quality()) + 1) % QUALITIES.length];
                storageSet(QUALITY_KEY, next);
                TVXInteractionPlugin.executeAction("reload:content");
            } else if (action.indexOf("search:") === 0) {
                handleSearchAction(action);
            }
        };

        this.handleRequest = function (dataId, data, callback) {
            var parts = dataId.split(":");
            if (dataId === "menu") {
                callback(menu());
            } else if (parts[0] === "list" && SECTIONS[parts[1]]) {
                list(parts[1], Number(parts[2]) || 1, callback);
            } else if (dataId === "schedule") {
                schedule(callback);
            } else if (dataId === "search") {
                callback(searchContent());
            } else if (parts[0] === "title") {
                title(parts[1], callback);
            } else {
                callback(errorContent("AniLibria", "Неизвестный запрос: " + dataId));
            }
        };
    }

    TVXPluginTools.onReady(function () {
        TVXInteractionPlugin.setupHandler(new Handler());
        TVXInteractionPlugin.init();
    });
}());
