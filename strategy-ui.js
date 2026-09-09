(function () {
  "use strict";

  var queued = false;

  function htmlEscape(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

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

  function addBrandFolderAccess(root) {
    var driveInput = document.getElementById("so-bf-drive");
    if (driveInput && !root.querySelector(".so-brand-folder-card")) {
      var originalLabel = driveInput.previousElementSibling;
      var card = document.createElement("div");
      card.className = "att-board so-brand-folder-card";
      card.style.borderColor = "var(--accent)";
      var heading = document.createElement("div");
      heading.className = "bh";
      heading.textContent = "Master brand folder";
      var help = document.createElement("div");
      help.style.cssText = "font-size:12px;color:var(--muted);margin-bottom:10px";
      help.textContent = "Add the main folder containing logos, brand guidelines, design files, photos, videos and other working assets.";
      var label = document.createElement("label");
      label.style.cssText = "display:block;font-size:11px;color:var(--muted);margin-bottom:4px";
      label.textContent = "Google Drive folder link";
      driveInput.placeholder = "Paste the master brand folder link";
      driveInput.style.marginBottom = "0";
      card.appendChild(heading);
      card.appendChild(help);
      card.appendChild(label);
      card.appendChild(driveInput);
      var firstBoard = root.querySelector(".att-board");
      if (firstBoard) firstBoard.insertAdjacentElement("beforebegin", card);
      if (originalLabel && originalLabel.tagName === "LABEL") originalLabel.remove();
    }

    var advanced = document.getElementById("so-bf-advanced");
    if (advanced && !advanced.dataset.approvedWorkReady) {
      try {
        var value = JSON.parse(advanced.value || "{}");
        var brandId = window._soBrandView;
        var brandConfig = brandId && window._soBrandsCache && window._soBrandsCache[brandId];
        value.approvedWork = (brandConfig && brandConfig.approvedWork) || value.approvedWork || [];
        advanced.value = JSON.stringify(value, null, 2);
        advanced.dataset.approvedWorkReady = "1";
      } catch (_) {}

      var libraryHelp = document.createElement("div");
      libraryHelp.style.cssText = "font-size:12px;color:var(--muted);margin:8px 0 12px;line-height:1.5";
      libraryHelp.innerHTML = "Add final approved decks, designs and edited videos under <code>approvedWork</code>. Include month, type, title, link, a short note on the execution, and the outcome. These references become memory for Research and Strategy.";
      advanced.parentNode.insertBefore(libraryHelp, advanced);
    }

    if (!driveInput && window._soCurrentRun && !root.querySelector(".so-run-folder-link")) {
      var brand = (window._soBrandsCache || {})[window._soCurrentRun.brandId];
      if (!brand || !brand.driveFolderUrl) return;
      var header = root.querySelector(".section-header");
      if (!header) return;
      var link = document.createElement("a");
      link.className = "btn btn-ghost so-run-folder-link";
      link.href = brand.driveFolderUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open brand folder";
      header.appendChild(link);
    }
  }

  function ensureWorkspaceStyles() {
    if (document.getElementById("so-workspace-styles")) return;
    var style = document.createElement("style");
    style.id = "so-workspace-styles";
    style.textContent = [
      ".so-stage-rail{display:flex;align-items:center;gap:8px;margin:12px 0 18px;padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}",
      ".so-stage-step{display:flex;align-items:center;gap:7px;min-width:0;color:var(--muted);font-size:12px;font-weight:650}",
      ".so-stage-step:after{content:'';width:26px;height:1px;background:var(--border);margin-left:4px}",
      ".so-stage-step:last-child:after{display:none}",
      ".so-stage-num{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--surface2);border:1px solid var(--border);font-size:11px}",
      ".so-stage-step.is-active{color:var(--accent)} .so-stage-step.is-active .so-stage-num{background:var(--accent);color:#fff;border-color:var(--accent)}",
      ".so-stage-step.is-done{color:var(--green)} .so-stage-step.is-done .so-stage-num{border-color:var(--green)}",
      ".so-workspace{display:grid;grid-template-columns:minmax(180px,220px) minmax(0,1fr) minmax(230px,280px);gap:14px;align-items:start}",
      ".so-workspace-side{position:sticky;top:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:15px}",
      ".so-workspace-main{min-width:0}.so-workspace-main>.att-board:first-child{margin-top:0}",
      ".so-memory-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 0 6px}",
      ".so-memory-value{font-size:12px;line-height:1.45}",
      ".so-memory-link{display:block;padding:8px 0;border-bottom:1px solid var(--border);color:var(--text);font-size:12px;text-decoration:none}",
      ".so-memory-link span{display:block;color:var(--muted);font-size:10px;margin-top:2px}",
      ".so-review-panel .att-board{margin:0}.so-review-panel textarea{min-height:120px!important}.so-review-panel .att-board>div:last-child{flex-direction:column}",
      "@media(max-width:1050px){.so-workspace{grid-template-columns:190px minmax(0,1fr)}.so-review-panel{grid-column:1/-1;position:static}.so-review-panel .att-board>div:last-child{flex-direction:row}}",
      "@media(max-width:720px){.so-stage-rail{overflow-x:auto}.so-stage-step{white-space:nowrap}.so-workspace{display:block}.so-workspace-side{position:static;margin-bottom:12px}.so-review-panel{margin-top:12px}}"
    ].join("");
    document.head.appendChild(style);
  }

  function stageRail(run) {
    var stages = ["Research", "Strategy", "Copy", "Creative direction", "Canva deck"];
    var current = run.status && run.status.indexOf("strategy") === 0 ? 1 : 0;
    if (run.status && (run.status.indexOf("copy") === 0 || run.status === "strategy_approved")) current = 2;
    var rail = document.createElement("div");
    rail.className = "so-stage-rail";
    rail.innerHTML = stages.map(function (label, index) {
      var cls = index < current ? " is-done" : index === current ? " is-active" : "";
      return '<div class="so-stage-step'+cls+'"><span class="so-stage-num">'+(index < current ? "✓" : index + 1)+'</span><span>'+label+'</span></div>';
    }).join("");
    return rail;
  }

  function brandMemory(run) {
    var brand = (window._soBrandsCache || {})[run.brandId] || {};
    var side = document.createElement("aside");
    side.className = "so-workspace-side";
    var works = (brand.approvedWork || []).slice().sort(function (a, b) { return (b.month || "").localeCompare(a.month || ""); }).slice(0, 4);
    side.innerHTML = '<div class="bh">Brand memory</div>'+ 
      '<div class="so-memory-label">Brand truth</div><div class="so-memory-value">'+htmlEscape(brand.oneLineTruth || "Add the brand truth in Manage brands.")+'</div>'+ 
      '<div class="so-memory-label">Audience</div><div class="so-memory-value">'+htmlEscape((brand.audiences || []).map(function (a) { return a.description; }).slice(0, 2).join(" · ") || "Not configured")+'</div>'+ 
      '<div class="so-memory-label">Approved work</div>'+ 
      (works.length ? works.map(function (work) { return '<a class="so-memory-link" href="'+htmlEscape(work.url)+'" target="_blank" rel="noopener noreferrer">'+htmlEscape(work.title)+'<span>'+htmlEscape(work.month)+' · '+htmlEscape(work.type)+'</span></a>'; }).join("") : '<div class="so-memory-value" style="color:var(--muted)">Add final decks, designs and videos in Manage brands.</div>')+
      (brand.driveFolderUrl ? '<a class="btn btn-ghost" href="'+htmlEscape(brand.driveFolderUrl)+'" target="_blank" rel="noopener noreferrer" style="margin-top:14px;width:100%;text-align:center">Open brand folder</a>' : "");
    return side;
  }

  function buildWorkspace(root) {
    var run = window._soCurrentRun;
    if (!run || root.dataset.workspaceReady === "1") return;
    var header = root.querySelector(".section-header");
    if (!header) return;
    ensureWorkspaceStyles();
    var oldStrip = header.nextElementSibling;
    if (oldStrip && !oldStrip.classList.contains("att-board")) oldStrip.style.display = "none";
    var rail = stageRail(run);
    header.insertAdjacentElement("afterend", rail);
    var workspace = document.createElement("div");
    workspace.className = "so-workspace";
    var main = document.createElement("main");
    main.className = "so-workspace-main";
    var review = document.createElement("aside");
    review.className = "so-workspace-side so-review-panel";
    Array.from(root.children).forEach(function (child) {
      if (child === header || child === oldStrip || child === rail || child === workspace) return;
      var heading = child.querySelector && child.querySelector(".bh");
      if (heading && heading.textContent.trim() === "Review and decide") review.appendChild(child);
      else main.appendChild(child);
    });
    if (!review.children.length) review.innerHTML = '<div class="bh">Review status</div><div class="so-memory-value" style="color:var(--muted)">This stage is already approved or still running.</div>';
    workspace.appendChild(brandMemory(run));
    workspace.appendChild(main);
    workspace.appendChild(review);
    root.appendChild(workspace);
    var headerFolder = header.querySelector(".so-run-folder-link");
    if (headerFolder) headerFolder.remove();
    root.dataset.workspaceReady = "1";
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
    addBrandFolderAccess(root);
    buildWorkspace(root);
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

