// Kingdom Live listing page ("browse live sessions"). This page is otherwise
// pure server-rendered HTML computed once when the request comes in -- so
// without this script, a session moving scheduled -> live (or live -> ended)
// gives a visitor sitting on this page zero indication until they manually
// reload. We use lightweight polling against the existing /api/live/sessions
// JSON endpoint (already used by the admin tooling) rather than opening a
// full Socket.IO connection here: this page has no per-room state to
// coordinate, "is anything live yet" is naturally a poll-a-JSON-list problem,
// and it keeps this page's footprint minimal compared to pulling in the
// socket.io client just to learn about status flips a few times a minute.
(function () {
  const POLL_MS = 9000;

  const liveBanner = document.getElementById("live-banner");
  const liveNowGrid = document.getElementById("live-now-grid");
  const liveNowEmpty = document.getElementById("live-now-empty");
  const scheduledGrid = document.getElementById("scheduled-grid");
  const scheduledEmpty = document.getElementById("scheduled-empty");
  const endedGrid = document.getElementById("ended-grid");
  const endedEmpty = document.getElementById("ended-empty");

  // sessionId -> last known status, used only to detect scheduled/ended -> live
  // transitions so we don't show the "just went live" banner on first load.
  const prevStatuses = new Map();
  let sawFirstPoll = false;
  let bannerTimer = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function liveCardHtml(s) {
    return `<a class="media-card" href="/live/${encodeURIComponent(s.room_code)}">
      <div class="thumb"><span class="badge-kind" style="background:var(--red);">&#9679; LIVE</span>&#128225;</div>
      <div class="body"><h3>${escapeHtml(s.title)}</h3><p>Hosted by ${escapeHtml(s.host_name)}</p></div>
    </a>`;
  }
  function scheduledCardHtml(s) {
    return `<div class="media-card">
      <div class="thumb"><span class="badge-kind">Scheduled</span>&#128197;</div>
      <div class="body"><h3>${escapeHtml(s.title)}</h3><p>Hosted by ${escapeHtml(s.host_name)}</p></div>
    </div>`;
  }
  function endedCardHtml(s) {
    return `<a class="media-card" href="/live/${encodeURIComponent(s.room_code)}/replay">
      <div class="thumb"><span class="badge-kind">Replay</span>&#9654;</div>
      <div class="body"><h3>${escapeHtml(s.title)}</h3><p>Hosted by ${escapeHtml(s.host_name)}</p></div>
    </a>`;
  }

  function renderSection(grid, emptyNote, items, cardFn) {
    if (items.length) {
      grid.innerHTML = items.map(cardFn).join("");
      grid.style.display = "";
      emptyNote.style.display = "none";
    } else {
      grid.innerHTML = "";
      grid.style.display = "none";
      emptyNote.style.display = "";
    }
  }

  function showLiveBanner(title) {
    liveBanner.textContent = `🔴 "${title}" just went live!`;
    liveBanner.classList.remove("hidden");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => liveBanner.classList.add("hidden"), 8000);
  }

  async function pollSessions() {
    let sessions;
    try {
      const res = await fetch("/api/live/sessions");
      if (!res.ok) return;
      sessions = await res.json();
    } catch (e) {
      return; // network hiccup -- just try again on the next tick
    }

    const liveNow = sessions.filter((s) => s.status === "live");
    const scheduled = sessions.filter((s) => s.status === "scheduled");
    const ended = sessions.filter((s) => s.status === "ended" && s.recording_path);

    if (sawFirstPoll) {
      liveNow.forEach((s) => {
        const prev = prevStatuses.get(s.id);
        if (prev && prev !== "live") showLiveBanner(s.title);
      });
    }
    sessions.forEach((s) => prevStatuses.set(s.id, s.status));
    sawFirstPoll = true;

    renderSection(liveNowGrid, liveNowEmpty, liveNow, liveCardHtml);
    renderSection(scheduledGrid, scheduledEmpty, scheduled, scheduledCardHtml);
    renderSection(endedGrid, endedEmpty, ended, endedCardHtml);
  }

  pollSessions();
  setInterval(pollSessions, POLL_MS);
})();
