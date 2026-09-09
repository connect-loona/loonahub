(function () {
  "use strict";

  var queued = false;

  function getRuns() {
    var cache = window._soRunsCache || {};
    return Object.keys(cache).map(function (key) { return cache[key]; });
  }

  function brandName(id) {
    var brand = (window._soBrandsCache || {})[id];
    return brand ? brand.name : id;
  }

  function monthLabel(value) {
    if (!value) return "";
    var parts = value.split("-");
    return new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
      .toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  }

  function actionFor(run) {
    var status = run && run.status;
    if (status === "research_needs_review") return [0, "Your next action", "Review the research", "Review research"];
    if (status === "strategy_needs_review") return [0, "Your next action", "Review the monthly strategy", "Review strategy"];
    if (status === "failed") return [1, "Needs attention", "A strategy run needs help", "See what happened"];
    if (status === "research_changes_requested" || status === "strategy_changes_requested") return [2, "Waiting for revision", "Changes have been sent back", "Open run"];
    if (status === "research_running" || status === "strategy_running" || status === "queued") {
      return [3, "Work in progress", status === "strategy_running" ? "Creating the strategy" : "Research is underway", "View progress"];
    }
    return null;
  }

  function nextActionCard() {
    var choices = getRuns().map(function (run) { return { run: run, action: actionFor(run) }; })
      .filter(function (item) { return item.action; })
      .sort(function (a, b) { return a.action[0] - b.action[0] || (b.run.updatedAt || "").localeCompare(a.run.updatedAt || ""); });
    var choice = choices[0] || null;
    var card = document.createElement("div");
    card.className = "att-board so-next-action";
    card.style.cssText = "padding:18px 20px;border-color:var(--accent);background:linear-gradient(135deg,var(--surface),var(--surface2))";
    var eyebrow = document.createElement("div");
    eyebrow.style.cssText = "font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px";
    eyebrow.textContent = choice ? choice.action[1] : "Your next action";
    card.appendChild(eyebrow);
    var row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap";
    var copy = document.createElement("div");
    var title = document.createElement("div");
    title.style.cssText = "font-size:18px;font-weight:750;margin-bottom:4px";
    title.textContent = choice ? choice.action[2] : "Start next month's strategy";
    var detail = document.createElement("div");
    detail.style.cssText = "font-size:12px;color:var(--muted)";
    detail.textContent = choice
      ? brandName(choice.run.brandId) + " · " + monthLabel(choice.run.month) + (choice.action[0] === 3 ? " · You can leave this page" : "")
      : "Choose a client. The next month is selected automatically.";
    copy.appendChild(title);
    copy.appendChild(detail);
    row.appendChild(copy);
    var button = document.createElement("button");
    button.className = "btn btn-primary";
    button.textContent = choice ? choice.action[3] : "Start a strategy";
    button.addEventListener("click", function () {
      if (choice) window.soOpenRun(choice.run.runId);
      else window.soOpenNewRunModal();
    });
    row.appendChild(button);
    card.appendChild(row);
    return card;
  }

  function simplifyRunsTable(root) {
    var table = root.querySelector("table.att-tbl");
    if (!table || table.dataset.teamSimplified === "1") return;
    var header = table.querySelector("thead tr");
    if (!header || header.children.length !== 7) return;
    Array.from(table.querySelectorAll("tbody tr")).forEach(function (row) {
      if (row.children.length !== 7) return;
      var stage = row.children[2].textContent.trim();
      var stageLine = document.createElement("div");
      stageLine.style.cssText = "font-size:11px;color:var(--muted);margin-top:2px";
      stageLine.textContent = stage;
      row.children[3].style.fontWeight = "650";
      row.children[3].appendChild(stageLine);
      row.removeChild(row.children[2]);
      row.removeChild(row.children[3]);
      var action = row.querySelector("button");
      if (action) action.textContent = "View";
    });
    header.removeChild(header.children[2]);
    header.removeChild(header.children[3]);
    header.children[2].textContent = "Progress";
    header.children[3].textContent = "Updated";
    table.dataset.teamSimplified = "1";
    var title = table.closest(".att-board").querySelector(".bh");
    if (title && title.firstChild) title.firstChild.textContent = "All monthly strategies";
  }

  function updateDuplicateState() {
    var brand = document.getElementById("so-new-brand");
    var month = document.getElementById("so-new-month");
    var submit = document.getElementById("so-new-run-submit");
    if (!brand || !month || !submit) return;
    var existing = getRuns().find(function (run) { return run.brandId === brand.value && run.month === month.value; });
    submit.dataset.existingRunId = existing ? existing.runId : "";
    submit.textContent = existing ? "Open existing strategy" : "Start research";
    var note = document.getElementById("so-existing-run-note");
    if (!note) {
      note = document.createElement("div");
      note.id = "so-existing-run-note";
      note.className = "note";
      note.style.marginBottom = "12px";
      month.insertAdjacentElement("afterend", note);
    }
    note.style.display = existing ? "block" : "none";
    note.textContent = existing ? "A strategy already exists for this client and month. Open it instead of creating a duplicate." : "";
  }

  function simplifyReview(root) {
    Array.from(root.querySelectorAll(".att-board .bh")).forEach(function (heading) {
      if (heading.textContent.trim() === "Decision") heading.textContent = "Review and decide";
    });
    Array.from(root.querySelectorAll("button")).forEach(function (button) {
      if (button.textContent.trim() === "Request changes") button.textContent = "Send back with notes";
      if (/^Approve (Research|Strategy)$/.test(button.textContent.trim())) button.textContent = "Approve & continue";
    });
    var notes = document.getElementById("so-decision-notes");
    if (notes) notes.placeholder = "What should change? Add notes before sending it back.";
  }

  function decorate() {
    queued = false;
    var root = document.getElementById("so-root");
    if (!root || !root.querySelector(".section-title")) return;
    var table = root.querySelector("table.att-tbl");
    if (table) {
      simplifyRunsTable(root);
      if (!root.querySelector(".so-next-action")) {
        var firstBoard = root.querySelector(".att-board");
        if (firstBoard) firstBoard.insertAdjacentElement("beforebegin", nextActionCard());
      }
    }
    simplifyReview(root);
    var brand = document.getElementById("so-new-brand");
    var month = document.getElementById("so-new-month");
    if (brand && brand.dataset.duplicateGuard !== "1") {
      brand.dataset.duplicateGuard = "1";
      brand.addEventListener("change", updateDuplicateState);
    }
    if (month && month.dataset.duplicateGuard !== "1") {
      month.dataset.duplicateGuard = "1";
      month.addEventListener("change", updateDuplicateState);
    }
    updateDuplicateState();
  }

  function queueDecorate() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(decorate);
  }

  window.addEventListener("DOMContentLoaded", function () {
    var originalSubmit = window.soSubmitNewRun;
    if (typeof originalSubmit === "function") {
      window.soSubmitNewRun = function () {
        var submit = document.getElementById("so-new-run-submit");
        if (submit && submit.dataset.existingRunId) {
          var runId = submit.dataset.existingRunId;
          window.soCloseNewRunModal();
          window.soOpenRun(runId);
          return;
        }
        return originalSubmit.apply(this, arguments);
      };
    }
    new MutationObserver(queueDecorate).observe(document.body, { childList: true, subtree: true });
    queueDecorate();
  });
})();

