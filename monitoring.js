/**
 * Loona Hub — Monitoring module
 * Kanban of prior-day pending/overdue tasks + Why Loop (Ask why / SLA / reply / resolve).
 *
 * Discovers Hub globals when present:
 *   TASKS, ALL_MEMBERS, MEMBER_INFO, currentUser, askOverdueWhy,
 *   taskBrandList, normName, showPage
 *
 * Task Board (page-tasks) is left untouched. This only adds page-monitoring.
 */
(function (global) {
  'use strict';

  var LS_KEY = 'loona-monitoring-why-threads-v1';
  var SLA_HOURS = 24;
  var COLUMNS = [
    { key: 'not_started', label: 'Not Started', dot: 'ns' },
    { key: 'progress', label: 'In Progress', dot: 'ip' },
    { key: 'awaiting', label: 'Awaiting Approval', dot: 'aa' },
    { key: 'done', label: 'Done', dot: 'dn' }
  ];

  var state = {
    brand: 'all',
    member: 'all',
    activeTaskKey: null,
    wrappedShowPage: false,
    pollTimer: null,
    lastSig: ''
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function norm(name) {
    if (typeof global.normName === 'function') return global.normName(name);
    return String(name || '').trim().toLowerCase();
  }

  function brandsOf(t) {
    if (typeof global.taskBrandList === 'function') return global.taskBrandList(t) || [];
    if (t && Array.isArray(t.brands) && t.brands.length) return t.brands;
    return t && t.brand ? [t.brand] : [];
  }

  function primaryBrand(t) {
    var list = brandsOf(t);
    return list[0] || '—';
  }

  function taskKey(t) {
    if (!t) return '';
    return t._key || t.id || (String(t.member || '') + '|' + String(t.task || '') + '|' + String(t.due_date || ''));
  }

  function initials(name) {
    var n = String(name || '?').trim();
    if (!n) return '?';
    var parts = n.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
  }

  function memberColor(name) {
    var info = (global.MEMBER_INFO && global.MEMBER_INFO[name]) || {};
    return info.color || '#888';
  }

  function brandClass(b) {
    var x = String(b || '').toLowerCase();
    if (x === 'shic') return 'shic';
    if (x === '2100') return 'b2100';
    if (x === 'rro') return 'rro';
    if (x === 'member' || x === 'loona') return 'member';
    return '';
  }

  function prioClass(p) {
    var x = String(p || '').toLowerCase();
    if (x === 'high' || x === '1') return 'high';
    if (x === 'medium' || x === '2') return 'medium';
    if (x === 'low' || x === '3') return 'low';
    return 'other';
  }

  function colKey(status) {
    var s = String(status || '').trim();
    if (s === 'Completed') return 'done';
    if (s === 'Awaiting Approval' || s === 'Awaiting Deferral' || s === 'Client Approval') return 'awaiting';
    if (s === 'In Progress' || s === 'Changes Required' || s === 'Approval Declined') return 'progress';
    // Not Started, empty, Deferred (if ever included), etc.
    return 'not_started';
  }

  function statusLabel(status) {
    var s = String(status || '').trim();
    return s || 'Not Started';
  }

  function formatDue(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso + 'T12:00:00');
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
      return iso;
    }
  }

  function getTasks() {
    return Array.isArray(global.TASKS) ? global.TASKS : [];
  }

  /**
   * Prior-day pending/overdue pool:
   * - has due_date before today
   * - not Deferred (off the board)
   * Completed stays for Done-column context.
   */
  function monitoringPool() {
    var today = todayISO();
    return getTasks().filter(function (t) {
      if (!t || !t.due_date) return false;
      if (t.due_date >= today) return false;
      if (t.status === 'Deferred') return false;
      return true;
    });
  }

  function isOverdueOpen(t) {
    return t && t.status !== 'Completed' && t.due_date && t.due_date < todayISO();
  }

  function filteredPool() {
    return monitoringPool().filter(function (t) {
      var brand = primaryBrand(t);
      if (state.brand === 'priority') {
        if (String(t.priority || '').toLowerCase() !== 'high') return false;
      } else if (state.brand !== 'all') {
        var hit = brandsOf(t).some(function (b) {
          return String(b).toLowerCase() === String(state.brand).toLowerCase();
        });
        if (!hit) return false;
      }
      if (state.member !== 'all' && norm(t.member) !== norm(state.member)) return false;
      return true;
    });
  }

  function loadThreads() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function saveThreads(map) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(map));
    } catch (e) { /* ignore quota */ }
  }

  function getThread(key) {
    var map = loadThreads();
    return map[key] || null;
  }

  function upsertThread(key, patch) {
    var map = loadThreads();
    var cur = map[key] || { messages: [], askedAt: null, resolved: false };
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
    map[key] = cur;
    saveThreads(map);
    return cur;
  }

  function slaRemaining(askedAt) {
    if (!askedAt) return { text: '⏱ SLA ready', ok: true, hoursLeft: SLA_HOURS };
    var start = new Date(askedAt).getTime();
    var end = start + SLA_HOURS * 3600 * 1000;
    var leftMs = end - Date.now();
    if (leftMs <= 0) return { text: '⏱ SLA breached', ok: false, hoursLeft: 0 };
    var h = Math.floor(leftMs / 3600000);
    var m = Math.floor((leftMs % 3600000) / 60000);
    return {
      text: h > 0 ? ('⏱ ' + h + 'h ' + m + 'm left') : ('⏱ ' + m + 'm left'),
      ok: leftMs > 4 * 3600000,
      hoursLeft: leftMs / 3600000
    };
  }

  function toast(msg) {
    var el = document.getElementById('mon-toast');
    if (!el) {
      // Fall back to Hub completion toast if present
      var hub = document.getElementById('completion-toast');
      if (hub && document.getElementById('toast-msg')) {
        document.getElementById('toast-emoji').textContent = '👁';
        document.getElementById('toast-msg').textContent = msg;
        var sub = document.getElementById('toast-sub');
        if (sub) sub.textContent = 'Monitoring';
        hub.classList.add('show');
        setTimeout(function () { hub.classList.remove('show'); }, 2800);
        return;
      }
      return;
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function callAskOverdueWhy(t) {
    if (typeof global.askOverdueWhy !== 'function') return false;
    var btn = document.createElement('button');
    btn.dataset.member = t.member || '';
    btn.dataset.taskKey = t._key || '';
    btn.dataset.title = t.task || '';
    btn.dataset.brand = primaryBrand(t);
    btn.dataset.assignedBy = t.assigned_by || '';
    try {
      global.askOverdueWhy(btn);
      return true;
    } catch (e) {
      console.warn('[Monitoring] askOverdueWhy failed', e);
      return false;
    }
  }

  function ensureBotSeed(t, thread) {
    if (thread.messages && thread.messages.length) return thread;
    var due = formatDue(t.due_date);
    var msg = {
      role: 'bot',
      author: 'Loona Bot',
      at: new Date().toISOString(),
      text:
        'Hey ' + (t.member || 'there') + ' — **' + (t.task || 'Untitled') + '** (' + primaryBrand(t) +
        ') has been past due (' + due + ') while still ' + statusLabel(t.status) +
        '. What\'s blocking? Reply here so we can unblock or re-route.'
    };
    return upsertThread(taskKey(t), {
      messages: [msg],
      askedAt: thread.askedAt || new Date().toISOString(),
      resolved: false
    });
  }

  function openWhyLoop(t, opts) {
    opts = opts || {};
    if (!t) return;
    var key = taskKey(t);
    state.activeTaskKey = key;

    var thread = getThread(key) || { messages: [], askedAt: null, resolved: false };
    if (opts.ask) {
      var usedHub = callAskOverdueWhy(t);
      if (!thread.askedAt) {
        thread = upsertThread(key, {
          askedAt: new Date().toISOString(),
          resolved: false,
          messages: thread.messages || []
        });
      }
      toast(usedHub
        ? ('Asked ' + (t.member || 'assignee') + ' via Hub Ask why')
        : ('Why Loop opened · ' + (t.member || 'assignee')));
    }

    thread = ensureBotSeed(t, thread);
    renderWhyPanel(t, thread);
    highlightCard(key);

    var panel = document.getElementById('mon-why');
    if (panel) {
      panel.classList.remove('pulse');
      void panel.offsetWidth;
      panel.classList.add('pulse');
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function highlightCard(key) {
    var root = document.getElementById('mon-kanban');
    if (!root) return;
    root.querySelectorAll('.mon-card.highlight').forEach(function (c) {
      c.classList.remove('highlight');
    });
    var card = Array.prototype.find.call(root.querySelectorAll('.mon-card'), function (el) {
      return el.getAttribute('data-key') === key;
    });
    if (card) card.classList.add('highlight');
  }

  function renderMarkdownLite(text) {
    return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  function renderWhyPanel(t, thread) {
    var idle = document.getElementById('mon-why-idle');
    var body = document.getElementById('mon-why-body');
    if (!body) return;
    if (idle) idle.style.display = 'none';
    body.style.display = 'flex';

    var title = document.getElementById('mon-why-title');
    var ctx = document.getElementById('mon-why-context');
    var slaChip = document.getElementById('mon-sla-chip');
    var threadEl = document.getElementById('mon-thread');
    var replyBox = document.getElementById('mon-reply');
    var label = document.getElementById('mon-why-label');

    if (label) {
      label.textContent = thread.resolved ? 'Why Loop · Resolved' : 'Why Loop · Open thread';
    }
    if (title) {
      title.textContent =
        'Ask ' + (t.member || 'assignee') + ' why — ' +
        (t.task || 'Untitled') +
        (isOverdueOpen(t) ? ' overdue' : '') +
        (colKey(t.status) === 'awaiting' ? ' awaiting approval' : '');
    }
    if (ctx) {
      ctx.innerHTML =
        '<span class="mon-brand ' + brandClass(primaryBrand(t)) + '">' + esc(primaryBrand(t)) + '</span>' +
        '&nbsp; ' + esc(t.task || 'Untitled') +
        ' · Due ' + esc(formatDue(t.due_date)) +
        ' · Status: ' + esc(statusLabel(t.status));
    }

    var sla = slaRemaining(thread.resolved ? null : thread.askedAt);
    if (slaChip) {
      slaChip.textContent = thread.resolved ? '✓ Resolved' : sla.text;
      slaChip.classList.toggle('ok', !!(thread.resolved || sla.ok));
    }

    if (threadEl) {
      var msgs = (thread.messages || []).map(function (m) {
        var role = m.role === 'human' ? 'human' : 'bot';
        var av = role === 'bot'
          ? '<div class="mon-avatar" style="background:linear-gradient(135deg,var(--accent,#ff6d29),var(--accent2,#ff9457));color:#0a0503">L</div>'
          : '<div class="mon-avatar" style="background:' + esc(memberColor(m.author || t.member)) + '">' + esc(initials(m.author || t.member)) + '</div>';
        var when = '';
        try {
          when = new Date(m.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        } catch (e) { when = ''; }
        return (
          '<div class="mon-msg ' + role + '">' + av +
          '<div class="mon-msg-bubble"><div class="mon-msg-meta">' + esc(m.author || (role === 'bot' ? 'Loona Bot' : 'Reply')) +
          (when ? ' · ' + esc(when) : '') + '</div>' + renderMarkdownLite(m.text || '') + '</div></div>'
        );
      }).join('');

      var waiting = '';
      if (!thread.resolved) {
        var hasHuman = (thread.messages || []).some(function (m) { return m.role === 'human'; });
        if (!hasHuman) {
          waiting =
            '<div class="mon-empty-reply" id="mon-empty-reply">' +
            '<strong>Waiting for ' + esc(t.member || 'assignee') + '\'s reply</strong>' +
            'No response yet · SLA ticking</div>';
        }
      }

      threadEl.innerHTML = msgs + waiting;
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    if (replyBox) {
      replyBox.value = '';
      replyBox.placeholder = 'Type a reply as ' + (t.member || 'assignee') + '…';
      replyBox.disabled = !!thread.resolved;
    }
    var sendBtn = document.getElementById('mon-btn-send');
    var resolveBtn = document.getElementById('mon-btn-resolve');
    if (sendBtn) sendBtn.disabled = !!thread.resolved;
    if (resolveBtn) resolveBtn.disabled = !!thread.resolved;
  }

  function showWhyIdle() {
    state.activeTaskKey = null;
    var idle = document.getElementById('mon-why-idle');
    var body = document.getElementById('mon-why-body');
    if (idle) idle.style.display = 'block';
    if (body) body.style.display = 'none';
  }

  function renderCard(t) {
    var key = taskKey(t);
    var overdue = isOverdueOpen(t);
    var thread = getThread(key);
    var asked = !!(thread && thread.askedAt && !thread.resolved);
    var showAsk = t.status !== 'Completed';
    var askLabel = asked ? 'Why Loop' : 'Ask why';
    var ask =
      showAsk
        ? '<div class="mon-card-actions"><button type="button" class="mon-ask-why" data-ask="' + esc(key) + '">' + askLabel + '</button></div>'
        : '';
    var brand = primaryBrand(t);
    return (
      '<article class="mon-card" data-key="' + esc(key) + '" data-brand="' + esc(brand) + '">' +
      '<div class="mon-card-top">' +
      '<span class="mon-brand ' + brandClass(brand) + '">' + esc(brand) + '</span>' +
      '<span class="mon-prio ' + prioClass(t.priority) + '" title="' + esc(t.priority || '') + '"></span>' +
      '</div>' +
      '<div class="mon-card-title">' + esc(t.task || 'Untitled') + '</div>' +
      '<div class="mon-card-footer">' +
      '<div class="mon-assignee"><span class="mon-avatar" style="background:' + esc(memberColor(t.member)) + '">' +
      esc(initials(t.member)) + '</span>' + esc(t.member || 'Unassigned') + '</div>' +
      '<span class="mon-due' + (overdue ? ' overdue' : '') + '">' +
      (overdue ? 'Overdue · ' : '') + esc(formatDue(t.due_date)) + '</span>' +
      '</div>' + ask + '</article>'
    );
  }

  function updateMeta(pool) {
    var pending = pool.filter(function (t) { return t.status !== 'Completed'; });
    var overdue = pending.filter(isOverdueOpen);
    var c = document.getElementById('mon-count');
    var o = document.getElementById('mon-overdue');
    if (c) c.textContent = String(pending.length);
    if (o) o.textContent = String(overdue.length);
  }

  function renderKanban() {
    var pool = filteredPool();
    updateMeta(pool);
    var root = document.getElementById('mon-kanban');
    if (!root) return;

    root.innerHTML = COLUMNS.map(function (col) {
      var cards = pool.filter(function (t) { return colKey(t.status) === col.key; });
      // Sort: overdue first, then oldest due
      cards.sort(function (a, b) {
        var ao = isOverdueOpen(a) ? 0 : 1;
        var bo = isOverdueOpen(b) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return String(a.due_date).localeCompare(String(b.due_date));
      });
      return (
        '<section class="mon-col" data-col="' + col.key + '">' +
        '<div class="mon-col-header"><div class="mon-col-title">' +
        '<span class="mon-col-dot ' + col.dot + '"></span>' + esc(col.label) +
        '</div><span class="mon-count">' + cards.length + '</span></div>' +
        '<div class="mon-col-body">' +
        (cards.length ? cards.map(renderCard).join('') : '<div class="mon-empty-col">No tasks</div>') +
        '</div></section>'
      );
    }).join('');

    root.querySelectorAll('[data-ask]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var t = findTaskByKey(btn.getAttribute('data-ask'));
        if (t) openWhyLoop(t, { ask: true });
      });
    });
    root.querySelectorAll('.mon-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var t = findTaskByKey(card.getAttribute('data-key'));
        if (!t) return;
        openWhyLoop(t, { ask: false });
      });
    });

    if (state.activeTaskKey) {
      var active = findTaskByKey(state.activeTaskKey);
      if (active) {
        var th = getThread(state.activeTaskKey) || { messages: [], askedAt: null, resolved: false };
        renderWhyPanel(active, th);
        highlightCard(state.activeTaskKey);
      } else {
        showWhyIdle();
      }
    }
  }

  function findTaskByKey(key) {
    return getTasks().find(function (t) { return taskKey(t) === key; }) || null;
  }

  function buildFilterChips() {
    var pool = monitoringPool();
    var brandSet = {};
    pool.forEach(function (t) {
      brandsOf(t).forEach(function (b) {
        if (b) brandSet[b] = true;
      });
    });
    // Prefer a stable short list; fall back to discovered brands
    var preferred = ['Shic', '2100', 'RRO', 'Member', 'Loona', 'Shookra'];
    var brands = preferred.filter(function (b) { return brandSet[b]; });
    Object.keys(brandSet).sort().forEach(function (b) {
      if (brands.indexOf(b) < 0 && brands.length < 10) brands.push(b);
    });

    var brandEl = document.getElementById('mon-brand-filters');
    if (brandEl) {
      brandEl.innerHTML =
        '<button type="button" class="mon-chip' + (state.brand === 'all' ? ' active' : '') + '" data-brand="all">All Brands</button>' +
        brands.map(function (b) {
          return '<button type="button" class="mon-chip' + (state.brand === b ? ' active' : '') + '" data-brand="' + esc(b) + '">' + esc(b) + '</button>';
        }).join('') +
        '<button type="button" class="mon-chip' + (state.brand === 'priority' ? ' active' : '') + '" data-brand="priority">Priority</button>';
    }

    var members = [];
    if (Array.isArray(global.ALL_MEMBERS) && global.ALL_MEMBERS.length) {
      members = global.ALL_MEMBERS.slice();
    } else {
      var seen = {};
      pool.forEach(function (t) {
        if (t.member && !seen[t.member]) { seen[t.member] = true; members.push(t.member); }
      });
      members.sort();
    }
    // Only show members who appear in the pool (plus keep a short list)
    var inPool = {};
    pool.forEach(function (t) { if (t.member) inPool[norm(t.member)] = t.member; });
    var memberChips = members.filter(function (m) { return inPool[norm(m)]; });
    if (!memberChips.length) {
      memberChips = Object.keys(inPool).map(function (k) { return inPool[k]; });
    }

    var memEl = document.getElementById('mon-member-filters');
    if (memEl) {
      memEl.innerHTML =
        '<button type="button" class="mon-chip' + (state.member === 'all' ? ' active' : '') + '" data-member="all">All members</button>' +
        memberChips.map(function (m) {
          return '<button type="button" class="mon-chip' + (norm(state.member) === norm(m) ? ' active' : '') + '" data-member="' + esc(m) + '">' + esc(m) + '</button>';
        }).join('');
    }
  }

  function bindFilters() {
    var brandEl = document.getElementById('mon-brand-filters');
    var memEl = document.getElementById('mon-member-filters');
    if (brandEl && !brandEl._monBound) {
      brandEl._monBound = true;
      brandEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.mon-chip');
        if (!btn) return;
        state.brand = btn.getAttribute('data-brand') || 'all';
        brandEl.querySelectorAll('.mon-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        renderKanban();
      });
    }
    if (memEl && !memEl._monBound) {
      memEl._monBound = true;
      memEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.mon-chip');
        if (!btn) return;
        state.member = btn.getAttribute('data-member') || 'all';
        memEl.querySelectorAll('.mon-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        renderKanban();
      });
    }
  }

  function bindCompose() {
    var send = document.getElementById('mon-btn-send');
    var resolve = document.getElementById('mon-btn-resolve');
    var cancel = document.getElementById('mon-btn-cancel');
    if (send && !send._monBound) {
      send._monBound = true;
      send.addEventListener('click', function () {
        var key = state.activeTaskKey;
        var t = findTaskByKey(key);
        if (!t) { toast('Select a task first'); return; }
        var box = document.getElementById('mon-reply');
        var text = box ? box.value.trim() : '';
        if (!text) { toast('Type a reply first'); return; }
        var thread = getThread(key) || { messages: [], askedAt: new Date().toISOString(), resolved: false };
        var msgs = (thread.messages || []).slice();
        msgs.push({
          role: 'human',
          author: t.member || global.currentUser || 'Reply',
          at: new Date().toISOString(),
          text: text
        });
        thread = upsertThread(key, { messages: msgs, askedAt: thread.askedAt || new Date().toISOString() });
        if (box) box.value = '';
        renderWhyPanel(t, thread);
        toast('Reply saved · Why Loop updated');
      });
    }
    if (resolve && !resolve._monBound) {
      resolve._monBound = true;
      resolve.addEventListener('click', function () {
        var key = state.activeTaskKey;
        var t = findTaskByKey(key);
        if (!t) { toast('Select a task first'); return; }
        var thread = getThread(key) || { messages: [], askedAt: null, resolved: false };
        var msgs = (thread.messages || []).slice();
        msgs.push({
          role: 'bot',
          author: 'Loona Bot',
          at: new Date().toISOString(),
          text: 'Thread resolved. ' + (t.member || 'Assignee') + ' unblocked — task stays on Monitoring; Ask-why closed.'
        });
        thread = upsertThread(key, { messages: msgs, resolved: true });
        renderWhyPanel(t, thread);
        renderKanban();
        toast('Why Loop resolved');
      });
    }
    if (cancel && !cancel._monBound) {
      cancel._monBound = true;
      cancel.addEventListener('click', function () {
        showWhyIdle();
        var root = document.getElementById('mon-kanban');
        if (root) root.querySelectorAll('.mon-card.highlight').forEach(function (c) { c.classList.remove('highlight'); });
      });
    }

    var escalate = document.getElementById('mon-btn-escalate');
    var askAll = document.getElementById('mon-btn-ask-all');
    if (escalate && !escalate._monBound) {
      escalate._monBound = true;
      escalate.addEventListener('click', function () {
        var overdue = filteredPool().filter(isOverdueOpen);
        toast('Escalation digest · ' + overdue.length + ' overdue (local)');
      });
    }
    if (askAll && !askAll._monBound) {
      askAll._monBound = true;
      askAll.addEventListener('click', function () {
        var overdue = filteredPool().filter(isOverdueOpen);
        var n = 0;
        overdue.forEach(function (t) {
          var key = taskKey(t);
          var th = getThread(key);
          if (th && th.askedAt && !th.resolved) return;
          callAskOverdueWhy(t);
          upsertThread(key, {
            askedAt: (th && th.askedAt) || new Date().toISOString(),
            resolved: false,
            messages: (th && th.messages) || []
          });
          ensureBotSeed(t, getThread(key) || {});
          n++;
        });
        renderKanban();
        toast(n ? ('Asked why on ' + n + ' overdue') : 'No new overdue to ask');
      });
    }
  }

  function poolSignature() {
    try {
      return monitoringPool().map(function (t) {
        return taskKey(t) + ':' + (t.status || '') + ':' + (t.due_date || '');
      }).join('|');
    } catch (e) {
      return String(Date.now());
    }
  }

  function render() {
    var page = document.getElementById('page-monitoring');
    if (!page) return;
    buildFilterChips();
    bindFilters();
    bindCompose();
    renderKanban();
    if (!state.activeTaskKey) showWhyIdle();
    state.lastSig = poolSignature();
  }

  function startPoll() {
    if (state.pollTimer) return;
    if (typeof setInterval !== 'function') return;
    state.pollTimer = setInterval(function () {
      var page = document.getElementById('page-monitoring');
      if (!page || !page.classList.contains('active')) return;
      var sig = poolSignature();
      if (sig !== state.lastSig) {
        state.lastSig = sig;
        renderKanban();
        buildFilterChips();
        bindFilters();
      }
    }, 4000);
  }

  function wrapShowPage() {
    if (state.wrappedShowPage) return;
    var orig = global.showPage;
    if (typeof orig !== 'function') {
      // Hub script may not be ready yet
      return;
    }
    state.wrappedShowPage = true;
    global.showPage = function (id, btn) {
      if (id === 'monitoring') {
        document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
        document.querySelectorAll('.nav-btn').forEach(function (b) { b.classList.remove('active'); });
        var page = document.getElementById('page-monitoring');
        if (page) page.classList.add('active');
        if (btn) btn.classList.add('active');
        // Mobile nav: close drawer if open
        var nav = document.querySelector('.topbar .nav');
        if (nav) nav.classList.remove('nav-open');
        render();
        startPoll();
        return;
      }
      return orig.apply(this, arguments);
    };
  }

  function init() {
    wrapShowPage();
    // Retry wrap if Hub's showPage loads after us (should not — we load last)
    if (!state.wrappedShowPage && typeof setInterval === 'function') {
      var tries = 0;
      var t = setInterval(function () {
        wrapShowPage();
        tries++;
        if (state.wrappedShowPage || tries > 40) clearInterval(t);
      }, 250);
    }
    startPoll();
  }

  global.LoonaMonitoring = {
    render: render,
    openWhyLoop: function (key) {
      var t = findTaskByKey(key);
      if (t) openWhyLoop(t, { ask: true });
    },
    init: init
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
