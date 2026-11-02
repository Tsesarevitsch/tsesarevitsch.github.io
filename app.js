/* AniLibria interaction plugin for Media Station X. ES5, no dependencies. */
(function () {
    "use strict";

    /* If the API refuses browser requests (CORS), deploy worker.js and put its URL here,
       e.g. "https://anilibria.example.workers.dev". */
    var PROXY = "";

    var VERSION = "1.9.2";

    var SITE = "https://aniliberty.top";
    var HOSTS = (PROXY ? [PROXY.replace(/\/+$/, "")] : []).concat([SITE, "https://anilibria.top"]);
    var API_PATH = "/api/v1";
    var TIMEOUT_MS = 15000;
    var PAGE_SIZE = 48; /* 8 rows of 6 posters; the API maximum is 50 */
    var SEARCH_DELAY_MS = 400;
    var MAX_INPUT = 32;
    var QUALITIES = ["1080", "720", "480"];
    var QUALITY_KEY = "anilibria.quality";
    var ROTATE_KEY = "anilibria.rotate";
    var ZONES_KEY = "anilibria.zones";
    var ZONE_DOUBLE_MS = 450;
    var ZONE_COLOR = "rgba(0, 0, 0, 0)";
    var SPEEDS = ["1", "1.25", "1.5", "1.75", "2"];
    var SPEED_KEY = "anilibria.speed";
    var TOKEN_KEY = "anilibria.token";
    var DEVICE_KEY = "anilibria.device";
    var HISTORY_KEY = "anilibria.history";
    var HISTORY_SIZE = 60;
    var FAVORITES_PATH = "/accounts/users/me/favorites";
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
    var playerUrl = pluginUrl.replace(/[^\/]*$/, "player.html");
    var hostIndex = 0;
    var zones = { visible: false, side: null, time: 0, timer: null };
    var search = { input: "", lang: "ru", results: null, error: null, timer: null, seq: 0 };

    /* ---------- helpers ---------- */

    function request(dataId) {
        return "request:interaction:" + dataId + "@" + pluginUrl;
    }

    function open(dataId) {
        return "content:" + request(dataId);
    }

    /* window.localStorage does not persist inside plugins on iOS; MSX's wrapper does. */
    function storageGet(key) {
        try { return TVXServices.storage.getFullStr(key, null); } catch (e) { return null; }
    }

    function storageSet(key, value) {
        try {
            TVXServices.storage.set(key, value);
            TVXServices.storage.flush();
        } catch (e) { /* storage unavailable: the choice lasts until restart at most */ }
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

    function token() {
        return storageGet(TOKEN_KEY) || "";
    }

    function setToken(value) {
        storageSet(TOKEN_KEY, value);
    }

    function deviceId() {
        var id = storageGet(DEVICE_KEY);
        if (!id) {
            id = "msx-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
            storageSet(DEVICE_KEY, id);
        }
        return id;
    }

    function formBody(fields) {
        return Object.keys(fields).map(function (key) {
            return encodeURIComponent(key) + "=" + encodeURIComponent(fields[key]);
        }).join("&");
    }

    /* options: auth (send the session token), form (fields) or json (body).
       Form bodies need no CORS preflight, so code login works even if preflight is refused.
       fail(message, status): status is 0 when no HTTP response was received. */
    function send(method, path, options, done, fail, attempt) {
        attempt = attempt || 0;
        var index = (hostIndex + attempt) % HOSTS.length;
        var xhr = new XMLHttpRequest();
        var body = null;
        var retry = function (message, status) {
            if (method === "GET" && attempt + 1 < HOSTS.length) {
                send(method, path, options, done, fail, attempt + 1);
            } else {
                fail(message, status);
            }
        };
        xhr.open(method, HOSTS[index] + API_PATH + path);
        xhr.timeout = TIMEOUT_MS;
        xhr.setRequestHeader("Accept", "application/json");
        if (options.auth) {
            xhr.setRequestHeader("Authorization", "Bearer " + token());
        }
        if (options.form) {
            xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
            body = formBody(options.form);
        } else if (options.json) {
            xhr.setRequestHeader("Content-Type", "application/json");
            body = JSON.stringify(options.json);
        }
        xhr.onload = function () {
            if (xhr.status === 403 && options.auth) {
                setToken("");
                fail("Вход устарел, войди заново", 403);
                return;
            }
            if (xhr.status === 404 || xhr.status === 422 || (method !== "GET" && xhr.status !== 200)) {
                fail("API ответил " + xhr.status, xhr.status);
                return;
            }
            if (xhr.status !== 200) {
                retry("API ответил " + xhr.status, xhr.status);
                return;
            }
            var data = null;
            try {
                data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
            } catch (e) {
                retry("API вернул не JSON", xhr.status);
                return;
            }
            hostIndex = index;
            done(data);
        };
        xhr.onerror = function () { retry("Нет доступа к API (сеть или CORS)", 0); };
        xhr.ontimeout = function () { retry("API не ответил вовремя", 0); };
        xhr.send(body);
    }

    function get(path, done, fail) {
        send("GET", path, {}, done, fail);
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

    /* MSX rejects a page without selectable items, so a lone hint stays enabled with a no-op action. */
    function hintItem(text) {
        return { type: "default", title: text, enumerate: false, action: "[]" };
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
        items.push({ icon: "star", label: "Избранное", data: request("favorites:1") });
        items.push({ icon: "history", label: "История", data: request("history") });
        items.push({ icon: "event", label: "Расписание", data: request("schedule") });
        items.push({ icon: "search", label: "Поиск", data: request("search") });
        items.push({ icon: "account-circle", label: "Аккаунт", data: request("account") });
        return { name: "AniLibria", version: VERSION, headline: "AniLibria", extension: "v" + VERSION, menu: items };
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

    function loginContent(headline, message) {
        return {
            type: "list",
            cache: false,
            headline: headline,
            template: { type: "control", layout: "0,0,12,1", enumerate: false },
            items: [
                { icon: "info", label: message, action: "[]" },
                { icon: "login", label: "Войти в аккаунт", action: open("account") }
            ]
        };
    }

    function readHistory() {
        try {
            var entries = JSON.parse(storageGet(HISTORY_KEY) || "[]");
            return Array.isArray(entries) ? entries : [];
        } catch (e) {
            return [];
        }
    }

    /* Keeps only what a poster needs, newest first, one entry per release. */
    function remember(release) {
        var previous = historyEntry(release.id);
        var entries = readHistory().filter(function (entry) { return entry.id !== release.id; });
        entries.unshift({
            id: release.id,
            last: previous && previous.last,
            name: { main: release.name.main },
            year: release.year,
            type: release.type ? { description: release.type.description } : null,
            poster: release.poster ? { src: release.poster.src || release.poster.preview } : null
        });
        storageSet(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_SIZE)));
    }

    function history() {
        var items = readHistory().map(function (release) {
            return posterItem(release, release.last ? { titleFooter: release.last.ordinal + " серия" } : null);
        });
        if (items.length > 0) {
            items.push({
                type: "button",
                icon: "delete-sweep",
                label: "Очистить",
                action: "interaction:commit",
                data: { action: "history:clear" }
            });
        }
        return {
            type: "list",
            cache: false,
            headline: "История",
            template: posterTemplate(),
            items: items.length > 0 ? items : [hintItem("Здесь появятся открытые тайтлы")]
        };
    }

    function favorites(page, callback) {
        if (!token()) {
            callback(loginContent("Избранное", "Избранное доступно после входа"));
            return;
        }
        send("GET", FAVORITES_PATH + "/releases?limit=" + PAGE_SIZE + "&page=" + page, { auth: true }, function (data) {
            var pagination = (data.meta && data.meta.pagination) || {};
            var items = (data.data || []).map(function (release) { return posterItem(release); });
            if (pagination.current_page < pagination.total_pages) {
                items.push({
                    type: "button",
                    icon: "arrow-forward",
                    label: "Страница " + (page + 1),
                    action: open("favorites:" + (page + 1))
                });
            }
            callback({
                type: "list",
                cache: false,
                headline: "Избранное" + (page > 1 ? " · страница " + page : ""),
                template: posterTemplate(),
                items: items.length > 0 ? items : [hintItem("В избранном пока пусто")]
            });
        }, function (message, status) {
            callback(status === 403 ? loginContent("Избранное", message) : errorContent("Избранное", message));
        });
    }

    function accountPage(items) {
        return { type: "list", cache: false, headline: "Аккаунт", pages: [{ items: items }] };
    }

    function accountButton(layout, label, action, data) {
        return { type: "button", layout: layout, label: label, action: action, data: data };
    }

    function account(callback) {
        if (token()) {
            send("GET", "/accounts/users/me/profile", { auth: true }, function (profile) {
                callback(accountPage([
                    {
                        type: "default",
                        layout: "0,0,12,2",
                        color: "msx-glass",
                        headline: "Вы вошли как",
                        title: (profile && (profile.nickname || profile.login)) || "пользователь",
                        action: "[]"
                    },
                    accountButton("0,2,4,1", "{ico:star} Избранное", open("favorites:1")),
                    accountButton("4,2,4,1", "{ico:logout} Выйти", "interaction:commit", { action: "logout" })
                ]));
            }, function (message, status) {
                if (status === 403) {
                    account(callback);
                } else {
                    callback(errorContent("Аккаунт", message));
                }
            });
            return;
        }
        send("POST", "/accounts/otp/get", { form: { device_id: deviceId() } }, function (data) {
            var code = data && data.otp && data.otp.code;
            if (!code) {
                callback(errorContent("Аккаунт", "API не выдал код"));
                return;
            }
            callback(accountPage([
                {
                    type: "default",
                    layout: "0,0,12,2",
                    color: "msx-glass",
                    headline: "Код для входа (действует 5 минут)",
                    title: code,
                    action: "[]"
                },
                {
                    type: "space",
                    layout: "0,2,12,1",
                    text: "Введи код на сайте или в приложении AniLibria, где ты уже вошёл, затем нажми «Я подтвердил»."
                },
                accountButton("0,3,4,1", "{ico:check} Я подтвердил", "interaction:commit", { action: "login:" + code }),
                accountButton("4,3,4,1", "{ico:open-in-new} Открыть сайт", "link:window:" + SITE),
                accountButton("8,3,4,1", "{ico:refresh} Новый код", "reload:content")
            ]));
        }, function (message) {
            callback(errorContent("Аккаунт", message));
        });
    }

    function login(code) {
        send("POST", "/accounts/otp/login", { form: { code: code, device_id: deviceId() } }, function (data) {
            if (!data || !data.token) {
                TVXInteractionPlugin.error("API не выдал вход");
                return;
            }
            setToken(data.token);
            TVXInteractionPlugin.success("Вход выполнен");
            TVXInteractionPlugin.executeAction("reload:content");
        }, function (message, status) {
            if (status === 500) {
                TVXInteractionPlugin.warn("Код ещё не подтверждён");
            } else if (status === 404) {
                TVXInteractionPlugin.warn("Код устарел, получи новый");
                TVXInteractionPlugin.executeAction("reload:content");
            } else {
                TVXInteractionPlugin.error(message);
            }
        });
    }

    function logout() {
        var finish = function () {
            setToken("");
            TVXInteractionPlugin.executeAction("reload:content");
        };
        send("POST", "/accounts/users/auth/logout", { auth: true }, finish, finish);
    }

    function toggleFavorite(action) {
        var parts = action.split(":");
        send(parts[1] === "add" ? "POST" : "DELETE", FAVORITES_PATH, {
            auth: true,
            json: [{ release_id: Number(parts[2]) }]
        }, function () {
            TVXInteractionPlugin.executeAction("reload:content");
        }, function (message) {
            TVXInteractionPlugin.error(message);
            TVXInteractionPlugin.executeAction("reload:content");
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

    function speed() {
        var stored = storageGet(SPEED_KEY);
        return SPEEDS.indexOf(stored) >= 0 ? stored : "1";
    }

    function playerProperties(release, episode) {
        var onStart = ["interaction:commit:message:watch:" + release.id + ":" + episode.id + ":" + episode.ordinal];
        if (speed() !== "1") { onStart.unshift("player:speed:set:" + speed()); }
        var properties = {
            /* no video behind the menus; the reload shows the new last episode */
            "trigger:background": "[player:eject|reload:content]",
            "resume:key": "id", /* eject must not lose the position */
            "button:rewind:icon": "replay-10",
            "button:rewind:action": "player:seek:-10",
            "button:forward:icon": "forward-10",
            "button:forward:action": "player:seek:+10"
        };
        if (zonesEnabled()) {
            onStart.push("interaction:commit:message:zones:open");
            properties["trigger:background"] = "interaction:commit:message:zones:background";
            properties["trigger:foreground"] = "interaction:commit:message:zones:foreground";
            properties["button:content:icon"] = "touch-app";
            properties["button:content:action"] = "interaction:commit:message:zones:open";
        }
        properties["trigger:start"] = "[" + onStart.join("|") + "]";
        return properties;
    }

    function zonesEnabled() {
        return storageGet(ZONES_KEY) === "on";
    }

    /* Invisible page above the video: MSX reports taps on its own items, unlike taps on a plugin.
       On a rotated picture the left edge is at the top, so the zones become rows. */
    function zonesContent() {
        var rows = rotated() && window.innerHeight > window.innerWidth;
        var layouts = rows ? ["0,0,12,2", "0,2,12,2", "0,4,12,2"] : ["0,0,4,6", "4,0,4,6", "8,0,4,6"];
        var zone = function (layout, side) {
            /* The focus frame cannot be hidden, so it is sent to a tiny item after each tap. */
            return {
                type: "default",
                layout: layout,
                color: ZONE_COLOR,
                enumerate: false,
                action: "[focus:zone_park|interaction:commit]",
                data: { action: "zone:" + side }
            };
        };
        var park = {
            id: "zone_park",
            type: "default",
            layout: "11,5,1,1",
            offset: "0.98,0.98,-0.98,-0.98",
            color: ZONE_COLOR,
            enumerate: false,
            focus: true,
            action: "[]"
        };
        return {
            type: "pages",
            cache: false,
            transparent: 1,
            pages: [{ items: [zone(layouts[0], -1), zone(layouts[1], 0), zone(layouts[2], 1), park] }]
        };
    }

    function handleZoneMessage(message) {
        if (message === "zones:open") {
            if (zones.visible) { return; }
            zones.visible = true;
            TVXInteractionPlugin.executeAction("player:content:" + request("zones"));
        } else if (message === "zones:foreground") {
            zones.visible = false;
        } else if (message === "zones:background" && !zones.visible) {
            TVXInteractionPlugin.executeAction("[player:eject|reload:content]");
        }
    }

    function handleZoneTap(side) {
        var now = Date.now();
        var isDouble = side === zones.side && now - zones.time < ZONE_DOUBLE_MS;
        zones.side = side;
        zones.time = isDouble ? 0 : now;
        clearTimeout(zones.timer);
        if (side !== 0) {
            if (isDouble) {
                TVXInteractionPlugin.executeAction("player:seek:" + (side > 0 ? "+10" : "-10"));
            }
        } else if (isDouble) {
            TVXInteractionPlugin.executeAction("back"); /* returns to the player with its controls */
        } else {
            /* Pausing waits for the double-tap window, otherwise a double tap would also pause. */
            zones.timer = setTimeout(function () {
                TVXInteractionPlugin.executeAction("player:play_pause");
            }, ZONE_DOUBLE_MS);
        }
    }

    function rotated() {
        return storageGet(ROTATE_KEY) !== "off"; /* landscape video by default */
    }

    function playAction(url) {
        return rotated() ? "video:plugin:" + playerUrl + "?url=" + encodeURIComponent(url) : "video:" + url;
    }

    function historyEntry(id) {
        return readHistory().filter(function (entry) { return String(entry.id) === String(id); })[0] || null;
    }

    function markWatched(releaseId, episodeId, ordinal) {
        var entries = readHistory();
        entries.forEach(function (entry) {
            if (String(entry.id) === releaseId) { entry.last = { id: episodeId, ordinal: ordinal }; }
        });
        storageSet(HISTORY_KEY, JSON.stringify(entries));
    }

    function episodeItems(release) {
        var name = release.name.main;
        var entry = historyEntry(release.id);
        var last = entry && entry.last;
        return (release.episodes || []).filter(hlsUrl).map(function (episode) {
            var label = episode.ordinal + " серия";
            return {
                id: episode.id,
                badge: last && last.id === episode.id ? "Последняя" : null,
                badgeColor: "msx-red",
                title: label,
                titleFooter: [episode.name, formatDuration(episode.duration)].filter(Boolean).join(" · "),
                image: imageUrl(episode.preview) || imageUrl(release.poster),
                playerLabel: name + " — " + label,
                action: playAction(hlsUrl(episode)),
                properties: playerProperties(release, episode)
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

    function favoriteButton(release, ids) {
        var button = { type: "button", layout: "7,2,5,1", label: "{ico:star-border} В избранное" };
        if (!token()) {
            button.action = open("account");
        } else if (ids.indexOf(release.id) >= 0) {
            button.label = "{ico:star} В избранном";
            button.action = "interaction:commit";
            button.data = { action: "favorite:remove:" + release.id };
        } else {
            button.action = "interaction:commit";
            button.data = { action: "favorite:add:" + release.id };
        }
        return button;
    }

    /* Favorite state is optional: without it the title page must still open. */
    function withFavoriteIds(next) {
        if (!token()) {
            next([]);
            return;
        }
        send("GET", FAVORITES_PATH + "/ids", { auth: true }, function (ids) {
            next(ids || []);
        }, function () {
            next([]);
        });
    }

    function title(id, callback) {
        get("/anime/releases/" + encodeURIComponent(id), function (release) {
            remember(release);
            withFavoriteIds(function (ids) { callback(titleContent(release, ids)); });
        }, function (message) {
            callback(errorContent("AniLibria", message));
        });
    }

    function titleContent(release, ids) {
            var items = episodeItems(release);
            var entry = historyEntry(release.id);
            var lastIndex = -1;
            items.forEach(function (item, index) {
                if (entry && entry.last && item.id === entry.last.id) { lastIndex = index; }
            });
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
                    layout: "2,0,10,2",
                    headline: release.name.main,
                    text: [facts, "{br}", clip(release.description, 420)],
                    truncation: "text"
                }
            ];
            /* One-row buttons: an icon field would be drawn over the label, so icons stay inline. */
            if (items.length > 0) {
                header.push({
                    type: "button",
                    layout: "2,2,5,1",
                    label: lastIndex >= 0
                        ? "{ico:play-arrow} Продолжить: " + entry.last.ordinal + " серия"
                        : "{ico:play-arrow} Смотреть",
                    action: "playlist:data",
                    data: { template: episodeTemplate(), items: items.slice(Math.max(lastIndex, 0)) }
                });
            } else {
                header.push({
                    type: "button",
                    layout: "2,2,5,1",
                    label: release.is_blocked_by_geo || release.is_blocked_by_copyrights
                        ? "{ico:warning} Заблокировано" : "{ico:warning} Серий нет",
                    enable: false
                });
            }
            header.push(favoriteButton(release, ids));
            header.push({
                type: "button",
                layout: "2,3,2,1",
                label: "{ico:high-quality} " + quality() + "p",
                action: "interaction:commit",
                data: { action: "quality" }
            });
            header.push({
                type: "button",
                layout: "4,3,2,1",
                label: "{ico:speed} " + speed() + "x",
                action: "interaction:commit",
                data: { action: "speed" }
            });
            header.push({
                type: "button",
                layout: "6,3,3,1",
                label: "{ico:screen-rotation} Поворот: " + (rotated() ? "вкл" : "выкл"),
                action: "interaction:commit",
                data: { action: "rotate" }
            });
            header.push({
                type: "button",
                layout: "9,3,3,1",
                label: "{ico:touch-app} Касания: " + (zonesEnabled() ? "вкл" : "выкл"),
                action: "interaction:commit",
                data: { action: "zones" }
            });
            return {
                type: "list",
                cache: false,
                headline: release.name.main,
                header: { items: header },
                template: episodeTemplate(),
                items: items.length > 0 ? items : [hintItem("Серии недоступны")]
            };
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
                : [hintItem(searchHint())]
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
            if (data && typeof data.message === "string") {
                if (data.message.indexOf("watch:") === 0) {
                    var parts = data.message.split(":");
                    markWatched(parts[1], parts[2], parts[3]);
                } else if (data.message.indexOf("zones:") === 0) {
                    handleZoneMessage(data.message);
                }
                return;
            }
            var action = data && data.data && data.data.action;
            if (!action) { return; }
            if (action === "quality") {
                var next = QUALITIES[(QUALITIES.indexOf(quality()) + 1) % QUALITIES.length];
                storageSet(QUALITY_KEY, next);
                TVXInteractionPlugin.executeAction("reload:content");
            } else if (action === "speed") {
                storageSet(SPEED_KEY, SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length]);
                TVXInteractionPlugin.executeAction("reload:content");
            } else if (action === "zones") {
                storageSet(ZONES_KEY, zonesEnabled() ? "off" : "on");
                TVXInteractionPlugin.executeAction("reload:content");
            } else if (action.indexOf("zone:") === 0) {
                handleZoneTap(Number(action.slice(5)));
            } else if (action === "rotate") {
                storageSet(ROTATE_KEY, rotated() ? "off" : "on");
                TVXInteractionPlugin.executeAction("reload:content");
            } else if (action.indexOf("login:") === 0) {
                login(action.slice(6));
            } else if (action === "history:clear") {
                storageSet(HISTORY_KEY, "[]");
                TVXInteractionPlugin.executeAction("reload:content");
            } else if (action === "logout") {
                logout();
            } else if (action.indexOf("favorite:") === 0) {
                toggleFavorite(action);
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
            } else if (parts[0] === "favorites") {
                favorites(Number(parts[1]) || 1, callback);
            } else if (dataId === "zones") {
                callback(zonesContent());
            } else if (dataId === "history") {
                callback(history());
            } else if (dataId === "account") {
                account(callback);
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
