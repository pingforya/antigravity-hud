/*
 * Native Swarm Board frontend. Shows only the swarm of the conversation this
 * pane belongs to: polls /api/swarm, which re-resolves that conversation on
 * every call, and renders overview/board/members/graph/raw, or an empty state
 * when the conversation has no swarm.
 *
 * The Overview tab shows the narrator's view (view.json + view.html, written
 * by the swarm's narrator member) inside trusted chrome. The narrator's HTML
 * is untrusted: it runs only in a sandboxed srcdoc frame (scripts, no same
 * origin, no network via CSP), talks to this page only through a small
 * validated postMessage protocol, and can always be replaced by the plain
 * view, which renders the same (validated) view.json here.
 */
(() => {
  const POLL_MS = 1500;       // live refresh while a swarm is shown
  const IDLE_POLL_MS = 3000;  // re-resolve cadence while there is no swarm
  const $ = (id) => document.getElementById(id);
  function lsGet(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function lsSet(k, v) {
    try {
      if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch {
      // Storage can be unavailable in the host's iframe; preferences still work for this load.
    }
  }
  let lastFeedHtml = '';
  const state = {
    conv: null,       // conversation the shown data was resolved for
    swarm: null,      // coordinator conversation id of the shown swarm
    view: 'loading',  // loading | board | empty
    etag: '',
    snap: null,
    me: null,  // roster name of the current conversation
    seenSeqs: new Set(),
    firstLoad: true,
    hiddenAgents: new Set(),
    // The channel the feed narrows to: '' for every channel, 'main', or a
    // channel name. Only offered once the swarm has a non-main channel.
    channel: '',
    // Killed members are hidden from the Members tab unless the user asks.
    // The Overview is the default tab; without a narrator (or before it has
    // published) the pane falls back to the Board until the user picks a tab.
    tab: 'feed',
    tabChosen: false,
    newEdgeKeys: new Set(),
    lastOk: 0,
    expanded: new Set(),
    rawKind: 'members',
    // Whether the board feed is pinned to its newest post. Starts true so the
    // board opens on the latest posts; the user scrolling away clears it and
    // scrolling back to the bottom sets it again.
    stick: true,
  };
  // The page itself decides where the feed starts (at the newest post).
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab');
  const urlTabChosen = !!(initialTab && document.querySelector(`.tab[data-tab="${CSS.escape(initialTab)}"]`));
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  // GET routes bypass token auth, so plain fetch works both in the iframe and standalone.
  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  // ---------- theme ----------
  // preload.js writes the host's tokens onto :root. Mark the root light/dark
  // from --background's luminance so native controls and status hues follow.
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    // "rgb(r, g, b)" is 0-255; "color(srgb r g b)" is 0-1.
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  }
  syncScheme();
  // Theme changes are forwarded to the narrator frame too (postTheme is
  // defined below; the observer only fires after startup).
  new MutationObserver(() => {
    syncScheme();
    postTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS_LABEL = { working: '工作中', waiting: '等待中', killed: '已终止' };
  const statusLabel = (st) => STATUS_LABEL[st] || st || '';
  const STATUS_TIP = {
    working: '工作中：正在执行回合（思考中、调用工具或等待模型响应）',
    waiting: '等待中：当前回合已结束，正在看板等待新消息唤醒',
    killed: '已终止：已从 Swarm 中移除',
  };
  const ROLE_LABEL = { coordinator: '协调者', worker: '执行者', narrator: '讲述者', monitor: '监控者' };
  const roleLabel = (r) => ROLE_LABEL[r] || r || '';
  const members = () => state.snap?.members || [];
  const memberOf = (name) => members().find((m) => m.name === name);
  const memberByLower = (lower) => members().find((m) => m.name.toLowerCase() === lower);
  // Board times are "YYYY-MM-DD HH:MM:SS" in the LS host's local time, which
  // can differ from this browser's zone (e.g. a UTC remote host viewed from a
  // laptop). The server resolves them to epoch ms (m.ts) on the LS host; the raw
  // string is only parsed here as a fallback.
  const parseTime = (t) => (t ? Date.parse(t.replace(' ', 'T')) : NaN);
  const msgMs = (m) => (Number.isFinite(m?.ts) ? m.ts : parseTime(m?.time));
  const isoTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const opts = { hour: 'numeric', minute: '2-digit' };
    if (!sameDay(d, new Date())) Object.assign(opts, { month: 'short', day: 'numeric' });
    return d.toLocaleString('zh-CN', opts);
  }
  // Full date and time for tooltips.
  const fmtFull = (ms) => (Number.isFinite(ms) ?
    new Date(ms).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }) : '');
  function fmtDur(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return `${s}秒`;
    if (s < 3600)
      return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
    return `${Math.floor(s / 3600)}小时${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}分`;
  }

  // Inline icons (16px grid, stroke = currentColor).
  const ICON = {
    play: '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path class="fill" d="M5 3.6v8.8a.5.5 0 0 0 .76.43l7-4.4a.5.5 0 0 0 0-.86l-7-4.4A.5.5 0 0 0 5 3.6z"/></svg>',
    pause: '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect class="fill" x="4" y="3.5" width="2.75" height="9" rx=".75"/><rect class="fill" x="9.25" y="3.5" width="2.75" height="9" rx=".75"/></svg>',
    arrow: '<svg class="icon arrow" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9.5M9 4.5 12.5 8 9 11.5"/></svg>',
    open: '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M7 3.5H4.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9"/><path d="M9.5 3.5h3v3M12.5 3.5 7.5 8.5"/></svg>',
    search: '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.25 3.25"/></svg>',
    inbox: '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 9.5 4 4a1 1 0 0 1 1-.75h6a1 1 0 0 1 1 .75l1.5 5.5v2.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M2.5 9.5h3l1 1.5h3l1-1.5h3"/></svg>',
  };

  // Collapse complete numbered groups (e.g. researcher-1..N when all N are
  // mentioned) into their shared prefix ("researcher") for the row header.
  function collapseRecipientGroups(names) {
    const set = new Set(names);
    const groups = new Map();
    for (const mem of members()) {
      const match = mem.name.match(/^(.+)-\d+$/);
      if (!match) continue;
      const prefix = match[1];
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push(mem.name);
    }
    const collapsed = new Set();
    const out = [];
    for (const n of names) {
      const match = n.match(/^(.+)-\d+$/);
      const prefix = match?.[1];
      const group = prefix ? groups.get(prefix) : null;
      if (group && group.length >= 2 && group.every((g) => set.has(g))) {
        if (!collapsed.has(prefix)) {
          collapsed.add(prefix);
          out.push(prefix);
        }
      } else {
        out.push(n);
      }
    }
    return out;
  }

  // Recipients of a post, as quiet "@name" text for the row header.
  function recipientsHtml(m) {
    const names = collapseRecipientGroups((m.mentions || []).filter((n) => n !== m.agent));
    const parts = names.map((n) => `<span>@${esc(n)}</span>`);
    for (const c of m.channel_mentions || []) parts.push(`<span>@#${esc(c)}</span>`);
    if (m.all) parts.push('<span>@all</span>');
    return parts.length ? `<span class="msg-to">${ICON.arrow}${parts.join('')}</span>` : '';
  }

  // Highlight @name the way board/mentions.go matches it: "@" at a word start,
  // followed by a roster name or numbered group prefix (case-insensitive) and
  // then a non-name rune. Allow CJK characters adjacent to @name, @#channel,
  // and #seq without over-capturing CJK runes into the identifier.
  const CJK_CHAR = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
  const MENTION_RE = new RegExp(`(^|[^\\p{L}\\p{N}_-]|[${CJK_CHAR}])@((?:(?![${CJK_CHAR}])[\\p{L}\\p{N}_-])+)`, 'gu');
  // "@#channel": highlighted when it names one of the swarm's channels (the
  // server decides whom it calls on: m.via_channel).
  const CHANNEL_MENTION_RE = new RegExp(`(^|[^\\p{L}\\p{N}_-]|[${CJK_CHAR}])@#([a-z][a-z0-9-]{0,23})(?!(?![${CJK_CHAR}])[\\p{L}\\p{N}_-])`, 'giu');
  function highlightChannelMentions(html) {
    if (!hasChannels()) return html;
    return html.replace(CHANNEL_MENTION_RE, (all, pre, name) => {
      const c = swarmChannels().find((x) => x.name === name.toLowerCase());
      if (!c) return all;
      const tip = c.archived ? `#${c.name} 已归档：此提及不会通知任何人` : `#${c.name} 中的所有成员`;
      return `${pre}<span class="mention channel${c.archived ? ' archived' : ''}" title="${esc(tip)}">@#${name}</span>`;
    });
  }
  function highlightMentions(html) {
    html = highlightChannelMentions(html);
    return html.replace(MENTION_RE, (all, pre, name) => {
      const lower = name.toLowerCase();
      if (lower === 'all') return `${pre}<span class="mention all">@${name}</span>`;
      const m = memberByLower(lower);
      if (m) {
        return `${pre}<span class="mention" title="${esc(m.name)} · ${esc(statusLabel(m.status))}">@${name}</span>`;
      }
      const group = members().filter((mem) => {
        const match = mem.name.toLowerCase().match(/^(.+)-\d+$/);
        return match && match[1] === lower;
      });
      if (group.length) {
        const tip = group.map((mem) => mem.name).join(', ');
        return `${pre}<span class="mention" title="${esc(tip)}">@${name}</span>`;
      }
      return all;
    });
  }

  // Render #<digits> sequence references in post bodies as clickable citation
  // pills that jump to and highlight message #<seq> in the Board tab. Runs on
  // already-escaped HTML; excludes "&#39;" entities and URL/word fragments.
  const CITATION_RE = new RegExp(`(^|[^\\p{L}\\p{N}_&#/-]|[${CJK_CHAR}])#([1-9]\\d{0,8})(?!(?![${CJK_CHAR}])[\\p{L}\\p{N}_-])`, 'gu');
  function highlightCitations(html) {
    return html
      .replace(CITATION_RE, (all, pre, digits) => {
        const seq = Number(digits);
        if (!Number.isInteger(seq) || seq <= 0) return all;
        const target = state.snap?.messages?.find((m) => m.seq === seq);
        const tip = target ? `跳转到 #${seq}（${target.agent}）` : `跳转到 #${seq}`;
        return `${pre}<button type="button" class="ref seq-ref" data-seq-ref="${seq}" data-ov-seq="${seq}" data-testid="swarm-seq-ref" title="${esc(tip)}">#${seq}</button>`;
      })
      .replace(/<code>(<button\b[^>]*\bseq-ref\b[^>]*>#[0-9]+<\/button>)<\/code>/g, '<code class="seq-ref-only">$1</code>');
  }

  // Minimal, escape-first markdown renderer (headings, lists, code, bold, italics) + mentions + #seq citations.
  const URL_PROTO_RE = /(?:https?|file):\/\//gi;
  const URL_SAFE_CHAR_RE = /^[^\s<>"'`*()（）[\]【】，。；：、！？\uE000\uE001]$/;
  function maskBalancedUrls(text, onUrl) {
    URL_PROTO_RE.lastIndex = 0;
    let m = URL_PROTO_RE.exec(text);
    if (!m) return text;
    let matchClose = null;
    if (text.includes('(')) {
      matchClose = new Int32Array(text.length);
      matchClose.fill(-1);
      const stack = [];
      for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if (ch === '(') stack.push(k);
        else if (ch === ')') {
          if (stack.length) matchClose[stack.pop()] = k;
        } else if (!URL_SAFE_CHAR_RE.test(ch)) {
          stack.length = 0;
        }
      }
    }
    let out = '';
    let cursor = 0;
    while (m) {
      const start = m.index;
      if (start < cursor) {
        m = URL_PROTO_RE.exec(text);
        continue;
      }
      if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) {
        m = URL_PROTO_RE.exec(text);
        continue;
      }
      const afterProto = start + m[0].length;
      if (afterProto >= text.length || !URL_SAFE_CHAR_RE.test(text[afterProto])) {
        m = URL_PROTO_RE.exec(text);
        continue;
      }
      let i = afterProto + 1;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '(') {
          const closeIdx = matchClose ? matchClose[i] : -1;
          if (closeIdx === -1) break;
          i = closeIdx + 1;
        } else if (URL_SAFE_CHAR_RE.test(ch)) {
          i++;
        } else {
          break;
        }
      }
      const rawUrl = text.slice(start, i);
      const trailMatch = /[.,;:!?]+$/.exec(rawUrl);
      const clean = trailMatch ? rawUrl.slice(0, trailMatch.index) : rawUrl;
      const trail = trailMatch ? trailMatch[0] : '';
      if (clean.length > m[0].length) {
        out += text.slice(cursor, start) + onUrl(clean) + trail;
        cursor = i;
        URL_PROTO_RE.lastIndex = i;
      }
      m = URL_PROTO_RE.exec(text);
    }
    return cursor === 0 ? text : out + text.slice(cursor);
  }
  function md(src) {
    const lines = String(src || '').split('\n');
    let out = '', code = [], inList = false;
    const fenceStack = [];
    const inline = (t) => {
      const raw = String(t ?? '');
      const urls = [];
      const codes = [];
      let nonce = '\uE000';
      while (raw.includes(nonce)) nonce += '\uE000';
      const maskedUrls = maskBalancedUrls(raw, (clean) => {
        const idx = urls.length;
        urls.push(clean);
        return `${nonce}U${idx}\uE001`;
      });
      let masked = '';
      let i = 0;
      while (i < maskedUrls.length) {
        if (maskedUrls[i] !== '`') {
          const next = maskedUrls.indexOf('`', i);
          if (next === -1) { masked += maskedUrls.slice(i); break; }
          masked += maskedUrls.slice(i, next);
          i = next;
        }
        let n = 0;
        while (i + n < maskedUrls.length && maskedUrls[i + n] === '`') n++;
        let j = i + n;
        let closeStart = -1;
        while (j < maskedUrls.length) {
          if (maskedUrls[j] !== '`') {
            const next = maskedUrls.indexOf('`', j);
            if (next === -1) break;
            j = next;
          }
          let m = 0;
          while (j + m < maskedUrls.length && maskedUrls[j + m] === '`') m++;
          if (m === n) {
            closeStart = j;
            break;
          }
          j += m;
        }
        if (closeStart !== -1 && closeStart > i + n) {
          let inner = maskedUrls.slice(i + n, closeStart);
          if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && /[^ ]/.test(inner)) {
            inner = inner.slice(1, -1);
          }
          const cIdx = codes.length;
          codes.push(`<code>${esc(inner)}</code>`);
          masked += `${nonce}C${cIdx}\uE001`;
          i = closeStart + n;
        } else {
          masked += maskedUrls.slice(i, i + n);
          i += n;
        }
      }
      let html = esc(masked)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>');
      if (codes.length) {
        const restoreCodeRe = new RegExp(`${nonce}C(\\d+)\uE001`, 'g');
        html = html.replace(restoreCodeRe, (_, idx) => codes[Number(idx)] ?? '');
      }
      const rendered = highlightCitations(highlightMentions(html));
      if (!urls.length) return rendered;
      const restoreRe = new RegExp(`${nonce}U(\\d+)\uE001`, 'g');
      return rendered.replace(restoreRe, (_, idx) => esc(urls[Number(idx)] ?? ''));
    };
    const closeList = () => { if (inList) { out += '</ul>'; inList = false; } };
    for (const line of lines) {
      if (!fenceStack.length) {
        const fm = /^[ \t]{0,3}(`{3,})([^`\n]*)$/.exec(line);
        if (fm) {
          closeList();
          fenceStack.push(fm[1].length);
          continue;
        }
      } else {
        const fm = /^[ \t]*(`{3,})(.*)$/.exec(line);
        if (fm) {
          const ticks = fm[1].length;
          const info = fm[2];
          const infoTrim = info.trim();
          const top = fenceStack[fenceStack.length - 1];
          if (!infoTrim && ticks >= top) {
            fenceStack.pop();
            if (!fenceStack.length) {
              out += `<pre>${esc(code.join('\n'))}</pre>`;
              code = [];
            } else {
              code.push(line);
            }
            continue;
          }
          if (infoTrim && !info.includes('`') && ticks >= top) {
            fenceStack.push(ticks);
            code.push(line);
            continue;
          }
        }
        code.push(line);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
        continue;
      }
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (li) {
        if (!inList) {
          out += '<ul>';
          inList = true;
        }
        out += `<li>${inline(li[1])}</li>`;
        continue;
      }
      closeList();
      if (line.trim()) out += `<p>${inline(line)}</p>`;
    }
    if (fenceStack.length) out += `<pre>${esc(code.join('\n'))}</pre>`;
    closeList();
    return out;
  }

  const tier1Fallback = (t) => (window.SwarmHive?.tier1Fallback ? window.SwarmHive.tier1Fallback(t) : String(t ?? ''));
  function msgDisplayText(m) {
    const raw = String(m?.text || '');
    if (m?.text_zh && String(m.text_zh).trim()) return String(m.text_zh);
    return tier1Fallback(raw) || raw;
  }

  const canOpenConversation = () => !!window.sidecar?.ui?.toggleConversation;
  function openConversation(convId) {
    if (!convId) return;
    // A member on another machine's LS has no conversation here: every open
    // path (rows, graph, Overview actions, alerts) says where it runs instead.
    const remote = members().find((m) => m.conversation_id === convId && m.local === false);
    if (remote) {
      toast(`${remote.name} 运行在 ${remote.owner?.label || '另一台机器'}；请在对应设备中打开。`);
      return;
    }
    if (window.sidecar?.ui?.toggleConversation)
      window.sidecar.ui.toggleConversation(convId);
  }

  // Who a post calls on: explicit roster mentions, plus (optionally) everyone
  // but the poster and role workers for @all.
  function targetsOf(m, expandAll) {
    if (isRoleWorker(m.agent)) return { direct: new Set(), viaAll: new Set() };
    const direct = new Set([...(m.mentions || []), ...(m.via_channel || [])].filter((n) => n !== m.agent && !isRoleWorker(n)));
    const viaAll = new Set();
    if (m.all && expandAll) {
      for (const mem of members())
        if (mem.name !== m.agent && !direct.has(mem.name) && !isRoleWorker(mem)) viaAll.add(mem.name);
    }
    return { direct, viaAll };
  }

  // ---------- data loading ----------
  // Forget everything about the shown swarm (the swarm or "you" changed).
  function resetSwarm(id) {
    state.swarm = id;
    state.etag = '';
    state.snap = null;
    lastFeedHtml = '';
    state.seenSeqs.clear();
    state.hiddenAgents.clear();
    state.channel = '';
    state.expanded.clear();
    state.firstLoad = true;
    state.stick = true;
    $('f-agent').value = '';
    $('f-mention').value = '';
    replayStop();
    frameTeardown();
    frame.failed = null;
    state.tabChosen = urlTabChosen;
  }

  function showView(view) {
    if (view === state.view) return;
    state.view = view;
    $('loading').classList.toggle('hidden', view !== 'loading');
    $('board').classList.toggle('hidden', view !== 'board');
    $('empty').classList.toggle('hidden', view !== 'empty');
    // The graph lays out against its rendered width, so redo it once visible.
    if (view === 'board' && state.snap && state.tab === 'graph') renderGraph();
    if (view !== 'board') frameTeardown();
    syncWatchdog();
    if (view === 'board' && state.snap && state.tab === 'feed') {
      measureClamps();
      // The first render happened while hidden, so follow to the newest post now.
      if ($('f-autoscroll').checked && state.stick) scrollToLatest();
      updateJump();
    }
  }

  function showEmpty(conv) {
    $('empty-body').innerHTML = conv ?
        '在此会话中启动的 Swarm 会自动显示在这里，包括看板、成员和 @提及关系图。启动命令：<code>/swarm</code>' :
        '从会话中打开此面板即可查看其 Swarm。在该会话中启动的 Swarm 会自动显示在这里；可使用以下命令启动：<code>/swarm</code>';
    showView('empty');
  }

  function setLive(ok) {
    const live = $('live');
    const stale = !ok;
    live.classList.toggle('stale', stale);
    const label = stale ? '正在重新连接' : '实时';
    if ($('live-label').textContent !== label) $('live-label').textContent = label;
    live.title = stale ? '已与 Swarm 辅助进程断开连接，正在重试' : '自动更新';
  }

  async function poll() {
    let delay = POLL_MS;
    try {
      const conv = currentConv();
      if (conv !== state.conv) {
        state.conv = conv;
        resetSwarm(null);
      }
      const q = new URLSearchParams({etag: state.etag});
      if (conv) q.set('conversationId', conv);
      const r = await getJson(`/api/swarm?${q}`);
      state.lastOk = Date.now();
      if (!r.swarm) {
        if (state.swarm) resetSwarm(null);
        state.me = null;
        showEmpty(r.conversationId || conv);
        delay = IDLE_POLL_MS;
        return;
      }
      if (r.swarm !== state.swarm) resetSwarm(r.swarm);
      state.me = r.member || null;
      if (!r.unchanged) {
        state.etag = r.etag;
        ingest(r);
      }
      showView('board');
    } catch (e) {
      console.warn(e);
    } finally {
      setLive(Date.now() - state.lastOk <= POLL_MS * 4);
      setTimeout(poll, delay);
    }
  }

  function ingest(snap) {
    const newSeqs = [];
    for (const m of snap.messages) {
      if (!state.seenSeqs.has(m.seq)) {
        newSeqs.push(m.seq);
        state.seenSeqs.add(m.seq);
      }
    }
    state.snap = snap;
    // Seqs this conversation's member does not see (channels only).
    state.unseen = Array.isArray(snap.unseen) ? new Set(snap.unseen) : null;
    const newSet = state.firstLoad ? new Set() : new Set(newSeqs);
    state.newEdgeKeys = new Set();
    if (!state.firstLoad) {
      for (const m of snap.messages) {
        if (!newSet.has(m.seq)) continue;
        const { direct, viaAll } = targetsOf(m, true);
        for (const t of [...direct, ...viaAll])
          state.newEdgeKeys.add(`${m.agent}>${t}`);
      }
    }
    renderMeta();
    renderAgents();
    renderFilters();
    renderChannels();
    renderFeed(newSet);
    renderMembers();
    renderGraph();
    renderRaw();
    renderOverview();
    autoSelectTab();
    if (newSet.size) {
      const live = $('live');
      live.classList.add('flash');
      setTimeout(() => live.classList.remove('flash'), 600);
    }
    state.firstLoad = false;
  }

  // ---------- rendering ----------
  // hive.js draws the Overview (plan, running, blocked, planned, the team) and
  // the Members cards.
  {
    window.SwarmHive.hooks = {
      members: () => selectTab('members', false, true),
      member: (name) => {
        const target = name === 'coordinator' ? (window.SwarmHive?.leadName || 'coordinator') : name;
        const m = (state.snap?.members || []).find((x) => x.name === target);
        if (m?.conversation_id && canOpenConversation()) {
          openConversation(m.conversation_id);
        } else if (m) {
          $('f-agent').value = m.name;
          $('f-agent').classList.add('set');
          selectTab('feed', false, true);
          renderFeed();
        }
      },
    };
  }

  function renderMeta() {
    const s = state.snap;
    // Role workers (narrator, monitor, ...) are observers, not part of the
    // task-worker team: they are left out of the counts (and the graph).
    const team = s.members.filter((m) => !isRoleWorker(m));
    const visibleTeam = team.filter((m) => !m.killed);
    const rawTitle = s.title || '';
    const zhTitle = s.title_zh || (rawTitle ? tier1Fallback(rawTitle) : '');
    const titleText = zhTitle || rawTitle || '未命名 Swarm';
    $('swarm-title').textContent = titleText;
    $('swarm-title').title = `${titleText}\nSwarm ${s.id}\n${s.dir || ''}`;
    if ($('swarm-meta').innerHTML !== '') $('swarm-meta').innerHTML = '';
    $('tab-count-feed').textContent = s.head ? String(s.head) : '';
    $('tab-count-members').textContent = visibleTeam.length ? String(visibleTeam.length) : '';
  }

  function renderAgents() {
    $('agents').innerHTML = members().map((m) => {
      const hidden = state.hiddenAgents.has(m.name);
      const role = roleLabel(roleOf(m));
      const failText = m.failure?.text ? (m.failure_zh || tier1Fallback(m.failure.text)) : '';
      const tip = `${m.name}${m.name === state.me ? ' (你)' : ''} · ${role}${m.model ? ' · ' + m.model : ''} · ${statusLabel(m.status)} · ${m.posts} 条消息` +
          `${failText ? `\n${failText}` : ''}` +
          `\n${hidden ? '当前已在看板中隐藏；点击显示' : '点击在看板中隐藏'}`;
      return `<button type="button" class="chip ${hidden ? 'dim' : ''} ${m.killed ? 'killed' : ''}" data-agent="${esc(m.name)}" data-testid="swarm-member-chip" ` +
          `aria-pressed="${hidden ? 'false' : 'true'}" title="${esc(tip)}">` +
          `<span class="chip-name">${esc(m.name)}${m.name === state.me ? ' (你)' : ''}</span>` +
          `<span class="chip-count">${m.posts}</span></button>`;
    }).join('');
  }

  function renderFilters() {
    const names = members().map((m) => m.name);
    const posters = [...new Set([...names, ...state.snap.messages.map((m) => m.agent)])];
    const fill = (id, first, opts) => {
      const sel = $(id);
      const prev = sel.value;
      sel.innerHTML = `<option value="">${first}</option>` + opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      sel.value = opts.some(([v]) => v === prev) ? prev : '';
      sel.classList.toggle('set', !!sel.value);
    };
    fill('f-agent', '所有发送者', posters.map((n) => [n, `来自 ${n}`]));
    fill('f-mention', '所有接收者', [['@none', '未提及任何人'], ['@all', '提及 @all'], ...names.map((n) => [n, `提及 ${n}`])]);
  }

  // ---------- channels ----------
  // A message's channel: '' / absent is main. Control messages (create,
  // archive, subscribe, unsubscribe) carry `control` and are shown as compact
  // system lines. Channel data is present only once a swarm has created a
  // channel, so a one-channel swarm renders exactly as before.
  const chanOf = (m) => (typeof m?.channel === 'string' && m.channel ? m.channel : 'main');
  const isControl = (m) => !!(m?.control && typeof m.control === 'object');
  const swarmChannels = () => (Array.isArray(state.snap?.channels) ? state.snap.channels : []);
  const hasChannels = () => swarmChannels().length > 0;

  // Whether the feed's "New" divider may count m for me: a post I see, judged
  // by my subscriptions as of that post (the server lists the ones I don't,
  // `unseen`, once the swarm has channels). Control lines never count, as in
  // the board's unread rule.
  function seesNow(m) {
    if (isControl(m)) return false;
    return !(state.unseen && state.unseen.has(m.seq));
  }

  // The channel tab strip (shown only when a non-main channel exists) and the
  // matching select in the filter panel; both set state.channel.
  function renderChannels() {
    const chans = swarmChannels();
    const strip = $('channel-tabs');
    const wrap = $('f-channel-wrap');
    const on = chans.length > 0;
    strip.classList.toggle('hidden', !on);
    wrap.classList.toggle('hidden', !on);
    if (!on) {
      state.channel = '';
      strip.innerHTML = '';
      return;
    }
    const names = ['main', ...chans.map((c) => c.name)];
    if (state.channel && !names.includes(state.channel)) state.channel = '';
    const counts = new Map();
    for (const m of state.snap.messages) counts.set(chanOf(m), (counts.get(chanOf(m)) || 0) + 1);
    const tab = (value, label, tip, extra = '') => {
      const sel = state.channel === value;
      return `<button type="button" role="tab" class="channel-tab ${sel ? 'on' : ''} ${extra}" data-channel="${esc(value)}" ` +
          `aria-selected="${sel}" tabindex="${sel ? 0 : -1}" title="${esc(tip)}" data-testid="swarm-channel-tab">${label}</button>`;
    };
    const byName = new Map(chans.map((c) => [c.name, c]));
    const html = tab('', '全部', '所有频道的消息') + names.map((n) => {
      const c = byName.get(n);
      const count = counts.get(n) || 0;
      const tip = n === 'main' ? 'main：整个 Swarm 均可读取' :
        `${n}${c?.topic ? ` · ${c.topic}` : ''}${c?.created_by ? `\n由 ${c.created_by} 创建` : ''}${c?.archived ? '\n已归档' : ''}`;
      return tab(n, `#${esc(n)}${count ? `<span class="chip-count">${count}</span>` : ''}`, tip, c?.archived ? 'archived' : '');
    }).join('');
    if (strip.innerHTML !== html) strip.innerHTML = html;
    const sel = $('f-channel');
    const opts = `<option value="">所有频道</option>` +
        names.map((n) => `<option value="${esc(n)}">#${esc(n)}${byName.get(n)?.archived ? '（已归档）' : ''}</option>`).join('');
    if (sel.innerHTML !== opts) sel.innerHTML = opts;
    sel.value = state.channel;
    sel.classList.toggle('set', !!state.channel);
  }

  function setChannel(value) {
    state.channel = value || '';
    renderChannels();
    renderFeed();
  }

  // A post's channel chip (non-main posts only).
  function channelChipHtml(m) {
    const ch = chanOf(m);
    if (ch === 'main') return '';
    return `<button type="button" class="msg-channel" data-channel="${esc(ch)}" data-testid="swarm-message-channel" ` +
        `title="发布于 #${esc(ch)}；点击仅显示 #${esc(ch)}">#${esc(ch)}</button>`;
  }

  function filtersActive() {
    return !!($('f-agent').value || $('f-mention').value || $('f-search').value.trim() || state.hiddenAgents.size || state.channel);
  }

  // The filter panel is collapsed by default; a dot on its toggle shows that
  // a filter inside it is narrowing the feed.
  function updateFilterToggle() {
    const hidden = !!($('f-agent').value || $('f-mention').value || state.hiddenAgents.size);
    const t = $('f-toggle');
    t.classList.toggle('active', hidden);
    t.title = hidden ? '筛选 (已启用)' : '筛选';
  }
  function setFiltersOpen(open) {
    $('filters').classList.toggle('hidden', !open);
    $('f-toggle').setAttribute('aria-expanded', String(open));
  }

  function visibleMessages() {
    const s = state.snap;
    const from = $('f-agent').value;
    const to = $('f-mention').value;
    const q = $('f-search').value.trim().toLowerCase();
    const ch = state.channel;
    return s.messages.filter((m) => {
      if (ch && chanOf(m) !== ch) return false;
      if (state.hiddenAgents.has(m.agent)) return false;
      if (from && m.agent !== from) return false;
      if (to === '@none' && ((m.mentions || []).length || m.all || (m.channel_mentions || []).length)) return false;
      if (to === '@all' && !m.all) return false;
      if (to && to[0] !== '@' && !(m.all || (m.mentions || []).includes(to) || (m.via_channel || []).includes(to))) return false;
      if (q) {
        const hay = `${m.agent}\n${m.text}\n${m.text_zh || ''}\n${m.text_zh ? '' : tier1Fallback(m.text)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  const feedShown = () => state.view === 'board' && state.tab === 'feed';
  function scrollToLatest(behavior = 'auto') {
    state.stick = true;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }
  // Re-pin to the newest post after the feed's height changes (late layout,
  // the pane going from hidden to visible, fonts or theme arriving), as long
  // as the user hasn't scrolled away from the bottom.
  function keepPinned() {
    if (feedShown() && state.stick && $('f-autoscroll').checked) scrollToLatest();
  }

  // A channel change (create, archive, subscribe, unsubscribe) as one quiet
  // system line: it never wakes anyone and is not part of the conversation.
  function controlHtml(m, { isNew = false } = {}) {
    const t = msgMs(m);
    const rawText = String(m.text || '').replace(/^\[channel\]\s*/, '');
    const text = m.text_zh ? String(m.text_zh).replace(/^\[(?:channel|频道)\]\s*/i, '') : tier1Fallback(rawText);
    return `<div class="msg msg-system ${isNew ? 'new' : ''}" data-seq="${m.seq}" data-testid="swarm-control-message" role="note">` +
        `<span class="sys-text" title="${esc(`#${m.seq} · ${m.agent} · ${fmtFull(t)}`)}">${esc(text)}</span>` +
        `<time class="ts" datetime="${esc(isoTime(t))}">${esc(fmtClock(t))}</time></div>`;
  }

  // The row header already names the recipients, so a post's leading
  // "@a @b" is dropped from its preview.
  function stripLeadingMentions(text) {
    const t = String(text || '');
    const rest = t.replace(/^(\s*@[A-Za-z0-9_.-]+(?:\s*[,，:：、])?)+\s*/, '');
    return rest || t;
  }

  function msgBodyHtml(m, { stripMentions = false } = {}) {
    const primaryRaw = msgDisplayText(m);
    const primary = stripMentions ? stripLeadingMentions(primaryRaw) : primaryRaw;
    return md(primary);
  }

  function messageHtml(m, { isNew = false, unreadByMe = false } = {}) {
    if (isControl(m)) return controlHtml(m, { isNew });
    const targets = [...(m.mentions || [])].filter((n) => n !== m.agent);
    const open = state.expanded.has(m.seq);
    const onRoster = !!memberOf(m.agent);
    const t = msgMs(m);
    const tsTitle = esc(`#${m.seq} · ${fmtFull(t)}`);
    const dt = esc(isoTime(t));
    const cls = ['msg', isNew ? 'new' : '', unreadByMe ? 'unread-by-me' : ''].filter(Boolean).join(' ');
    const color = window.SwarmHive?.colorOf ? window.SwarmHive.colorOf(m.agent) : '#8a8f98';
    const avatar = window.SwarmHive?.avatarHtml ? window.SwarmHive.avatarHtml(m.agent) :
        `<span class="msg-av" style="--av:${esc(color)}" aria-hidden="true">${esc((m.agent || '?').charAt(0).toUpperCase())}</span>`;
    const head = `<header class="msg-head">
            <span class="msg-who">
              <span class="msg-author" ${onRoster ? '' : 'title="不在成员列表中"'}>@${esc(m.agent)}</span>
              ${channelChipHtml(m)}
              ${recipientsHtml(m)}
              ${!onRoster ? '<span class="msg-note">不在成员列表中</span>' : ''}
            </span>
            <time class="ts" datetime="${dt}" title="${tsTitle}">#${m.seq} · ${esc(fmtClock(t))}</time>
          </header>`;
    const stripMentions = !!(targets.length || m.all);
    return `<article class="${cls}" data-seq="${m.seq}" data-testid="swarm-message"` +
        ` aria-label="${esc(`${m.agent}${stripMentions ? ' 发送给 ' + [...targets, ...(m.all ? ['all'] : [])].join('、') : ''}，${fmtClock(t)}`)}">
          ${avatar}${head}
          <div class="msg-body md ${open ? 'open' : ''}">${msgBodyHtml(m, { stripMentions })}</div>
          <button type="button" class="msg-more hidden" data-testid="swarm-message-more" aria-expanded="${open}">${open ? '收起' : '展开更多'}</button>
      </article>`;
  }

  // Long posts collapse to a few lines with a "展开更多" toggle; only posts
  // that actually overflow get one.
  function measureClamps() {
    for (const body of $('feed').querySelectorAll('.msg-body')) {
      const btn = body.nextElementSibling;
      body.classList.add('clamped');
      const wasOpen = body.classList.contains('open');
      body.classList.remove('open');
      const overflows = body.scrollHeight > body.clientHeight + 4;
      if (wasOpen) body.classList.add('open');
      body.classList.toggle('clamped', overflows);
      btn.classList.toggle('hidden', !overflows);
    }
  }

  function renderFeed(newSet = new Set()) {
    const feed = $('feed');
    const wasNearBottom = nearBottom();
    const myCursor = state.me ? memberOf(state.me)?.last_read_seq ?? null : null;
    const msgs = visibleMessages();
    let dividerDone = false;
    const html = msgs.map((m) => {
      const unreadByMe = myCursor !== null && m.seq > myCursor && m.agent !== state.me && seesNow(m);
      let pre = '';
      if (unreadByMe && !dividerDone) {
        dividerDone = true;
        pre = `<div class="divider" role="separator" data-testid="swarm-unread-divider">新消息</div>`;
      }
      return pre + messageHtml(m, { isNew: newSet.has(m.seq), unreadByMe });
    }).join('');
    updateFilterToggle();
    const fullHtml = html || (state.snap.messages.length
      ? `<div class="feed-empty" data-testid="swarm-feed-empty">${ICON.search}
          <div class="feed-empty-title">没有匹配的消息</div>
          <div>请尝试其他搜索条件或成员筛选条件。</div>
          <button type="button" class="ghost-btn" data-clear-filters data-testid="swarm-clear-filters">清除筛选</button></div>`
      : `<div class="feed-empty" data-testid="swarm-feed-empty">${ICON.inbox}
          <div class="feed-empty-title">暂无消息</div>
          <div>成员交流时，看板消息会显示在这里。</div></div>`);
    if (fullHtml !== lastFeedHtml) {
      let anchor = null;
      if (!state.stick && !state.firstLoad && html) {
        for (const el of feed.querySelectorAll('.msg[data-seq]')) {
          const rect = el.getBoundingClientRect?.();
          if (rect && rect.bottom > 0) {
            anchor = { seq: el.dataset.seq, top: rect.top };
            break;
          }
        }
      }
      lastFeedHtml = fullHtml;
      feed.innerHTML = fullHtml;
      if (state.view === 'board' && state.tab === 'feed') measureClamps();
      if (anchor && !state.stick) {
        const moved = feed.querySelector(`.msg[data-seq="${CSS.escape(anchor.seq)}"]`);
        const newTop = moved?.getBoundingClientRect?.().top;
        if (Number.isFinite(newTop) && typeof window.scrollBy === 'function') {
          const dy = newTop - anchor.top;
          if (Math.abs(dy) > 0.5) window.scrollBy(0, dy);
        }
      }
    } else if (state.view === 'board' && state.tab === 'feed') {
      measureClamps();
    }
    if ($('f-autoscroll').checked && state.tab === 'feed' &&
        (state.firstLoad || state.stick || (newSet.size && wasNearBottom))) {
      scrollToLatest();
    }
    updateJump();
  }

  function updateJump() {
    const show = state.tab === 'feed' && state.view === 'board' && !nearBottom() && document.body.scrollHeight > window.innerHeight * 1.5;
    $('jump-latest').classList.toggle('hidden', !show);
  }

  function renderMembers() {
    // Drawn by hive.js, which index.html loads before this file.
    window.SwarmHive.update(hiveSnap(state.snap), $('members'), { view: 'cards' });
  }

  // Pill width that fits status dot + label (12px medium is ~6.8px a character).
  const pillWidth = (id, maxW) => Math.min(maxW, Math.max(72, 36 + Math.ceil(String(id).length * 6.8)));

  function layout(nodes, width) {
    // Up to ~16 nodes: an ellipse with the coordinator at the top, so worker-to-worker
    // edges are chords rather than running through neighbours. Bigger swarms wrap in rows.
    const nodeH = 28;
    if (nodes.length <= 16) {
      const pos = new Map();
      const n = nodes.length;
      const w = Math.min(144, Math.max(116, width / Math.max(4, Math.ceil(n / 2) + 1) - 10));
      const rx = Math.max(60, width / 2 - w / 2 - 14);
      const ry = n <= 2 ? 60 : Math.min(220, Math.max(110, n * 20));
      const cx = width / 2, cy = ry + nodeH / 2 + 20;
      nodes.forEach((node, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
        pos.set(node.id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), w: pillWidth(node.id, w), h: nodeH });
      });
      return { pos, height: cy + ry + nodeH / 2 + 20 };
    }
    // Coordinator row on top, workers below (wrapping), outsiders last.
    const rows = new Map();
    for (const n of nodes) {
      if (!rows.has(n.row)) rows.set(n.row, []);
      rows.get(n.row).push(n);
    }
    const pos = new Map();
    const minNodeW = 96, lineH = 64, rowGap = 40;
    const perLine = Math.max(1, Math.floor(width / (minNodeW + 12)));
    let y = 32;
    for (const [, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      for (let i = 0; i < list.length; i += perLine) {
        const line = list.slice(i, i + perLine);
        const gap = width / (line.length + 1);
        const w = Math.min(140, Math.max(minNodeW, gap - 12));
        // Stagger alternate nodes on wide lines so edges between neighbours stay visible.
        line.forEach((n, j) => pos.set(n.id, { x: gap * (j + 1), y: y + (line.length > 3 && j % 2 ? 14 : 0), w: pillWidth(n.id, Math.min(w, gap - 8)), h: nodeH }));
        y += lineH;
      }
      y += rowGap;
    }
    return { pos, height: y - rowGap + 14 };
  }

  // ---------- graph + replay ----------
  // Channel control lines are bookkeeping, not posts: the graph skips them.
  const graphMsgs = () => (state.snap?.messages || []).filter((m) => !isControl(m));
  // idx null = live (show everything). animatedSeq: the replay message whose
  // travelling dot has already been started (see renderGraph).
  const replay = { idx: null, playing: false, timer: null, animatedSeq: null };

  function edgeGeom(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, bend = 24;
    const mx = (a.x + b.x) / 2 + nx * bend, my = (a.y + b.y) / 2 + ny * bend;
    // Trim ends at the box border (plus a small gap) so arrowheads stay visible.
    const trim = (p, q) => {
      const tx = q.x - p.x, ty = q.y - p.y, l = Math.hypot(tx, ty) || 1;
      const ux = tx / l, uy = ty / l;
      const toBorder = Math.min(ux ? p.w / 2 / Math.abs(ux) : Infinity, uy ? p.h / 2 / Math.abs(uy) : Infinity);
      const t = Math.min(0.45 * l, toBorder + 4);
      return { x: p.x + ux * t, y: p.y + uy * t };
    };
    const s1 = trim(a, { x: mx, y: my }), e1 = trim(b, { x: mx, y: my });
    return { d: `M${s1.x},${s1.y} Q${mx},${my} ${e1.x},${e1.y}`, mx, my, end: e1 };
  }

  function renderGraph() {
    const s = state.snap;
    if (!s) return;
    const svg = $('graph');
    const width = Math.max(svg.clientWidth || 0, 320);
    const expandAll = $('g-all').checked;
    const hideInactive = $('g-hide-inactive')?.checked || false;
    const all = graphMsgs();
    const memberNames = new Set(s.members.map((m) => m.name));
    const outsiders = [...new Set(all.map((m) => m.agent))].filter((n) => !memberNames.has(n) && !isRoleWorker(n));
    // Role-worker nodes are left out, which also drops every edge to or from
    // them (edges need both ends placed).
    const allNodes = [
      ...s.members.filter((m) => !isRoleWorker(m)).map((m) => ({ id: m.name, row: m.role === 'coordinator' ? 0 : 1, m })),
      ...outsiders.map((n) => ({ id: n, row: 2, m: null })),
    ];

    const replaying = replay.idx !== null;
    if (replaying && replay.idx > all.length) replay.idx = all.length;
    const upto = replaying ? replay.idx : all.length;
    const msgs = all.slice(0, upto);
    const current = replaying && upto > 0 ? all[upto - 1] : null;

    // While replaying, members light up the first time they post or are called on.
    const active = new Set(['coordinator']);
    const edges = new Map();  // "from>to" -> {direct, viaAll}
    const unaddressed = new Map();  // poster -> posts calling on nobody
    const broadcasts = new Map();  // poster -> @all posts (badged when not expanded)
    const bump = (k, field) => { const e = edges.get(k) || { direct: 0, viaAll: 0 }; e[field]++; edges.set(k, e); };
    for (const m of msgs) {
      if (isRoleWorker(m.agent)) continue;
      active.add(m.agent);
      const { direct, viaAll } = targetsOf(m, expandAll);
      if (m.all) broadcasts.set(m.agent, (broadcasts.get(m.agent) || 0) + 1);
      if (!direct.size && !viaAll.size && !m.all && !(m.mentions || []).some((n) => n !== m.agent))
        unaddressed.set(m.agent, (unaddressed.get(m.agent) || 0) + 1);
      for (const t of direct) {
        active.add(t);
        bump(`${m.agent}>${t}`, 'direct');
      }
      for (const t of viaAll) {
        if (!hideInactive) active.add(t);
        bump(`${m.agent}>${t}`, 'viaAll');
      }
    }
    const currentDirect = current && !isRoleWorker(current.agent)
      ? new Set([current.agent, ...targetsOf(current, false).direct])
      : new Set();
    const isKilled = (n) => Boolean(n.m?.killed || n.m?.status === 'killed');
    const nodes = hideInactive
      ? allNodes.filter((n) => currentDirect.has(n.id) || (active.has(n.id) && !isKilled(n)))
      : allNodes;
    const { pos, height } = layout(nodes, width);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.height = `${height}px`;

    const isActive = (id) => !replaying || active.has(id);
    let curTargets = new Set();
    if (current) {
      const { direct, viaAll } = targetsOf(current, expandAll);
      curTargets = new Set([...direct, ...viaAll]);
    }
    const isCur = (from, to) => current && from === current.agent && curTargets.has(to);
    // renderGraph rebuilds the SVG on every snapshot change (member
    // transcripts change it every poll while members work), on resize and on
    // tab switches, so an animation emitted on every render replays over and
    // over. Each one plays once, for the message that caused it: the current
    // replay message's dot and pulse only the first time that message is
    // shown (stepping away and back plays them again), and live pulses for
    // new posts only in the first render after they arrive.
    const animateCur = !!current && current.seq !== replay.animatedSeq;
    replay.animatedSeq = current ? current.seq : null;
    const newEdgeKeys = state.newEdgeKeys;
    state.newEdgeKeys = new Set();

    const visibleEdgeTotals = [...edges.entries()]
      .filter(([k]) => { const [from, to] = k.split('>'); return pos.has(from) && pos.has(to); })
      .map(([, e]) => e.direct + e.viaAll);
    const max = Math.max(1, ...visibleEdgeTotals);
    let edgesSvg = '', countsSvg = '', dots = '', curIdx = 0;
    for (const [k, e] of edges) {
      const [from, to] = k.split('>');
      const a = pos.get(from), b = pos.get(to);
      if (!a || !b) continue;
      const n = e.direct + e.viaAll;
      const { d, mx, my, end } = edgeGeom(a, b);
      const w = 1 + (3 * n) / max;
      const cur = isCur(from, to);
      const pulse = replaying ? cur && animateCur : newEdgeKeys.has(k);
      const id = cur ? `cur-edge-${curIdx++}` : '';
      edgesSvg += `<path ${id ? `id="${id}"` : ''} class="edge ${e.direct ? '' : 'via-all'} ${pulse ? 'pulse' : ''} ${cur ? 'cur' : ''} ${replaying && !cur ? 'past' : ''}" d="${d}" ` +
        `stroke-width="${w.toFixed(2)}" marker-end="url(#arrow)"><title>${esc(from)} → ${esc(to)}：直接提及 ${e.direct} 次` +
        `${e.viaAll ? `，通过 @all ${e.viaAll} 次` : ''}</title></path>`;
      if (n > 1) countsSvg += `<text class="count" x="${mx}" y="${my + 3}" text-anchor="middle">${n}</text>`;
      if (id && animateCur) {
        dots += `<circle class="msg-dot" r="4.5"><animateMotion class="dot-anim" dur="0.9s" begin="indefinite" fill="freeze"><mpath href="#${id}"/></animateMotion></circle>`;
      } else if (id) {
        // Already played: rest where the animation froze, at the arrowhead.
        dots += `<circle class="msg-dot" r="4.5" cx="${end.x}" cy="${end.y}"/>`;
      }
    }
    const defs = '<marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
        '<path class="arrowhead" d="M1,1.2 L9,5 L1,8.8 Q2.6,5 1,1.2 z"/></marker>';
    let nodesSvg = '';
    for (const n of nodes) {
      const p = pos.get(n.id);
      const status = n.m?.status || '';
      const dotX = p.x - p.w / 2 + 14;  // status dot centre x
      const labelX = status ? dotX + 9 : p.x - p.w / 2 + 12;
      const maxChars = Math.max(4, Math.floor((p.x + p.w / 2 - 10 - labelX) / 6.8));
      const label = n.id.length > maxChars ? n.id.slice(0, maxChars - 1) + '…' : n.id;
      const hot = current && (n.id === current.agent || curTargets.has(n.id));
      const ring = unaddressed.get(n.id);
      const bcast = expandAll ? 0 : broadcasts.get(n.id) || 0;
      const bw = 30 + 6 * String(bcast).length;  // "@all N" pill at 9px semibold
      const actText = n.m?.activity_zh || tier1Fallback(n.m?.activity || '');
      const failText = n.m?.failure?.text ? (n.m.failure_zh || tier1Fallback(n.m.failure.text)) : '';
      const tip = n.m
        ? `${n.id} · ${roleLabel(n.m.role)}${n.m.model ? ' · ' + n.m.model : ''} · ${statusLabel(status)} · ${n.m.steps || 0} 步 · ${n.m.posts} 条消息 · ${n.m.unread} 未读${ring ? ` · ${ring} 条未提及` : ''}${broadcasts.get(n.id) ? ` · ${broadcasts.get(n.id)} 条 @all` : ''}${actText && status === 'working' ? `\n${actText}` : ''}${failText ? `\n${failText}` : ''}${n.m.owner ? `\n运行于 ${n.m.owner.label}` : ''}${n.m.conversation_id && n.m.local !== false && canOpenConversation() ? '\n点击打开会话' : ''}`
        : `${n.id}（不在成员列表中）`;
      const cls = ['node', isActive(n.id) ? '' : 'inactive', hot ? 'hot' : '', status === 'killed' ? 'killed' : '', n.m ? '' : 'outsider'].filter(Boolean).join(' ');
      nodesSvg += `<g class="${cls}" data-conv="${esc(n.m?.conversation_id || '')}">` +
        `<title>${esc(tip)}</title>` +
        (ring ? `<rect class="ring" x="${p.x - p.w / 2 - 4}" y="${p.y - p.h / 2 - 4}" width="${p.w + 8}" height="${p.h + 8}" rx="${p.h / 2 + 4}"/>` : '') +
        `<rect class="node-box" x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${p.h / 2}"/>` +
        (status ? `<circle class="status-dot ${esc(status)}" cx="${dotX}" cy="${p.y}" r="3.25"/>` : '') +
        `<text class="node-label" x="${labelX}" y="${p.y + 4}">${esc(label)}</text>` +
        (bcast ? `<g class="bcast"><rect x="${p.x + p.w / 2 - bw + 6}" y="${p.y - p.h / 2 - 7}" width="${bw}" height="14" rx="7"/>` +
          `<text x="${p.x + p.w / 2 - bw / 2 + 6}" y="${p.y - p.h / 2 + 3}" text-anchor="middle">@all ${bcast}</text></g>` : '') +
        `</g>`;
    }
    svg.innerHTML = `<defs>${defs}</defs>${edgesSvg}${nodesSvg}${countsSvg}${dots}`;
    // SVG animations inserted via innerHTML start on the document clock (long past),
    // so trigger the travelling dots explicitly.
    svg.querySelectorAll('.dot-anim').forEach((a) => a.beginElement?.());
    renderReplayBar(all, upto, current);
  }

  function renderReplayBar(all, upto, current) {
    const slider = $('replay-slider');
    slider.max = String(all.length);
    slider.value = String(upto);
    slider.style.setProperty('--pct', `${all.length ? (100 * upto) / all.length : 100}%`);
    const play = $('replay-play');
    const playIcon = replay.playing ? 'pause' : 'play';
    if (play.dataset.icon !== playIcon) {
      play.innerHTML = ICON[playIcon];
      play.dataset.icon = playIcon;
      play.setAttribute('aria-label', replay.playing ? '暂停回放' : '播放回放');
    }
    const liveBtn = $('replay-live');
    liveBtn.classList.toggle('on', replay.idx === null);
    liveBtn.setAttribute('aria-pressed', String(replay.idx === null));
    $('replay-start').disabled = replay.idx === 0;
    $('replay-back').disabled = upto <= 0;
    $('replay-fwd').disabled = replay.idx === null || upto >= all.length;
    const t0 = all.length ? msgMs(all[0]) : 0;
    const label = $('replay-label');
    if (replay.idx === null) {
      label.innerHTML = `<b>${all.length} 条消息</b>` + (all.length > 1 ? `，耗时 ${esc(fmtDur(msgMs(all[all.length - 1]) - t0))}` : '');
    } else {
      label.innerHTML = `第 <b>${upto}</b> / ${all.length} 条` + (current ? ` · #${current.seq} · ${esc(fmtClock(msgMs(current)))} (+${esc(fmtDur(msgMs(current) - t0))})` : '');
    }
    const cap = $('replay-caption');
    if (!current) {
      cap.classList.add('hidden');
      cap.innerHTML = '';
      return;
    }
    cap.classList.remove('hidden');
    cap.innerHTML = `<div class="msg-head">
          <span class="msg-who">
            <span class="msg-author">${esc(current.agent)}</span>
            ${recipientsHtml(current)}
          </span>
          <span class="ts" title="${esc(`#${current.seq} · ${fmtFull(msgMs(current))}`)}">${esc(fmtClock(msgMs(current)))}</span>
        </div>
        <div class="msg-body md open">${msgBodyHtml(current, { stripMentions: false })}</div>`;
    sizeReplayCaption();
  }

  // Lets the replay caption's body grow to the bottom of the pane (less the
  // caption's and .main's bottom padding) before it scrolls. Measured from the
  // top of the document, so the room does not depend on the scroll position.
  function sizeReplayCaption() {
    const cap = $('replay-caption');
    const body = cap.querySelector('.msg-body');
    if (!body) return;
    const capPad = parseFloat(getComputedStyle(cap).paddingBottom) || 0;
    const mainPad = parseFloat(getComputedStyle(document.querySelector('.main')).paddingBottom) || 0;
    const top = body.getBoundingClientRect().top + window.scrollY;
    cap.style.setProperty('--caption-room', `${Math.floor(window.innerHeight - top - capPad - mainPad)}px`);
  }

  function replayDelay(all, idx) {
    const speed = parseFloat($('replay-speed').value) || 1;
    if ($('replay-timing').value === 'even' || idx <= 0 || idx >= all.length)
      return 1400 / speed;
    // Real-time, compressed: 1 minute of wall time = 1 second at 1x, clamped.
    const gap = msgMs(all[idx]) - msgMs(all[idx - 1]);
    return Math.min(4000, Math.max(250, (gap || 0) / 60 / speed));
  }

  function replayStop() {
    replay.playing = false;
    clearTimeout(replay.timer);
    replay.timer = null;
  }

  function replayTick() {
    const all = graphMsgs();
    if (replay.idx === null || replay.idx >= all.length) {
      replayStop();
      renderGraph();
      return;
    }
    replay.idx += 1;
    renderGraph();
    if (replay.idx >= all.length) {
      replayStop();
      renderGraph();
      return;
    }
    replay.timer = setTimeout(replayTick, replayDelay(all, replay.idx));
  }

  function replaySeek(idx) {
    replayStop();
    replay.idx = Math.max(0, Math.min(idx, graphMsgs().length));
    renderGraph();
  }

  function replayToggle() {
    if (replay.playing) {
      replayStop();
      renderGraph();
      return;
    }
    const n = graphMsgs().length;
    if (!n) return;
    if (replay.idx === null || replay.idx >= n) replay.idx = 0;
    replay.playing = true;
    replay.timer = setTimeout(replayTick, 300);
    renderGraph();
  }

  function replayLive() {
    replayStop();
    replay.idx = null;
    renderGraph();
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderRaw() {
    const s = state.snap;
    const text = s.raw?.[state.rawKind] ?? '';
    const file = { members: 'members.json', board: 'board.jsonl', view: 'view.json' }[state.rawKind] || '';
    const lines = text ? text.split('\n').filter(Boolean).length : 0;
    const dir = state.rawKind === 'view' ? s.view?.dir || s.dir : s.dir;
    const path = dir ? `${dir}/${file}` : file;
    // The path ellipsizes from the left (dir=rtl) so the file name stays visible.
    $('raw-meta').innerHTML = `<span class="path" title="${esc(path)}"><span dir="ltr">${esc(path)}</span></span>` +
        `<span class="size">· ${esc(fmtBytes(text.length))}${state.rawKind === 'board' ? ` · ${lines} 行` : ''}</span>`;
    const shown = text || '(空)';
    // Avoid resetting the user's text selection when nothing changed.
    if ($('raw').textContent !== shown) $('raw').textContent = shown;
    document.querySelectorAll('.raw-btn').forEach((b) => {
      const on = b.dataset.raw === state.rawKind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  // ---------- overview (narrator) ----------
  // Must match main.mjs ROLE_WORKER_RE: role workers are recognised
  // generically by m.role (anything other than 'worker' and 'coordinator'),
  // with a name regex fallback for older boards.
  const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/;
  const roleOf = (m) => {
    if (!m || typeof m !== 'object') return '';
    if (m.role && m.role !== 'worker') return m.role;
    const match = String(m.name ?? '').match(/^(narrator|monitor)(?:-\d+)?$/);
    return match ? match[1] : m.role || '';
  };
  const isRoleWorker = (m) => {
    if (typeof m === 'string') m = memberOf(m) || { name: m };
    if (!m || typeof m !== 'object') return false;
    return Boolean(
      m.roleWorker ||
      (m.role && m.role !== 'worker' && m.role !== 'coordinator') ||
      ROLE_WORKER_RE.test(String(m.name ?? ''))
    );
  };
  const WATCHDOG_MS = 3000;          // READY / RENDERED deadline while visible
  const FRAME_MSG_MAX = 8 * 1024;    // largest message accepted from the frame
  const ITEM_ID_RE = /^[a-z0-9-]{1,40}$/;
  const STALE_LAG = 10;              // posts behind before the view is stale
  const STALE_IDLE_MS = 60 * 1000;   // ...or idle this long with unread posts
  const WS_STATES = ['active', 'blocked', 'review', 'queued', 'done', 'failed'];
  const ATT_KINDS = ['decision', 'failure', 'review', 'stuck', 'quota', 'error', 'fyi'];
  const SEVERITIES = ['high', 'med', 'low'];
  const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; " +
      "form-action 'none'; base-uri 'none'";
  const FRAME_INBOUND = new Set(['READY', 'RENDERED', 'ERROR', 'NAVIGATE', 'FEEDBACK_INTENT']);
  // Host theme tokens handed to the frame, each with the local token that
  // carries its standalone fallback.
  const THEME_TOKENS = [
    ['--background', '--sw-bg'], ['--foreground', '--sw-fg'], ['--card', '--sw-card'],
    ['--card-foreground', '--sw-fg'], ['--card-border', '--sw-card-border'], ['--border', '--sw-border'],
    ['--primary', '--sw-primary'], ['--primary-foreground', '--sw-primary-fg'],
    ['--secondary', '--sw-secondary'], ['--secondary-foreground', '--sw-fg-2'],
    ['--muted', '--sw-muted'], ['--muted-foreground', '--sw-fg-muted'],
    ['--accent', '--sw-fill'], ['--accent-foreground', '--sw-fg'], ['--error', '--sw-error'],
    ['--placeholder', '--sw-fg-faint'], ['--code-foreground', '--sw-fg'], ['--ring', '--sw-ring'],
    ['--font-family', '--sw-font'], ['--editor-font-family', '--sw-mono'],
  ];
  const PLAIN_KEY = 'swarm_board.narrator_plain';
  // The Overview drawn here is the default; the narrator's own page (view.html
  // in the sandboxed frame) is opt-in and remembered.
  const prefs = { plain: params.get('narrator') !== 'frame' && lsGet(PLAIN_KEY) !== '0' };

  // ----- view.json validation (the file is untrusted, whoever wrote it) -----
  const str = (v, max) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').slice(0, max).trim();
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === 'object') : []);
  const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

  // `url` actions open only https links on the hosts main.mjs lists in
  // snap.urlHosts (or their subdomains).
  function hostAllowed(host, snap) {
    const h = host.toLowerCase();
    return Array.isArray(snap.urlHosts) && snap.urlHosts.some((d) => h === d || h.endsWith(`.${d}`));
  }

  // A navigation action checked against the current snapshot, or null. Used
  // for actions listed in view.json and for NAVIGATE messages alike.
  function checkAction(a, snap) {
    if (!a || typeof a !== 'object' || !snap) return null;
    const label = str(a.label, 60);
    switch (a.type) {
      case 'open_conv': {
        const m = typeof a.target === 'string' ? snap.members.find((x) => x.name === a.target) : null;
        return m?.conversation_id ? { type: 'open_conv', target: m.name, label: label || `打开 ${m.name}` } : null;
      }
      case 'board_post': {
        const seq = typeof a.target === 'string' && /^\d{1,9}$/.test(a.target) ? Number(a.target) : a.target;
        return posInt(seq) && seq <= snap.head ? { type: 'board_post', target: seq, label: label || `#${seq}` } : null;
      }
      case 'url': {
        if (typeof a.target !== 'string' || a.target.length > 2048) return null;
        let u;
        try {
          u = new URL(a.target);
        } catch {
          return null;
        }
        if (u.protocol !== 'https:' || u.username || u.password || !hostAllowed(u.hostname, snap)) return null;
        return { type: 'url', target: u.href, label: label || u.hostname };
      }
      case 'file': {
        // Only exact paths main.mjs canonicalized (under <appData>/brain/).
        const files = snap.allowedFiles || {};
        if (typeof a.target !== 'string' || !Object.hasOwn(files, a.target)) return null;
        return { type: 'file', target: a.target, label: label || a.target.split('/').pop() };
      }
      default:
        return null;
    }
  }

  function cleanRefs(refs, snap) {
    const out = [];
    for (const r of list(refs, 12)) {
      if (posInt(r.seq)) out.push({ seq: r.seq, unverified: r.seq > snap.head });
      else if (typeof r.member === 'string' && r.member) {
        const name = str(r.member, 60);
        out.push({ member: name, unverified: !snap.members.some((m) => m.name === name) });
      }
    }
    return out;
  }

  const sanSources = new WeakMap();
  const sanitizeShort = (sh) => (sh && typeof sh === 'object' && !Array.isArray(sh)
    ? { title: str(sh.title, 60), line: str(sh.line, 90) }
    : undefined);

  // The validated copy of view.json that both the plain view and the frame
  // get: closed enums, clamped strings and lists, actions that pass
  // checkAction, refs marked unverified (seq past the head, or not on the
  // roster) and items with no ref marked uncited. Returns {view, ids}.
  function sanitizeView(v, snap) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const ids = new Set();
    const itemId = (x) => {
      const id = typeof x === 'string' && ITEM_ID_RE.test(x) ? x : '';
      if (id) ids.add(id);
      return id;
    };
    const actions = (as) => list(as, 6).map((a) => checkAction(a, snap)).filter(Boolean);
    const base = (it) => {
      const refs = cleanRefs(it.refs, snap);
      return { id: itemId(it.id), refs, uncited: refs.length === 0, actions: actions(it.actions) };
    };
    const rank = (arr, x) => (arr.includes(x) ? arr.indexOf(x) : arr.length);
    const attention = list(v.attention, 30).map((a) => {
      const san = {
        ...base(a),
        kind: ATT_KINDS.includes(a.kind) ? a.kind : 'fyi',
        severity: SEVERITIES.includes(a.severity) ? a.severity : 'low',
        title: str(a.title, 200),
        why: str(a.why, 400),
      };
      sanSources.set(san, a);
      return san;
    }).filter((a) => a.title);
    // Ranked decision > failure > review > stuck > quota/error > fyi, then by severity.
    attention.sort((a, b) => rank(ATT_KINDS, a.kind) - rank(ATT_KINDS, b.kind) ||
        rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity));
    const workstreams = list(v.workstreams, 40).map((w) => {
      const san = {
        ...base(w),
        title: str(w.title, 160),
        owners: (Array.isArray(w.owners) ? w.owners.slice(0, 8) : []).map((o) => str(o, 60)).filter(Boolean),
        state: WS_STATES.includes(w.state) ? w.state : 'queued',
        note: str(w.note, 300),
      };
      sanSources.set(san, w);
      return san;
    }).filter((w) => w.title);
    const textItems = (arr) => list(arr, 30).map((m) => ({ ...base(m), text: str(m.text, 300) })).filter((m) => m.text);
    const phase = v.phase && typeof v.phase === 'object' ? {
      label: str(v.phase.label, 40),
      index: posInt(v.phase.index),
      total: posInt(v.phase.total),
    } : null;
    const ack = v.feedback_ack && typeof v.feedback_ack === 'object' ? {
      through_seq: posInt(v.feedback_ack.through_seq),
      text: str(v.feedback_ack.text, 300),
    } : null;
    return {
      ids,
      view: {
        version: posInt(v.version) || 1,
        as_of_seq: posInt(v.as_of_seq),
        updated_at: str(v.updated_at, 40),
        headline: str(v.headline, 300),
        phase: phase?.label ? phase : null,
        attention,
        workstreams,
        milestones: textItems(v.milestones),
        risks: textItems(v.risks),
        feedback_ack: ack?.text ? ack : null,
      },
    };
  }

  function translateViewTier1(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const out = { ...v };
    if (typeof out.headline === 'string') out.headline = tier1Fallback(out.headline);
    if (typeof out.running_summary === 'string') out.running_summary = tier1Fallback(out.running_summary);
    if (out.phase && typeof out.phase === 'object') {
      out.phase = { ...out.phase, label: typeof out.phase.label === 'string' ? tier1Fallback(out.phase.label) : out.phase.label };
    }
    if (out.goal && typeof out.goal === 'object') {
      out.goal = {
        ...out.goal,
        title: typeof out.goal.title === 'string' ? tier1Fallback(out.goal.title) : out.goal.title,
        line: typeof out.goal.line === 'string' ? tier1Fallback(out.goal.line) : out.goal.line,
      };
    }
    const trShort = (sh) => (sh && typeof sh === 'object'
      ? { ...sh, title: typeof sh.title === 'string' ? tier1Fallback(sh.title) : sh.title, line: typeof sh.line === 'string' ? tier1Fallback(sh.line) : sh.line }
      : sh);
    if (Array.isArray(out.attention)) {
      out.attention = out.attention.map((a) => (a && typeof a === 'object' ? {
        ...a,
        title: typeof a.title === 'string' ? tier1Fallback(a.title) : a.title,
        why: typeof a.why === 'string' ? tier1Fallback(a.why) : a.why,
        short: trShort(a.short),
      } : a));
    }
    if (Array.isArray(out.workstreams)) {
      out.workstreams = out.workstreams.map((w) => (w && typeof w === 'object' ? {
        ...w,
        title: typeof w.title === 'string' ? tier1Fallback(w.title) : w.title,
        note: typeof w.note === 'string' ? tier1Fallback(w.note) : w.note,
        short: trShort(w.short),
      } : w));
    }
    if (Array.isArray(out.threads)) {
      out.threads = out.threads.map((t) => (t && typeof t === 'object' ? {
        ...t,
        title: typeof t.title === 'string' ? tier1Fallback(t.title) : t.title,
        goal: typeof t.goal === 'string' ? tier1Fallback(t.goal) : t.goal,
        now: typeof t.now === 'string' ? tier1Fallback(t.now) : t.now,
      } : t));
    }
    if (Array.isArray(out.milestones)) {
      out.milestones = out.milestones.map((m) => (m && typeof m === 'object'
        ? { ...m, text: typeof m.text === 'string' ? tier1Fallback(m.text) : m.text } : m));
    }
    if (Array.isArray(out.risks)) {
      out.risks = out.risks.map((r) => (r && typeof r === 'object'
        ? { ...r, text: typeof r.text === 'string' ? tier1Fallback(r.text) : r.text } : r));
    }
    if (out.now && typeof out.now === 'object' && !Array.isArray(out.now)) {
      const nowMap = Object.create(null);
      for (const [k, val] of Object.entries(out.now)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        nowMap[k] = typeof val === 'string' ? tier1Fallback(val) : val;
      }
      out.now = nowMap;
    }
    if (out.feedback_ack && typeof out.feedback_ack === 'object') {
      out.feedback_ack = {
        ...out.feedback_ack,
        text: typeof out.feedback_ack.text === 'string' ? tier1Fallback(out.feedback_ack.text) : out.feedback_ack.text,
      };
    }
    return out;
  }

  function translatePlanTier1(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
    const out = { ...p };
    if (out.goal && typeof out.goal === 'object') {
      out.goal = {
        ...out.goal,
        title: typeof out.goal.title === 'string' ? tier1Fallback(out.goal.title) : out.goal.title,
        line: typeof out.goal.line === 'string' ? tier1Fallback(out.goal.line) : out.goal.line,
      };
    }
    if (out.tasks && typeof out.tasks === 'object' && !Array.isArray(out.tasks)) {
      const tasks = Object.create(null);
      for (const [k, val] of Object.entries(out.tasks)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        tasks[k] = typeof val === 'string' ? tier1Fallback(val) : val;
      }
      out.tasks = tasks;
    }
    if (Array.isArray(out.threads)) {
      out.threads = out.threads.map((t) => (t && typeof t === 'object' ? {
        ...t,
        title: typeof t.title === 'string' ? tier1Fallback(t.title) : t.title,
        goal: typeof t.goal === 'string' ? tier1Fallback(t.goal) : t.goal,
      } : t));
    }
    return out;
  }

  function sanitizePlan(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const goal = p.goal && typeof p.goal === 'object'
      ? { title: str(p.goal.title, 120), line: str(p.goal.line, 220) }
      : null;
    const tasks = Object.create(null);
    if (p.tasks && typeof p.tasks === 'object' && !Array.isArray(p.tasks)) {
      for (const [k, val] of Object.entries(p.tasks)) {
        const key = str(k, 80);
        if (key && key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && typeof val === 'string') {
          tasks[key] = str(val, 200);
        }
      }
    }
    const threads = list(p.threads, 20).map((t) => ({
      id: str(t.id || t.title, 48),
      title: str(t.title, 80),
      goal: str(t.goal, 160),
      tasks: Array.isArray(t.tasks) ? t.tasks.slice(0, 40).map((n) => str(n, 80)).filter(Boolean) : [],
    })).filter((t) => t.title);
    return { goal: goal?.title ? goal : null, tasks, threads };
  }

  function selectLocalizedView(s) {
    const rawView = s?.view?.json && typeof s.view.json === 'object' ? s.view.json : null;
    if (!rawView) return null;
    if (s.view_zh && typeof s.view_zh === 'object') return s.view_zh;
    return translateViewTier1(rawView);
  }

  function selectLocalizedPlan(s) {
    const rawPlan = s?.plan && typeof s.plan === 'object' ? s.plan : null;
    if (!rawPlan) return null;
    if (s.plan_zh && typeof s.plan_zh === 'object') return s.plan_zh;
    return translatePlanTier1(rawPlan);
  }

  const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  function sanitizeViewForHive(src, s) {
    if (!isPlainObj(src)) return null;
    const san = sanitizeView(src, s)?.view;
    if (!san) return null;
    const goal = isPlainObj(src.goal)
      ? { title: str(src.goal.title, 120), line: str(src.goal.line, 220) }
      : null;
    const running_summary = str(src.running_summary, 300);
    const threads = Array.isArray(src.threads)
      ? src.threads.slice(0, 12).filter(isPlainObj).map((t) => {
          const item = {
            id: str(t.id, 60),
            title: str(t.title, 120),
            goal: str(t.goal, 200),
            now: str(t.now, 120),
            state: str(t.state, 40),
            attention: Array.isArray(t.attention)
              ? t.attention.slice(0, 30).map((x) => str(x, 60)).filter(Boolean)
              : [],
          };
          if (Array.isArray(t.workstreams)) {
            item.workstreams = t.workstreams.slice(0, 40).map((x) => str(x, 60)).filter(Boolean);
          }
          return item;
        }).filter((t) => t.title)
      : [];
    const now = Object.create(null);
    if (isPlainObj(src.now)) {
      for (const [k, val] of Object.entries(src.now).slice(0, 40)) {
        const key = str(k, 60);
        const v = str(val, 80);
        if (key && key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && v) now[key] = v;
      }
    }
    let reel = null;
    if (isPlainObj(src.reel) && Array.isArray(src.reel.frames)) {
      const frames = src.reel.frames
        .slice(0, 24)
        .filter((f) => isPlainObj(f) && typeof f.path === 'string' && f.path.startsWith('/'))
        .map((f) => {
          const frame = {
            path: str(f.path, 400),
            caption: str(f.caption, 200),
            seq: posInt(f.seq),
          };
          if (typeof f.caption_zh === 'string') frame.caption_zh = str(f.caption_zh, 200);
          return frame;
        });
      if (frames.length) reel = { frames };
    }
    return {
      ...san,
      goal,
      running_summary,
      threads,
      now,
      reel,
      attention: (san.attention || []).map((sa) => {
        const orig = sanSources.get(sa);
        const short = sanitizeShort(orig?.short);
        return short ? { ...sa, short } : { ...sa };
      }),
      workstreams: (san.workstreams || []).map((sw) => {
        const orig = sanSources.get(sw);
        const short = sanitizeShort(orig?.short);
        const out = short ? { ...sw, short } : { ...sw };
        if (orig) {
          if (typeof orig.progress === 'number' && Number.isFinite(orig.progress) && orig.progress >= 0 && orig.progress <= 100) {
            out.progress = orig.progress;
          } else if (isPlainObj(orig.progress)) {
            const total = Number(orig.progress.total);
            if (Number.isFinite(total) && total > 0) {
              const doneRaw = Number(orig.progress.done);
              const done = Number.isFinite(doneRaw) ? Math.max(0, Math.min(total, doneRaw)) : 0;
              const label = str(orig.progress.label, 24);
              out.progress = label ? { done, total, label } : { done, total };
            }
          }
        }
        return out;
      }),
    };
  }

  function hiveSnap(s) {
    if (!s) return s;
    const rawViewSrc = s.view?.json && typeof s.view.json === 'object' ? s.view.json : null;
    const rawPlanSrc = s.plan && typeof s.plan === 'object' ? s.plan : null;
    const rawView = sanitizeViewForHive(rawViewSrc, s);
    const rawPlan = sanitizePlan(rawPlanSrc);
    const viewSrc = selectLocalizedView(s);
    const viewForHive = viewSrc === rawViewSrc ? rawView : sanitizeViewForHive(viewSrc, s);
    const planSelected = selectLocalizedPlan(s);
    const planSrc = planSelected === rawPlanSrc ? rawPlan : sanitizePlan(planSelected);
    return {
      ...s,
      rawView,
      rawPlan,
      _viewLocalized: true,
      _planLocalized: true,
      view_zh: null,
      plan_zh: null,
      view: s.view ? { ...s.view, json: viewForHive } : s.view,
      plan: planSrc,
    };
  }

  // ----- overview state -----
  const ov = {
    model: null,       // sanitizeView() of the current view.json
    bootstrap: null,   // narrator_bootstrap.js source, once fetched
  };
  const narratorOf = () => state.snap?.narrator || null;
  const liveNarrator = () => !!narratorOf() && !['absent', 'killed'].includes(state.snap.narratorState);
  // The pane opens on the Overview where the built-in Overview is on
  // (enable-swarm-overview), else once a live narrator has published a view.json.
  const hasOverview = () => !!state.snap?.builtinOverview || (liveNarrator() && !!ov.model);
  // The Overview tab exists where the built-in Overview is on, else once the
  // narrator has written a view.json or view.html; otherwise the pane is the plain Board.
  const viewExists = () => !!state.snap?.view?.exists;
  const overviewOn = () => !!state.snap?.builtinOverview || viewExists();
  // The Graph and Raw tabs exist only where their flags are on
  // (enable-swarm-graph-tab, enable-swarm-raw-tab).
  const graphOn = () => !!state.snap?.graphTab;
  const rawOn = () => !!state.snap?.rawTab;
  const coordinatorConv = () => {
    const s = state.snap;
    return s?.members.find((m) => m.role === 'coordinator')?.conversation_id || s?.id || '';
  };

  function autoSelectTab() {
    const on = overviewOn();
    $('tabbtn-overview').classList.toggle('hidden', !on);
    $('tabbtn-graph').classList.toggle('hidden', !graphOn());
    $('tabbtn-raw').classList.toggle('hidden', !rawOn());
    $('raw-btn-view').classList.toggle('hidden', !viewExists());
    if (!viewExists() && state.rawKind === 'view') {
      state.rawKind = 'members';
      renderRaw();
    }
    if ((!on && state.tab === 'overview') || (!graphOn() && state.tab === 'graph') ||
        (!rawOn() && state.tab === 'raw')) {
      selectTab('feed');
      return;
    }
    if (state.tabChosen) return;
    const want = hasOverview() ? 'overview' : 'feed';
    if (state.tab !== want) selectTab(want);
  }

  function noticeHtml() {
    const s = state.snap;
    const n = s?.narrator;
    if (!s) return '';
    if (s.narratorState === 'absent') return '此 Swarm 尚无讲述者。可请协调者添加。';
    if (s.narratorState === 'killed') {
      return `讲述者（<b>${esc(n.name)}</b>）已停止运行。可请协调者添加新的讲述者` +
          `（<code>${esc(nextNarratorName())}</code>）。`;
    }
    if (!ov.model) {
      if (s.view?.jsonError === 'too_large') return '讲述者的 view.json 超过 64 KB，因此未显示。';
      if (s.view?.jsonError === 'invalid') return '讲述者的 view.json 尚不是有效的 JSON。';
      return '讲述者尚未发布概览。';
    }
    return '';
  }

  function nextNarratorName() {
    let max = 0;
    for (const m of members()) {
      const g = m.name.match(/^narrator(?:-(\d+))?$/);
      if (g) max = Math.max(max, g[1] ? Number(g[1]) : 1);
    }
    return `narrator-${max + 1}`;
  }

  const ago = (ms) => (Number.isFinite(ms) && ms > 0 ? `${fmtDur(Date.now() - ms)}前` : '');
  const STATE_BADGE = {
    working: ['正在更新', '讲述者正在更新概览'],
    waiting: ['等待更新', '讲述者正在等待新的看板消息'],
    killed: ['已停止', '讲述者已被终止，概览不再更新'],
  };

  // The trusted chrome around the view: narrator status, freshness, system
  // items, notices, footer. Cheap; re-run on the ticker for the clocks.
  function renderOverviewChrome() {
    const s = state.snap;
    if (!s || !overviewOn()) return;
    const n = s.narrator;
    const v = ov.model?.view;
    const trDetail = (zh, raw) => {
      const r = String(raw || '');
      if (zh && String(zh).trim()) return String(zh);
      return r ? tier1Fallback(r) : '';
    };
    // Status line.
    let status = '';
    if (n) {
      const nDetail = trDetail(n.detail_zh, n.detail);
      const [label, tip] = s.narratorState === 'paused'
        ? [`已暂停：${n.reason === 'quota' ? '配额不足' : '发生错误'}`, `讲述者上一步执行失败：${nDetail}`]
        : STATE_BADGE[s.narratorState] || ['', ''];
      const read = Math.max(v?.as_of_seq || 0, n.last_read_seq || 0);
      const lag = Math.max(0, s.head - read);
      const idle = Date.now() - (n.transcriptMtime || 0);
      const stale = !!v && s.narratorState !== 'working' &&
          (lag >= STALE_LAG || (lag > 0 && idle > STALE_IDLE_MS));
      const updated = ago(s.view?.jsonMtime);
      status = `<span class="ov-who" title="${esc(`${n.name} · ${n.conversation_id}`)}">◉ ${esc(n.name)}</span>` +
          (label ? `<span class="badge ${esc(s.narratorState)}" data-testid="swarm-overview-badge" title="${esc(tip)}">${esc(label)}</span>` : '') +
          (stale ? `<span class="badge stale" data-testid="swarm-overview-stale" title="${esc(`概览已落后 ${lag} 条消息`)}">未及时更新</span>` : '') +
          '<span class="spacer"></span>' +
          `<span class="ov-fresh" data-testid="swarm-overview-freshness" title="${esc(`讲述者已读至 #${read} / ${s.head}`)}">` +
          `已读至 #${read}${updated ? ` · 更新于 ${esc(updated)}` : ''}</span>`;
    }
    if ($('ov-status').innerHTML !== status) $('ov-status').innerHTML = status;
    $('ov-status').classList.toggle('hidden', !status);

    // System items, from rosters and transcripts (not from the narrator).
    const sys = s.systemAttention || [];
    const canOpen = canOpenConversation();
    const sysHtml = sys.map((it) => {
      const sysText = it.text_zh || tier1Fallback(it.text);
      const sysDetail = trDetail(it.detail_zh, it.detail);
      const since = it.kind === 'stuck' && it.since ? `（已持续 ${fmtDur(Date.now() - it.since)}）` : '';
      return `<div class="ov-sys ${esc(it.kind)}" role="listitem" data-testid="swarm-overview-system-item" title="${esc(sysDetail)}">` +
          `<span class="ov-sys-icon" aria-hidden="true">⚠</span>` +
          `<span class="ov-sys-text"><b>系统:</b> ${esc(sysText)}${esc(since)}</span>` +
          (canOpen && it.conversation_id ? `<button type="button" class="ghost-btn sm" data-open="${esc(it.conversation_id)}">打开</button>` : '') +
          `</div>`;
    }).join('');
    if ($('ov-system').innerHTML !== sysHtml) $('ov-system').innerHTML = sysHtml;
    $('ov-system').classList.toggle('hidden', !sysHtml);

    const notice = noticeHtml();
    const lastGood = ov.model && s.view?.jsonError ?
      '正在显示上次有效的 view.json；当前文件' + (s.view.jsonError === 'too_large' ? '超过 64 KB。' : '不是有效的 JSON。') : '';
    const noticeText = notice || lastGood;
    if ($('ov-notice').innerHTML !== noticeText) $('ov-notice').innerHTML = noticeText;
    $('ov-notice').classList.toggle('hidden', !noticeText);

    // Footer: how to change the view, and the narrator's last acknowledgement.
    $('ov-footer').classList.toggle('hidden', !n && !ov.model);
    $('ov-open-coord').classList.toggle('hidden', !canOpen || !coordinatorConv());
    const ack = v?.feedback_ack;
    const ackHtml = ack ? `上次修改：“${esc(ack.text)}”${ack.through_seq ? ` <button type="button" class="ref" data-ov-seq="${ack.through_seq}">#${ack.through_seq}</button>` : ''}` : '';
    if ($('ov-ack').innerHTML !== ackHtml) $('ov-ack').innerHTML = ackHtml;
    $('ov-ack').classList.toggle('hidden', !ackHtml);

    // Tab badge: only the coordinator stopping for the user needs them: its turn
    // ended on a reply with no worker still at work, or it failed or ran out of
    // quota. Workers' asks go to the coordinator.
    const coord = (s.members || []).find((m) => m.role === 'coordinator' && !m.killed);
    const msgs = s.messages || [];
    const lastMsg = msgs[msgs.length - 1];
    const swarmDone = !!coord && lastMsg?.agent === coord.name && /^\[done\]/i.test(String(lastMsg.text || '').trim());
    const coordSys = coord ? sys.filter((it) => it.member === coord.name).length : 0;
    const anyWorking = (s.members || []).some((m) => m.status === 'working' && !isRoleWorker(m));
    const want = swarmDone ? 0 : coordSys + (coord?.status === 'waiting' && coord.replied && !anyWorking ? 1 : 0);
    $('tab-badge-overview').textContent = want ? String(want) : '';
    $('tab-badge-overview').classList.toggle('hidden', !want);
  }

  // Why the plain view is shown instead of the frame ('' = frame is fine).
  function plainReason() {
    const view = state.snap?.view;
    if (!view?.html) return view?.htmlError === 'too_large' ? 'view.html 超过 64 KB' : '尚无 view.html';
    if (frame.failed && frame.failed.htmlKey === view.htmlKey) return `讲述者视图加载失败（${frame.failed.reason}）`;
    if (!ov.bootstrap) return '正在加载讲述者视图';
    return '';
  }

  function renderOverview() {
    const s = state.snap;
    if (!s) return;
    const viewSrc = selectLocalizedView(s);
    ov.model = overviewOn() && viewSrc ? sanitizeView(viewSrc, s) : null;
    renderOverviewChrome();
    const label = $('ov-label');
    if (!ov.model) {
      frameTeardown();
      label.classList.add('hidden');
      $('ov-frame').classList.add('hidden');
      // No narrator notes yet: hive.js still draws the Overview from the
      // board and roster.
      $('ov-plain').classList.remove('hidden');
      $('tab-overview').classList.add('clean');
      window.SwarmHive.update(hiveSnap(s), $('ov-plain'), { view: 'overview' });
      return;
    }
    const reason = plainReason();
    const plain = prefs.plain || !!reason;
    label.classList.remove('hidden');
    const mode = $('ov-mode');
    // The toggle offers the frame back unless it can't be shown at all.
    const canFrame = !!s.view?.html;
    mode.textContent = plain ? (frame.failed && canFrame ? '重新加载讲述者页面' : '讲述者页面') : '概览';
    mode.setAttribute('aria-pressed', String(plain));
    // With the built-in Overview it is the only one offered; the toggle shows
    // only to get back from the narrator's page (?narrator=frame or an earlier
    // choice). Otherwise it offers the narrator's page whenever there is one.
    mode.classList.toggle('hidden', s.builtinOverview ? plain : plain && !canFrame);
    label.querySelector('.ov-label-text').textContent = plain ?
      `概览 · 来自讲述者的记录${reason && !prefs.plain ? ` · ${reason}` : ''}` : '讲述者页面 · 由 AI 生成';
    $('ov-frame').classList.toggle('hidden', plain);
    $('ov-plain').classList.toggle('hidden', !plain);
    $('tab-overview').classList.toggle('clean', plain);
    if (plain) {
      frameTeardown();
      window.SwarmHive.update(hiveSnap(s), $('ov-plain'), { view: 'overview' });
    } else {
      frameSync();
    }
  }

  // ----- actions (from the plain view, or validated NAVIGATE from the frame) -----
  function performAction(raw) {
    const a = checkAction(raw, state.snap);
    if (!a) {
      toast('此链接在这里不被允许打开。');
      return;
    }
    if (a.type === 'open_conv') {
      const m = memberOf(a.target);
      if (m.local === false || canOpenConversation()) openConversation(m.conversation_id);
      else toast(`打开 ${a.target} 的会话需要在桌面应用中使用。`);
    } else if (a.type === 'board_post') {
      goToPost(a.target);
    } else if (a.type === 'url') {
      window.open(a.target, '_blank', 'noopener,noreferrer');
    } else if (a.type === 'file') {
      const uri = state.snap.allowedFiles[a.target];
      if (window.sidecar?.ui?.toggleAuxPane) window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
      else toast('打开文件需要在桌面应用中使用。');
    }
  }

  function clearFilters() {
    $('f-agent').value = '';
    $('f-mention').value = '';
    $('f-search').value = '';
    $('f-agent').classList.remove('set');
    $('f-mention').classList.remove('set');
    state.hiddenAgents.clear();
    state.channel = '';
    renderAgents();
    renderChannels();
    renderFeed();
  }

  function goToPost(seq) {
    const s = state.snap;
    if (!s || !posInt(seq)) return;
    if (!s.messages?.some((m) => m.seq === seq)) return;
    state.stick = false;
    selectTab('feed', false, true);
    let el = $('feed').querySelector(`[data-seq="${seq}"]`);
    if (!el && filtersActive()) {
      clearFilters();
      el = $('feed').querySelector(`[data-seq="${seq}"]`);
    }
    if (!el) return;
    state.stick = false;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('target');
    void el.offsetWidth;
    el.classList.add('target');
    setTimeout(() => el.classList.remove('target'), 1800);
    updateJump();
  }

  // Feedback starts in the coordinator's chat (the coordinator relays it to
  // the narrator). Only the item id is copied; nothing from the narrator.
  async function feedbackIntent(id) {
    if (typeof id !== 'string' || !ITEM_ID_RE.test(id) || !ov.model?.ids.has(id)) return;
    const text = `对卡片 ${id} 的反馈: `;
    const copied = await copyText(text);
    const conv = coordinatorConv();
    // A coordinator on another machine can't be opened here: say where it
    // runs in this toast rather than replacing openConversation's.
    const remote = members().find((m) => m.conversation_id === conv && m.local === false);
    if (remote) {
      toast(`${copied ? `已复制“${text.trim()}”。请将其粘贴` : `请告知“${text.trim()} …”`}给 ${remote.owner?.label || '对应机器'} 上的协调者。`);
      return;
    }
    if (canOpenConversation() && conv) openConversation(conv);
    toast(copied ? `已复制“${text.trim()}”。请粘贴给协调者并说明你希望修改的内容。` :
      `请告知协调者：“${text.trim()} …”`);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through: the clipboard API may be blocked in the host's iframe.
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  // ----- NarratorFrameHost: the sandboxed frame running view.html -----
  const frame = {
    el: null,        // the iframe
    htmlKey: '',     // the view.html it was built from
    loads: 0,        // load events; a second one means it navigated itself
    ready: false,    // READY received
    sent: '',        // JSON of the data the frame has (embedded or posted)
    awaiting: '',    // 'READY' | 'RENDERED' | ''
    timer: 0,        // watchdog for `awaiting`
    failed: null,    // {htmlKey, reason}: plain view until view.html changes
    spent: false,    // a gated action already used the current user activation
  };

  function themeTokens() {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const [name, local] of THEME_TOKENS) {
      const v = (cs.getPropertyValue(name).trim() || cs.getPropertyValue(local).trim());
      // Tokens go into a <style> in the srcdoc: keep them to plain values.
      if (v && v.length <= 200 && !/[;{}<>\\]|url\(|expression/i.test(v)) out[name] = v;
    }
    return out;
  }
  const scheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

  function framePayload() {
    const s = state.snap;
    return {
      view: ov.model.view,
      meta: {
        head: s.head,
        narrator: s.narrator?.name || '',
        members: s.members.filter((m) => !isRoleWorker(m)).map((m) => ({ name: m.name, role: roleOf(m), status: m.status })),
      },
    };
  }

  function buildSrcdoc(html, payload) {
    const tokens = themeTokens();
    const css = `:root{${Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(';')};color-scheme:${scheme()}}` +
        'html,body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--font-family,system-ui,sans-serif)}';
    // JSON in a <script> block: no "</script", no line separators.
    const data = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const boot = ov.bootstrap.replace(/<\/(script)/gi, '<\\/$1');
    // The CSP meta comes first so it governs everything after it. view.html
    // follows our head content directly, so a full document's own <head>
    // children still land in the head.
    return `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<style>${css}</style>` +
        `<script type="application/json" id="narrator-data">${data}</script>` +
        `<script>${boot}</script>\n` + html;
  }

  // Builds the frame when view.html changed; otherwise sends changed data.
  function frameSync() {
    const view = state.snap.view;
    if (frame.el && frame.htmlKey === view.htmlKey) {
      postData();
      return;
    }
    frameTeardown();
    const payload = framePayload();
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('title', '讲述者视图（由 AI 生成）');
    f.setAttribute('data-testid', 'swarm-overview-iframe');
    f.className = 'ov-iframe';
    f.addEventListener('load', () => {
      if (frame.el !== f) return;
      frame.loads++;
      // The bootstrap posts READY on DOMContentLoaded, which usually beats
      // the load event; only wait for READY if it hasn't come yet.
      if (frame.loads === 1) {
        if (!frame.ready) arm('READY');
      } else {
        frameFail('页面发生了跳转');
      }
    });
    f.srcdoc = buildSrcdoc(view.html, payload);
    frame.el = f;
    frame.htmlKey = view.htmlKey;
    frame.loads = 0;
    frame.ready = false;
    frame.sent = JSON.stringify(payload);
    $('ov-frame').replaceChildren(f);
  }

  function frameTeardown() {
    clearTimeout(frame.timer);
    frame.awaiting = '';
    if (frame.el) frame.el.remove();
    frame.el = null;
    frame.htmlKey = '';
    frame.ready = false;
    frame.sent = '';
  }

  function frameFail(reason) {
    if (!frame.el) return;
    frame.failed = { htmlKey: frame.htmlKey, reason };
    console.warn(`[swarm_board] narrator view failed: ${reason}`);
    frameTeardown();
    renderOverview();
  }

  function postToFrame(msg) {
    try {
      // The frame's origin is opaque ("null"), so '*' is the only target.
      frame.el?.contentWindow?.postMessage(msg, '*');
    } catch {
      // A torn-down frame; nothing to send to.
    }
  }

  function postData() {
    if (!frame.el || !frame.ready || !ov.model) return;
    const payload = framePayload();
    const json = JSON.stringify(payload);
    if (json === frame.sent) return;
    frame.sent = json;
    postToFrame({ type: 'DATA_UPDATE', ...payload });
    arm('RENDERED');
  }

  function postTheme() {
    if (frame.el && frame.ready) postToFrame({ type: 'THEME', tokens: themeTokens(), scheme: scheme() });
  }

  // Watchdogs run only while the frame is on screen: a hidden frame may be
  // throttled, and a slow frame nobody is looking at is no failure.
  const frameVisible = () => !!frame.el && state.view === 'board' && state.tab === 'overview' && !document.hidden;
  function arm(what) {
    frame.awaiting = what;
    syncWatchdog();
  }
  function syncWatchdog() {
    clearTimeout(frame.timer);
    if (!frame.awaiting || !frameVisible()) return;
    const what = frame.awaiting;
    frame.timer = setTimeout(() => frameFail(`${WATCHDOG_MS / 1000} 秒内未收到 ${what}`), WATCHDOG_MS);
  }
  function disarm(what) {
    if (frame.awaiting !== what) return;
    frame.awaiting = '';
    clearTimeout(frame.timer);
  }
  document.addEventListener('visibilitychange', syncWatchdog);

  // NAVIGATE and FEEDBACK_INTENT need a live user activation that came from
  // the frame, and get one action per activation: after one is taken, the
  // next must wait until that activation has expired. Activation is
  // page-wide (a click in the frame activates this page too, but so does a
  // click anywhere else here), and the frame can steal focus, so where the
  // input happened is decided by this page's own input events: input inside
  // the frame never reaches this document. If this page saw no input for
  // longer than an activation lasts (~5 s in Chrome) yet is activated, the
  // gesture was in the frame. The frame must also hold focus. Activation
  // turns on before this page's own input listeners run, so a frame posting
  // in a tight loop can see it first: the decision is therefore deferred by
  // GATE_SETTLE_MS and refused if this page saw input in the meantime. A frame
  // that posts gated messages faster than GATE_SPAM_MS apart is refused too
  // (one real click sends one message). The cost: a click in the frame within
  // ~5 s of a click in the chrome is refused once.
  const ACTIVATION_MS = 5500;
  const GATE_SETTLE_MS = 100;
  const GATE_SPAM_MS = 250;
  let parentInputAt = -Infinity;
  let lastGatedMsgAt = -Infinity;
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
    document.addEventListener(type, () => { parentInputAt = performance.now(); }, { capture: true, passive: true });
  }
  // Calls onAllow() if the gated message just received may act, otherwise
  // onDeny(). Either callback runs asynchronously.
  function gate(onAllow, onDeny) {
    const receivedAt = performance.now();
    const spam = receivedAt - lastGatedMsgAt < GATE_SPAM_MS;
    lastGatedMsgAt = receivedAt;
    const ua = navigator.userActivation;
    const el = frame.el;
    if (spam || !ua?.isActive || frame.spent || !el || document.activeElement !== el ||
        receivedAt - parentInputAt <= ACTIVATION_MS) {
      setTimeout(onDeny, 0);
      return;
    }
    // Reserve this activation now so no other message can use it.
    frame.spent = true;
    const release = () => {
      if (navigator.userActivation.isActive) setTimeout(release, 200);
      else frame.spent = false;
    };
    setTimeout(() => {
      setTimeout(release, 200);
      const ok = parentInputAt < receivedAt && frame.el === el &&
          document.activeElement === el && navigator.userActivation.isActive;
      (ok ? onAllow : onDeny)();
    }, GATE_SETTLE_MS);
  }

  window.addEventListener('message', (e) => {
    if (!frame.el || e.source !== frame.el.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || !FRAME_INBOUND.has(d.type)) return;
    let size = Infinity;
    try {
      size = JSON.stringify(d).length;
    } catch {
      return;
    }
    if (size > FRAME_MSG_MAX) return;
    switch (d.type) {
      case 'READY':
        if (frame.ready) return;
        frame.ready = true;
        disarm('READY');
        // RENDERED follows from the bootstrap's first render.
        arm('RENDERED');
        postTheme();
        postData();
        return;
      case 'RENDERED': {
        disarm('RENDERED');
        const h = Number(d.height);
        if (Number.isFinite(h) && h > 0) frame.el.style.height = `${Math.min(20000, Math.max(120, Math.ceil(h)))}px`;
        return;
      }
      case 'ERROR':
        frameFail(`错误：${str(d.message, 500).split('\n')[0].slice(0, 160) || '未知错误'}`);
        return;
      case 'NAVIGATE': {
        const action = d.action;
        gate(() => performAction(action), () => toast('请点击视图中的链接以打开。'));
        return;
      }
      case 'FEEDBACK_INTENT': {
        const target = d.target_id;
        gate(() => feedbackIntent(target), () => {});
        return;
      }
    }
  });

  async function loadBootstrap() {
    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f('/narrator_bootstrap.js', { method: 'GET' });
      if (!res.ok) throw new Error(`narrator_bootstrap.js: ${res.status}`);
      ov.bootstrap = await res.text();
      if (state.snap) renderOverview();
    } catch (e) {
      console.warn(e);
      setTimeout(loadBootstrap, IDLE_POLL_MS);
    }
  }
  loadBootstrap();

  // Chrome and plain-view clicks are direct user gestures in this page.
  $('tab-overview').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) return openConversation(open.dataset.open);
    const seq = e.target.closest('[data-ov-seq]');
    if (seq) {
      if (seq.dataset.ovSeq) goToPost(Number(seq.dataset.ovSeq));
      return;
    }
  });
  $('ov-mode').addEventListener('click', () => {
    const toFrame = prefs.plain || !!frame.failed;
    prefs.plain = !toFrame;
    frame.failed = null;
    lsSet(PLAIN_KEY, prefs.plain ? null : '0');
    renderOverview();
  });
  $('ov-open-coord').addEventListener('click', () => openConversation(coordinatorConv()));

  // ---------- events ----------
  const TABS = ['overview', 'feed', 'members', 'graph', 'raw'];
  // byUser: an explicit choice, which stops the Overview/Board auto-pick.
  function selectTab(tab, focus = false, byUser = false) {
    if (byUser) state.tabChosen = true;
    document.querySelectorAll('.tab').forEach((x) => {
      const on = x.dataset.tab === tab;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      if (on && focus) x.focus();
    });
    document.querySelectorAll('.tab-body').forEach((x) => x.classList.toggle('active', x.id === `tab-${tab}`));
    state.tab = tab;
    if (state.snap && tab === 'graph') renderGraph();
    if (state.snap && tab === 'overview') renderOverview();
    if (state.snap && tab === 'members') renderMembers();
    if (state.snap && tab === 'feed') measureClamps();
    syncWatchdog();
    updateJump();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab, false, true)));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const tabs = TABS.filter((t) => !$(`tabbtn-${t}`).classList.contains('hidden'));
    const i = tabs.indexOf(state.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    selectTab(next, true, true);
  });
  ['f-agent', 'f-mention', 'f-search'].forEach((id) => $(id).addEventListener('input', () => {
    if (id !== 'f-search') $(id).classList.toggle('set', !!$(id).value);
    if (state.snap) renderFeed();
  }));
  $('f-toggle').addEventListener('click', () => setFiltersOpen($('filters').classList.contains('hidden')));
  $('f-channel').addEventListener('input', () => state.snap && setChannel($('f-channel').value));
  $('channel-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-channel]');
    if (t && state.snap) setChannel(t.dataset.channel);
  });
  $('channel-tabs').addEventListener('keydown', (e) => {
    if (!state.snap || !['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const tabs = [...$('channel-tabs').querySelectorAll('[data-channel]')];
    const i = tabs.findIndex((t) => t.dataset.channel === state.channel);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    e.preventDefault();
    setChannel(next.dataset.channel);
    $('channel-tabs').querySelector(`[data-channel="${CSS.escape(next.dataset.channel)}"]`)?.focus();
  });
  $('agents').addEventListener('click', (e) => {
    const c = e.target.closest('[data-agent]');
    if (!c) return;
    const name = c.dataset.agent;
    if (state.hiddenAgents.has(name)) state.hiddenAgents.delete(name); else state.hiddenAgents.add(name);
    renderAgents();
    renderFeed();
    // Keep keyboard focus on the toggled chip after the re-render.
    $('agents').querySelector(`[data-agent="${CSS.escape(name)}"]`)?.focus();
  });
  $('feed').addEventListener('click', (e) => {
    if (e.target.closest('[data-clear-filters]')) {
      clearFilters();
      return;
    }
    const chip = e.target.closest('.msg-channel[data-channel]');
    if (chip) {
      setChannel(chip.dataset.channel);
      return;
    }
    const seqRef = e.target.closest('[data-seq-ref], [data-ov-seq]');
    if (seqRef) {
      const targetSeq = Number(seqRef.dataset.seqRef || seqRef.dataset.ovSeq);
      if (targetSeq) goToPost(targetSeq);
      return;
    }
    let more = e.target.closest('.msg-more');
    // A click anywhere on a clamped Board row expands it (not on links,
    // buttons, or while selecting text).
    if (!more) {
      const row = e.target.closest('.feed .msg');
      if (!row || e.target.closest('a, button, input, [data-seq-ref]')) return;
      if (String(window.getSelection?.() || '').length) return;
      const btn = row.querySelector('.msg-more');
      if (!btn || btn.classList.contains('hidden')) return;
      more = btn;
    }
    const body = more.previousElementSibling;
    const seq = Number(more.closest('.msg').dataset.seq);
    const open = body.classList.toggle('open');
    more.textContent = open ? '收起' : '展开更多';
    more.setAttribute('aria-expanded', String(open));
    if (open) state.expanded.add(seq); else state.expanded.delete(seq);
    // Expanding a post grows the feed below it; don't let re-pinning to the
    // bottom scroll the post the user is reading out of view.
    if (open) state.stick = false;
  });
  $('jump-latest').addEventListener('click', () => scrollToLatest('smooth'));
  $('f-autoscroll').addEventListener('input', () => {
    if ($('f-autoscroll').checked && feedShown()) scrollToLatest();
  });
  window.addEventListener('scroll', () => {
    // Other tabs share the window's scroll position; only the feed's scrolling
    // says whether the user is following the newest post.
    if (feedShown()) state.stick = nearBottom();
    $('tab-feed').querySelector('.toolbar').classList.toggle('stuck', window.scrollY > 0);
    updateJump();
  }, { passive: true });
  // Keep --header-h (the sticky toolbar's offset) in sync with the header,
  // whose meta line can wrap, and re-pin the feed when its height changes.
  new ResizeObserver(() => {
    $('board').style.setProperty('--header-h', `${document.querySelector('.header').offsetHeight}px`);
  }).observe(document.querySelector('.header'));
  new ResizeObserver(keepPinned).observe($('feed'));
  $('graph').addEventListener('click', (e) => {
    const g = e.target.closest('.node');
    if (g?.dataset.conv) openConversation(g.dataset.conv);
  });
  $('replay-caption').addEventListener('click', (e) => {
    const seqRef = e.target.closest('[data-seq-ref], [data-ov-seq]');
    if (seqRef) {
      const targetSeq = Number(seqRef.dataset.seqRef || seqRef.dataset.ovSeq);
      if (targetSeq) goToPost(targetSeq);
    }
  });
  document.querySelectorAll('.raw-btn').forEach((b) => b.addEventListener('click', () => {
    state.rawKind = b.dataset.raw;
    if (state.snap) renderRaw();
  }));
  $('raw-copy').addEventListener('click', async () => {
    const label = $('raw-copy-label');
    try {
      await navigator.clipboard.writeText($('raw').textContent);
      label.textContent = '已复制';
    } catch {
      label.textContent = '复制失败';
    }
    setTimeout(() => { label.textContent = '复制'; }, 1200);
  });
  $('g-all').addEventListener('input', () => state.snap && renderGraph());
  $('g-hide-inactive')?.addEventListener('input', () => state.snap && renderGraph());
  $('replay-play').addEventListener('click', () => state.snap && replayToggle());
  $('replay-start').addEventListener('click', () => state.snap && replaySeek(0));
  $('replay-back').addEventListener('click', () => state.snap && replaySeek((replay.idx ?? graphMsgs().length) - 1));
  $('replay-fwd').addEventListener('click', () => state.snap && replaySeek((replay.idx ?? graphMsgs().length) + 1));
  $('replay-live').addEventListener('click', () => state.snap && replayLive());
  $('replay-slider').addEventListener('input', (e) => state.snap && replaySeek(parseInt(e.target.value, 10)));
  document.addEventListener('keydown', (e) => {
    if (state.tab !== 'graph' || !state.snap || e.target.matches('input, select, textarea, button, [role="tab"]')) return;
    if (e.key === ' ') { e.preventDefault(); replayToggle(); }
    else if (e.key === 'ArrowLeft') replaySeek((replay.idx ?? graphMsgs().length) - 1);
    else if (e.key === 'ArrowRight') replaySeek((replay.idx ?? graphMsgs().length) + 1);
  });
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (!state.snap) return;
      if (state.tab === 'graph') renderGraph();
      if (state.tab === 'feed') {
        measureClamps();
        keepPinned();
      }
    });
  });

  // URL params: ?tab=overview|feed|members|graph|raw; ?replay=N;
  // ?narrator=plain; ?conversationId=X stands in for the pane's conversation
  // when the page is opened standalone.
  if (urlTabChosen) selectTab(initialTab, false, true);
  if (params.get('replay'))
    replay.idx = parseInt(params.get('replay'), 10) || 0;
  $('replay-play').innerHTML = ICON.play;
  $('replay-play').dataset.icon = 'play';
  poll();
  // Member state and the date shown on clock times change with the clock, so
  // refresh them on a ticker.
  setInterval(() => {
    if (!state.snap || state.view !== 'board') return;
    renderMeta();
    if (state.tab === 'members') renderMembers();
    if (state.tab === 'overview') renderOverviewChrome();
  }, 5000);
})();
