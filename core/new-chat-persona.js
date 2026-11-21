/* New-chat persona draft: stages via Electron IPC before StartCascade and commits response cascadeId without EVER blocking chat creation. */
(function installNewChatPersona(root) {
  'use strict';
  if (!root || !root.document || root.__AGY_NEW_CHAT_PERSONA__) return;
  var doc = root.document;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var defaultMode = 'hakimi';
  var draftMode = defaultMode;
  var userTouchedDraft = false;
  var menuOpen = false;
  var pending = null;
  var PENDING_TTL_MS = 15000;
  var bindings = new Map();
  var currentFooter = null;
  var sawStartedView = false;
  var observer = null;
  var cleanupFns = [];
  var destroyed = false;
  var idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var uuidScanPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  var subagentRe = /subagent|message\s+subagent|子代理|子智能体/i;

  var PERSONA_OPTIONS = [
    {
      mode: 'hakimi',
      label: '哈基米',
      sub: '灵动猫娘 · 共享日常记忆'
    },
    {
      mode: 'normal',
      label: '正常助手',
      sub: '标准专业语气 · 独立无角色'
    }
  ];

  function makeToken() {
    return 'nc-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10);
  }

  function isLightTheme() {
    try {
      var hudCluster = doc.getElementById('agy-hud-footer-cluster');
      if (hudCluster && hudCluster.classList && hudCluster.classList.contains('agy-theme-light')) {
        return true;
      }
      if (root.localStorage && root.localStorage.getItem('agy_hud_theme_v2') === 'light') {
        return true;
      }
    } catch (_) {}
    return false;
  }

  function injectStyles() {
    if (doc.getElementById('agy-new-chat-persona-styles')) return;
    var uiFont = '"Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "MiSans", "PingFang SC", system-ui, sans-serif';
    var style = doc.createElement('style');
    style.id = 'agy-new-chat-persona-styles';
    style.textContent = [
      '.agy-ncp-wrap, .agy-ncp-menu {',
      '  font-family: ' + uiFont + ';',
      '  font-synthesis: none;',
      '  -webkit-font-smoothing: antialiased;',
      '  -moz-osx-font-smoothing: grayscale;',
      '  text-rendering: optimizeLegibility;',
      '  box-sizing: border-box;',
      '  user-select: none;',
      '}',
      '.agy-ncp-wrap {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  flex-shrink: 0;',
      '  margin-right: 2px;',
      '}',
      '.agy-ncp-btn {',
      '  appearance: none;',
      '  -webkit-appearance: none;',
      '  box-sizing: border-box;',
      '  margin: 0;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  height: 24px;',
      '  padding: 0 7px;',
      '  border-radius: 6px;',
      '  border: 1px solid transparent;',
      '  background: transparent;',
      '  font-family: ' + uiFont + ';',
      '  font-synthesis: none;',
      '  font-size: 12px;',
      '  line-height: 16px;',
      '  font-weight: 450;',
      '  color: rgba(161, 161, 170, 0.92);',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  outline: none;',
      '  transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;',
      '}',
      '.agy-ncp-btn:hover {',
      '  background: rgba(255, 255, 255, 0.06);',
      '  color: #f4f4f5;',
      '}',
      '.agy-ncp-btn[aria-expanded="true"] {',
      '  background: rgba(255, 255, 255, 0.09);',
      '  border-color: rgba(255, 255, 255, 0.1);',
      '  color: #f4f4f5;',
      '}',
      '.agy-ncp-btn:focus-visible {',
      '  border-color: rgba(56, 189, 248, 0.45);',
      '}',
      '.agy-ncp-icon {',
      '  flex-shrink: 0;',
      '  display: block;',
      '  color: currentColor;',
      '  transition: color 0.12s ease;',
      '}',
      '.agy-ncp-btn[data-persona-mode="hakimi"] .agy-ncp-icon {',
      '  color: rgba(56, 189, 248, 0.9);',
      '}',
      '.agy-ncp-btn[data-persona-mode="hakimi"]:hover .agy-ncp-icon,',
      '.agy-ncp-btn[data-persona-mode="hakimi"][aria-expanded="true"] .agy-ncp-icon {',
      '  color: #38bdf8;',
      '}',
      '.agy-ncp-label {',
      '  line-height: 16px;',
      '}',
      '.agy-ncp-chevron {',
      '  flex-shrink: 0;',
      '  display: block;',
      '  opacity: 0.55;',
      '  transition: transform 0.14s ease, opacity 0.12s ease;',
      '}',
      '.agy-ncp-btn:hover .agy-ncp-chevron {',
      '  opacity: 0.8;',
      '}',
      '.agy-ncp-btn[aria-expanded="true"] .agy-ncp-chevron {',
      '  transform: rotate(180deg);',
      '  opacity: 0.9;',
      '}',
      '.agy-ncp-menu {',
      '  position: fixed;',
      '  z-index: 2147483647;',
      '  width: 208px;',
      '  max-width: calc(100vw - 16px);',
      '  max-height: calc(100vh - 16px);',
      '  overflow-y: auto;',
      '  -webkit-app-region: no-drag;',
      '  background: rgba(20, 20, 24, 0.98);',
      '  backdrop-filter: blur(20px) saturate(160%);',
      '  -webkit-backdrop-filter: blur(20px) saturate(160%);',
      '  border: 1px solid rgba(255, 255, 255, 0.09);',
      '  border-radius: 10px;',
      '  padding: 4px;',
      '  box-shadow: 0 16px 36px -8px rgba(0, 0, 0, 0.78), 0 4px 12px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);',
      '  color: #f4f4f5;',
      '}',
      '.agy-ncp-menu-caption {',
      '  padding: 4px 8px 3px;',
      '  font-size: 10.5px;',
      '  line-height: 1.3;',
      '  font-weight: 500;',
      '  color: #71717a;',
      '}',
      '.agy-ncp-opt {',
      '  appearance: none;',
      '  -webkit-appearance: none;',
      '  box-sizing: border-box;',
      '  margin: 0;',
      '  width: 100%;',
      '  padding: 6px 8px;',
      '  border-radius: 7px;',
      '  border: 1px solid transparent;',
      '  background: transparent;',
      '  color: inherit;',
      '  font-family: inherit;',
      '  font-synthesis: none;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  cursor: pointer;',
      '  text-align: left;',
      '  outline: none;',
      '  transition: background-color 0.12s ease, border-color 0.12s ease;',
      '}',
      '.agy-ncp-opt + .agy-ncp-opt {',
      '  margin-top: 2px;',
      '}',
      '.agy-ncp-opt:hover {',
      '  background: rgba(255, 255, 255, 0.06);',
      '}',
      '.agy-ncp-opt[aria-selected="true"] {',
      '  background: rgba(56, 189, 248, 0.09);',
      '  border-color: rgba(56, 189, 248, 0.16);',
      '}',
      '.agy-ncp-opt:focus-visible {',
      '  border-color: rgba(56, 189, 248, 0.45);',
      '}',
      '.agy-ncp-opt-main {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  min-width: 0;',
      '  flex: 1;',
      '}',
      '.agy-ncp-opt-icon {',
      '  width: 22px;',
      '  height: 22px;',
      '  border-radius: 6px;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  flex-shrink: 0;',
      '  background: rgba(255, 255, 255, 0.045);',
      '  border: 1px solid rgba(255, 255, 255, 0.07);',
      '  color: #a1a1aa;',
      '  transition: color 0.12s ease, background-color 0.12s ease, border-color 0.12s ease;',
      '}',
      '.agy-ncp-opt[aria-selected="true"] .agy-ncp-opt-icon {',
      '  background: rgba(56, 189, 248, 0.14);',
      '  border-color: rgba(56, 189, 248, 0.28);',
      '  color: #38bdf8;',
      '}',
      '.agy-ncp-opt-text {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 1px;',
      '  min-width: 0;',
      '}',
      '.agy-ncp-opt-title {',
      '  font-size: 12px;',
      '  line-height: 15px;',
      '  font-weight: 500;',
      '  color: #f4f4f5;',
      '  white-space: nowrap;',
      '}',
      '.agy-ncp-opt-sub {',
      '  font-size: 10.5px;',
      '  line-height: 13px;',
      '  font-weight: 400;',
      '  color: #71717a;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '.agy-ncp-opt[aria-selected="true"] .agy-ncp-opt-sub {',
      '  color: #94a3b8;',
      '}',
      '.agy-ncp-opt-check {',
      '  flex-shrink: 0;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  color: #38bdf8;',
      '  opacity: 0;',
      '  transition: opacity 0.12s ease;',
      '}',
      '.agy-ncp-opt[aria-selected="true"] .agy-ncp-opt-check {',
      '  opacity: 1;',
      '}',
      /* Light theme overrides matching hud-runtime.js */
      '.agy-ncp-wrap.agy-theme-light .agy-ncp-btn {',
      '  background: rgba(255, 255, 255, 0.88);',
      '  border-color: rgba(15, 23, 42, 0.1);',
      '  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);',
      '  color: #334155;',
      '}',
      '.agy-ncp-wrap.agy-theme-light .agy-ncp-btn:hover,',
      '.agy-ncp-wrap.agy-theme-light .agy-ncp-btn[aria-expanded="true"] {',
      '  background: #ffffff;',
      '  border-color: rgba(79, 70, 229, 0.3);',
      '  color: #0f172a;',
      '}',
      '.agy-ncp-wrap.agy-theme-light .agy-ncp-btn:focus-visible,',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt:focus-visible {',
      '  border-color: rgba(2, 132, 199, 0.55);',
      '  box-shadow: 0 0 0 2px rgba(2, 132, 199, 0.18);',
      '}',
      '.agy-ncp-wrap.agy-theme-light .agy-ncp-btn[data-persona-mode="hakimi"] .agy-ncp-icon {',
      '  color: #0284c7;',
      '}',
      '.agy-ncp-menu.agy-theme-light {',
      '  background: rgba(255, 255, 255, 0.98);',
      '  border-color: rgba(15, 23, 42, 0.09);',
      '  box-shadow: 0 16px 36px -8px rgba(15, 23, 42, 0.18), 0 4px 12px rgba(15, 23, 42, 0.08);',
      '  color: #0f172a;',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-menu-caption {',
      '  color: #64748b;',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt:hover {',
      '  background: #f1f5f9;',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt[aria-selected="true"] {',
      '  background: rgba(2, 132, 199, 0.08);',
      '  border-color: rgba(2, 132, 199, 0.22);',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt-icon {',
      '  background: #f8fafc;',
      '  border-color: #e2e8f0;',
      '  color: #64748b;',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt[aria-selected="true"] .agy-ncp-opt-icon {',
      '  background: rgba(2, 132, 199, 0.12);',
      '  border-color: rgba(2, 132, 199, 0.28);',
      '  color: #0284c7;',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt-title {',
      '  color: #0f172a;',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt-sub {',
      '  color: #64748b;',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt[aria-selected="true"] .agy-ncp-opt-sub {',
      '  color: #475569;',
      '}',
      '.agy-ncp-menu.agy-theme-light .agy-ncp-opt-check {',
      '  color: #0284c7;',
      '}'
    ].join('\n');
    var parent = doc.head || doc.documentElement;
    if (parent) parent.appendChild(style);
  }

  function createPersonaIconSvg(mode, size) {
    var px = String(size || 13);
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'agy-ncp-icon');
    svg.setAttribute('width', px);
    svg.setAttribute('height', px);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    if (mode === 'normal') {
      var rect = doc.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', '2.25');
      rect.setAttribute('y', '3');
      rect.setAttribute('width', '11.5');
      rect.setAttribute('height', '10');
      rect.setAttribute('rx', '2.2');
      rect.setAttribute('stroke', 'currentColor');
      rect.setAttribute('stroke-width', '1.5');
      var promptPath = doc.createElementNS(SVG_NS, 'path');
      promptPath.setAttribute('d', 'M5.2 6.5L7.2 8.2L5.2 9.9M8.6 10H10.8');
      promptPath.setAttribute('stroke', 'currentColor');
      promptPath.setAttribute('stroke-width', '1.5');
      promptPath.setAttribute('stroke-linecap', 'round');
      promptPath.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(rect);
      svg.appendChild(promptPath);
    } else {
      var catPath = doc.createElementNS(SVG_NS, 'path');
      catPath.setAttribute('d', 'M3.2 2.6L2.5 8.8C2.5 11.7 4.9 13.5 8 13.5C11.1 13.5 13.5 11.7 13.5 8.8L12.8 2.6L10.1 5.3C9.4 5.1 8.7 5 8 5C7.3 5 6.6 5.1 5.9 5.3Z');
      catPath.setAttribute('stroke', 'currentColor');
      catPath.setAttribute('stroke-width', '1.5');
      catPath.setAttribute('stroke-linecap', 'round');
      catPath.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(catPath);
    }
    return svg;
  }

  function createChevronSvg() {
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'agy-ncp-chevron');
    svg.setAttribute('width', '10');
    svg.setAttribute('height', '10');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    var p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M3 4.5L6 7.5L9 4.5');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.4');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  function createCheckSvg() {
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    var p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M2.8 7.3L5.6 10.1L11.2 4.2');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  function findComposerContainer(node) {
    var box = (node.closest && node.closest('[data-testid="agent-input-box"], .surface-composer, .surface-composer-card')) || node.parentElement || node;
    if (box && !box.querySelector('[contenteditable="true"], textarea, [role="textbox"], [aria-placeholder], [placeholder], [data-placeholder]')) {
      for (var step = 0; step < 4 && box && box.parentElement; step++) {
        var parent = box.parentElement;
        if (parent === doc.body || parent === doc.documentElement) break;
        if (parent.querySelectorAll('.agy-composer-footer, .composer-footer').length > 1) break;
        box = parent;
        if (box.querySelector('[contenteditable="true"], textarea, [role="textbox"], [aria-placeholder], [placeholder], [data-placeholder]')) {
          break;
        }
      }
    }
    return box;
  }

  var SIDE_PANEL_SELECTOR = '[data-side-panel-composer], [data-testid="side-question-tab-composer"], [data-aux-pane-open="true"], [data-side-panel-open="true"], [data-side-panel-focus-scope="true"]';

  function isSubagentOrSideComposer(node) {
    if (!node) return false;
    if (node.closest && node.closest(SIDE_PANEL_SELECTOR)) return true;
    return isSubagentComposer(node);
  }

  function isHiddenBranch(node) {
    if (!node) return true;
    if (node.closest && node.closest('[hidden], [aria-hidden="true"]')) return true;
    var cur = node;
    while (cur && cur !== doc.documentElement) {
      if (cur.hidden) return true;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return true;
      if (cur.style && cur.style.display === 'none') return true;
      if (typeof root.getComputedStyle === 'function') {
        try {
          var cs = root.getComputedStyle(cur);
          if (cs && cs.display === 'none') return true;
        } catch (_) {}
      }
      if (cur === doc.body) break;
      cur = cur.parentElement;
    }
    return false;
  }

  function isSubagentComposer(node) {
    if (node.closest && node.closest(SIDE_PANEL_SELECTOR)) return true;

    var box = findComposerContainer(node);
    if (box) {
      if (box.querySelector('[title="Subagent"], [title="子代理"], [title="子智能体"]')) {
        return true;
      }

      var attrTargets = [box];
      var found = box.querySelectorAll('[aria-placeholder], [placeholder], [data-placeholder], [role="textbox"][aria-label], [contenteditable][aria-label], textarea[aria-label]');
      for (var i = 0; i < found.length; i++) attrTargets.push(found[i]);
      for (var j = 0; j < attrTargets.length; j++) {
        var el = attrTargets[j];
        if (!el || !el.getAttribute) continue;
        var ph = (el.getAttribute('aria-placeholder') || '') + ' ' +
                 (el.getAttribute('placeholder') || '') + ' ' +
                 (el.getAttribute('data-placeholder') || '') + ' ' +
                 (el.getAttribute('aria-label') || '');
        if (subagentRe.test(ph)) return true;
      }

      var btns = box.querySelectorAll('button, [role="button"]');
      for (var k = 0; k < btns.length; k++) {
        var b = btns[k];
        if (b.closest && b.closest('#agy-new-chat-persona')) continue;
        var bTxt = (b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
        if (subagentRe.test(bTxt)) return true;
      }

      // Catch Lexical/React visual placeholder overlays rendered as plain sibling divs outside textbox
      var nodes = box.querySelectorAll('div, span, p');
      var limit = Math.min(nodes.length, 80);
      for (var n = 0; n < limit; n++) {
        var item = nodes[n];
        if (item.children && item.children.length > 0) continue;
        if (item.closest && item.closest('[contenteditable="true"], textarea, input, [role="textbox"], #agy-new-chat-persona')) continue;
        if (/message\s+subagent|子代理|子智能体/i.test(item.textContent || '')) return true;
      }
    }

    var leftCluster = node.firstElementChild;
    if (leftCluster) {
      var leftBtns = leftCluster.querySelectorAll('button, [role="button"]');
      if ((leftCluster.tagName === 'BUTTON' || leftCluster.getAttribute('role') === 'button') &&
          (leftCluster.textContent || '').trim() === 'self') {
        return true;
      }
      for (var m = 0; m < leftBtns.length; m++) {
        if ((leftBtns[m].textContent || '').trim() === 'self') return true;
      }
    }

    return false;
  }

  function snapshotViewCascadeIds() {
    var map = Object.create(null);
    var views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
    for (var i = 0; i < views.length; i++) {
      var cid = views[i].getAttribute('data-cascade-id');
      if (cid && idPattern.test(cid)) map[cid.toLowerCase()] = true;
    }
    return map;
  }

  function detectNewViewCascadeId(knownIds) {
    var views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
    for (var i = 0; i < views.length; i++) {
      var cid = views[i].getAttribute('data-cascade-id');
      if (cid && idPattern.test(cid)) {
        if (!knownIds || !knownIds[cid.toLowerCase()]) return cid;
      }
    }
    return null;
  }

  function hasActiveStartedView() {
    var views = doc.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
    for (var i = 0; i < views.length; i++) {
      if (isHiddenBranch(views[i])) continue;
      var cid = views[i].getAttribute('data-cascade-id');
      if (cid && idPattern.test(cid)) return true;
    }
    return false;
  }

  function newFooter() {
    var hasStartedView = hasActiveStartedView();

    var nodes = doc.querySelectorAll('.agy-composer-footer, .composer-footer');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (isHiddenBranch(node)) continue;
      if (node.closest && node.closest(SIDE_PANEL_SELECTOR)) continue;

      var owner = node.hasAttribute('data-cascade-id') ? node : (node.closest && node.closest('[data-cascade-id]'));
      if (owner) {
        var ownerCid = owner.getAttribute('data-cascade-id') || '';
        // Started conversations carry a UUID; unstarted New-Chat views in App 2.32.1 use literal "conversation"
        if (idPattern.test(ownerCid)) continue;
      }

      if (hasStartedView) {
        var inHome = Boolean(node.closest && node.closest('[data-testid="home-greeting"], .agy-home'));
        var inUnstartedConv = Boolean(node.closest && node.closest('[data-testid="conversation-view"]'));
        if (!inHome && !inUnstartedConv) continue;
      }

      if (isSubagentComposer(node)) continue;
      return node;
    }
    return null;
  }

  function applyThemeClass(el) {
    if (!el || !el.classList) return;
    var light = isLightTheme();
    if (light && !el.classList.contains('agy-theme-light')) {
      el.classList.add('agy-theme-light');
    } else if (!light && el.classList.contains('agy-theme-light')) {
      el.classList.remove('agy-theme-light');
    }
  }

  function ensureMenuMounted() {
    if (!doc.body) return null;
    injectStyles();
    var menu = doc.getElementById('agy-new-chat-persona-menu');
    if (menu && menu.parentElement === doc.body) {
      applyThemeClass(menu);
      return menu;
    }
    if (menu && menu.parentElement) menu.parentElement.removeChild(menu);

    menu = doc.createElement('div');
    menu.id = 'agy-new-chat-persona-menu';
    menu.className = 'agy-ncp-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', '新会话初始角色');
    menu.setAttribute('data-ag-localization-skip', 'true');
    menu.style.display = 'none';
    applyThemeClass(menu);

    var caption = doc.createElement('div');
    caption.className = 'agy-ncp-menu-caption';
    caption.setAttribute('role', 'presentation');
    caption.textContent = '新会话初始角色';
    menu.appendChild(caption);

    for (var i = 0; i < PERSONA_OPTIONS.length; i++) {
      (function (opt) {
        var optBtn = doc.createElement('button');
        optBtn.type = 'button';
        optBtn.className = 'agy-ncp-opt';
        optBtn.setAttribute('role', 'option');
        optBtn.setAttribute('data-persona-option', opt.mode);
        optBtn.setAttribute('aria-selected', draftMode === opt.mode ? 'true' : 'false');

        var main = doc.createElement('span');
        main.className = 'agy-ncp-opt-main';

        var iconWrap = doc.createElement('span');
        iconWrap.className = 'agy-ncp-opt-icon';
        iconWrap.appendChild(createPersonaIconSvg(opt.mode, 14));

        var textWrap = doc.createElement('span');
        textWrap.className = 'agy-ncp-opt-text';

        var title = doc.createElement('span');
        title.className = 'agy-ncp-opt-title';
        title.textContent = opt.label;

        var sub = doc.createElement('span');
        sub.className = 'agy-ncp-opt-sub';
        sub.textContent = opt.sub;

        textWrap.appendChild(title);
        textWrap.appendChild(sub);
        main.appendChild(iconWrap);
        main.appendChild(textWrap);

        var checkWrap = doc.createElement('span');
        checkWrap.className = 'agy-ncp-opt-check';
        checkWrap.appendChild(createCheckSvg());

        optBtn.appendChild(main);
        optBtn.appendChild(checkWrap);

        optBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          clearPendingTicket();
          userTouchedDraft = true;
          draftMode = opt.mode === 'normal' ? 'normal' : 'hakimi';
          syncUiState();
          closeMenu(true);
        });

        menu.appendChild(optBtn);
      })(PERSONA_OPTIONS[i]);
    }

    menu.addEventListener('keydown', function (ev) {
      var k = ev.key;
      if (k === 'Tab') {
        closeMenu(false);
        return;
      }
      if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
      var opts = menu.querySelectorAll('.agy-ncp-opt');
      if (!opts || opts.length === 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      var curIdx = -1;
      for (var oi = 0; oi < opts.length; oi++) {
        if (opts[oi] === doc.activeElement) {
          curIdx = oi;
          break;
        }
      }
      if (curIdx === -1) {
        for (var si = 0; si < opts.length; si++) {
          if (opts[si].getAttribute('aria-selected') === 'true') {
            curIdx = si;
            break;
          }
        }
      }
      var nextIdx = 0;
      if (k === 'ArrowDown') nextIdx = (curIdx + 1) % opts.length;
      else if (k === 'ArrowUp') nextIdx = (curIdx - 1 + opts.length) % opts.length;
      else if (k === 'Home') nextIdx = 0;
      else if (k === 'End') nextIdx = opts.length - 1;
      if (opts[nextIdx] && typeof opts[nextIdx].focus === 'function') {
        opts[nextIdx].focus();
      }
    });

    doc.body.appendChild(menu);
    return menu;
  }

  function positionMenu() {
    var menu = doc.getElementById('agy-new-chat-persona-menu');
    var btn = doc.getElementById('agy-new-chat-persona-btn');
    if (!menu || !btn || !menuOpen) return;

    var vw = Number(root.innerWidth) || 1024;
    var vh = Number(root.innerHeight) || 768;
    var menuWidth = Math.min(208, Math.max(160, vw - 16));
    menu.style.width = menuWidth + 'px';

    if (typeof btn.getBoundingClientRect !== 'function') return;
    var rect = btn.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      menu.style.right = '16px';
      menu.style.bottom = '52px';
      menu.style.left = '';
      menu.style.top = '';
      return;
    }

    var left = rect.left;
    if (left + menuWidth > vw - 8) {
      left = Math.max(8, rect.right - menuWidth);
    }
    left = Math.max(8, Math.min(left, vw - menuWidth - 8));
    menu.style.left = Math.round(left) + 'px';
    menu.style.right = '';

    if (rect.top < 132) {
      menu.style.top = Math.round(rect.bottom + 6) + 'px';
      menu.style.bottom = '';
    } else {
      menu.style.bottom = Math.round(vh - rect.top + 6) + 'px';
      menu.style.top = '';
    }
  }

  function syncUiState() {
    var wrap = doc.getElementById('agy-new-chat-persona');
    if (wrap) applyThemeClass(wrap);

    var btn = doc.getElementById('agy-new-chat-persona-btn');
    if (btn) {
      var modeLabel = draftMode === 'normal' ? '正常助手' : '哈基米';
      if (btn.getAttribute('data-persona-mode') !== draftMode) {
        btn.setAttribute('data-persona-mode', draftMode);
        var oldIcon = btn.querySelector('.agy-ncp-icon');
        var nextIcon = createPersonaIconSvg(draftMode, 13);
        if (oldIcon && oldIcon.parentNode === btn) {
          btn.replaceChild(nextIcon, oldIcon);
        } else {
          btn.insertBefore(nextIcon, btn.firstChild);
        }
        var lbl = btn.querySelector('.agy-ncp-label');
        if (lbl) lbl.textContent = modeLabel;
        btn.setAttribute('aria-label', '新会话初始角色：' + modeLabel);
      }
      var expanded = menuOpen ? 'true' : 'false';
      if (btn.getAttribute('aria-expanded') !== expanded) {
        btn.setAttribute('aria-expanded', expanded);
      }
    }

    var menu = doc.getElementById('agy-new-chat-persona-menu');
    if (menu) {
      applyThemeClass(menu);
      var opts = menu.querySelectorAll('[data-persona-option]');
      for (var i = 0; i < opts.length; i++) {
        var optEl = opts[i];
        var sel = optEl.getAttribute('data-persona-option') === draftMode ? 'true' : 'false';
        if (optEl.getAttribute('aria-selected') !== sel) {
          optEl.setAttribute('aria-selected', sel);
        }
      }
      var nextDisplay = menuOpen ? 'block' : 'none';
      if (menu.style.display !== nextDisplay) {
        menu.style.display = nextDisplay;
      }
    }
  }

  function openMenu() {
    var btn = doc.getElementById('agy-new-chat-persona-btn');
    if (!btn || !newFooter()) return;
    try {
      if (typeof root.CustomEvent === 'function') {
        doc.dispatchEvent(new root.CustomEvent('agy-hud-close-popovers'));
      }
      if (root.__AGY_HUD__) {
        if (typeof root.__AGY_HUD__.setPopoverOpen === 'function') root.__AGY_HUD__.setPopoverOpen(false);
        if (typeof root.__AGY_HUD__.setTopPopoverOpen === 'function') root.__AGY_HUD__.setTopPopoverOpen(false);
      }
    } catch (_) {}
    var menu = ensureMenuMounted();
    menuOpen = true;
    syncUiState();
    positionMenu();
    if (menu) {
      var activeOpt = menu.querySelector('[data-persona-option="' + draftMode + '"]') || menu.querySelector('.agy-ncp-opt');
      if (activeOpt && typeof activeOpt.focus === 'function') {
        try { activeOpt.focus(); } catch (_) {}
      }
    }
  }

  function closeMenu(restoreFocus) {
    if (!menuOpen) {
      var m = doc.getElementById('agy-new-chat-persona-menu');
      if (m && m.style.display !== 'none') m.style.display = 'none';
      var b = doc.getElementById('agy-new-chat-persona-btn');
      if (b && b.getAttribute('aria-expanded') !== 'false') b.setAttribute('aria-expanded', 'false');
      return;
    }
    menuOpen = false;
    syncUiState();
    if (restoreFocus) {
      var btn = doc.getElementById('agy-new-chat-persona-btn');
      if (btn && typeof btn.focus === 'function') {
        try { btn.focus(); } catch (_) {}
      }
    }
  }

  function setMenuOpen(open) {
    if (open) openMenu();
    else closeMenu(false);
  }

  function removeMountedUi() {
    closeMenu();
    var existing = doc.getElementById('agy-new-chat-persona');
    if (existing && existing.parentElement) {
      existing.parentElement.removeChild(existing);
    }
    var menu = doc.getElementById('agy-new-chat-persona-menu');
    if (menu && menu.parentElement) {
      menu.parentElement.removeChild(menu);
    }
  }

  function sync() {
    if (destroyed) return;
    expireStalePending();
    // Fallback commit if optimistic navigation mounted a brand-new [data-testid="conversation-view"][data-cascade-id]
    if (pending && !pending.committed) {
      var mountedId = detectNewViewCascadeId(pending.knownIds);
      if (mountedId) {
        pending.committed = true;
        var pSnap = pending;
        pending = null;
        var fallbackFetcher = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
        commitPersona(fallbackFetcher, null, null, mountedId, pSnap.mode, pSnap.token);
      }
    }

    var footer = newFooter();
    if (!footer) {
      if (hasActiveStartedView()) sawStartedView = true;
      currentFooter = null;
      removeMountedUi();
      return;
    }

    injectStyles();
    if (sawStartedView) {
      draftMode = defaultMode;
      userTouchedDraft = false;
      menuOpen = false;
      sawStartedView = false;
      syncDefaultPersona();
    }
    currentFooter = footer;

    ensureMenuMounted();

    var existing = doc.getElementById('agy-new-chat-persona');
    if (existing && existing.parentElement === footer) {
      try {
        var hudClusterExisting = doc.getElementById('agy-hud-footer-cluster');
        if (hudClusterExisting && hudClusterExisting.parentElement === footer && existing.nextElementSibling !== hudClusterExisting) {
          footer.insertBefore(existing, hudClusterExisting);
        }
      } catch (_) {}
      syncUiState();
      if (menuOpen) positionMenu();
      return;
    }
    if (existing && existing.parentElement) {
      existing.parentElement.removeChild(existing);
    }

    var wrap = doc.createElement('div');
    wrap.id = 'agy-new-chat-persona';
    wrap.className = 'agy-ncp-wrap';
    wrap.setAttribute('data-ag-localization-skip', 'true');
    applyThemeClass(wrap);

    var modeLabel = draftMode === 'normal' ? '正常助手' : '哈基米';
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.id = 'agy-new-chat-persona-btn';
    btn.className = 'agy-ncp-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    btn.setAttribute('aria-label', '新会话初始角色：' + modeLabel);
    btn.setAttribute('data-persona-mode', draftMode);
    btn.title = '新会话初始角色（创建后仍可在 HUD 切换）';

    btn.appendChild(createPersonaIconSvg(draftMode, 13));
    var labelSpan = doc.createElement('span');
    labelSpan.className = 'agy-ncp-label';
    labelSpan.textContent = modeLabel;
    btn.appendChild(labelSpan);
    btn.appendChild(createChevronSvg());

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (menuOpen) closeMenu();
      else openMenu();
    });

    btn.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        ev.stopPropagation();
        setMenuOpen(true);
      }
    });

    wrap.appendChild(btn);

    try {
      var hudCluster = doc.getElementById('agy-hud-footer-cluster');
      var anchor = (hudCluster && hudCluster.parentElement === footer) ? hudCluster : footer.lastElementChild;
      if (anchor) footer.insertBefore(wrap, anchor);
      else footer.appendChild(wrap);
    } catch (_) {}

    syncUiState();
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = root.setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, ms);
      Promise.resolve(promise).then(
        function (v) { if (!done) { done = true; root.clearTimeout(t); resolve(v); } },
        function () { if (!done) { done = true; root.clearTimeout(t); resolve(null); } }
      );
    });
  }

  function getBridge() {
    var b = root.__AGY_PERSONA_BRIDGE__;
    return (b && typeof b === 'object') ? b : null;
  }

  function syncDefaultPersona() {
    try {
      var b = getBridge();
      if (b && typeof b.getDefault === 'function') {
        Promise.resolve(b.getDefault()).then(function (res) {
          if (destroyed) return;
          var m = res && (res.mode || res);
          if (m === 'hakimi' || m === 'normal') {
            defaultMode = m;
            if (!userTouchedDraft && !pending) {
              draftMode = defaultMode;
              syncUiState();
            }
          }
        }).catch(function () {});
      }
    } catch (_) {}
  }

  function stagePersona(mode, token) {
    try {
      var bridge = getBridge();
      if (bridge && typeof bridge.stageNew === 'function') {
        return withTimeout(bridge.stageNew(mode, token), 120);
      }
    } catch (_) {}
    return Promise.resolve(null);
  }

  function cancelPersona(token) {
    try {
      var bridge = getBridge();
      if (bridge && typeof bridge.cancelNew === 'function' && token) {
        Promise.resolve(bridge.cancelNew(token)).catch(function () {});
      }
    } catch (_) {}
  }

  function clearPendingTicket() {
    if (!pending) return;
    var tok = !pending.committed ? pending.token : null;
    pending = null;
    if (tok) cancelPersona(tok);
  }

  function expireStalePending() {
    if (pending && pending.createdAt && (Date.now() - pending.createdAt > PENDING_TTL_MS)) {
      clearPendingTicket();
    }
  }

  async function saveViaHttpFallback(fetcher, input, init, id, mode) {
    if (typeof fetcher !== 'function' || !input) return false;
    try {
      var rawUrl = typeof input === 'string' ? input : input.url;
      if (!rawUrl) return false;
      var url = new URL(rawUrl, (root.location && root.location.href) || 'https://localhost');
      var headers = new root.Headers((init && init.headers) || (input && input.headers) || {});
      headers.set('Content-Type', 'application/json');
      headers.set('Connect-Protocol-Version', '1');
      headers.delete('Content-Length');
      headers.delete('Content-Encoding');
      var service = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
      var sidecars = await withTimeout(fetcher(new URL(service + 'GetSidecars', url).href, { method: 'POST', headers: headers, body: '{}' }), 400);
      if (!sidecars || !sidecars.ok) return false;
      var list = await sidecars.json();
      var hud = ((list && list.sidecars) || []).find(function (s) { return s && s.sidecarId === 'agy-hud/telemetry'; });
      if (!hud || !hud.baseUrl) return false;
      var target = new URL(hud.baseUrl);
      if (['localhost', '127.0.0.1', '[::1]'].indexOf(target.hostname) === -1) return false;
      var sidecarTok = target.searchParams.get('token') || '';
      target.pathname = '/api/persona';
      target.searchParams.set('conversationId', id);
      var postHeaders = { 'Content-Type': 'application/json', 'X-AGY-Persona': '1' };
      if (sidecarTok) postHeaders['X-Sidecar-Token'] = sidecarTok;
      var res = await withTimeout(fetcher(target.href, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({ mode: mode })
      }), 400);
      return Boolean(res && res.ok);
    } catch (_) {
      return false;
    }
  }

  function commitPersona(fetcher, input, init, id, mode, token) {
    if (!id || !idPattern.test(id)) return Promise.resolve(false);
    var normId = id.toLowerCase();
    var existing = bindings.get(normId);
    var targetMode = existing ? existing.mode : (mode === 'normal' ? 'normal' : 'hakimi');
    if (existing && existing.saved) return existing.saved;

    if (!existing && bindings.size >= 128) {
      var oldestKey = bindings.keys().next().value;
      if (oldestKey !== undefined) bindings.delete(oldestKey);
    }

    var record = existing || { mode: targetMode, saved: null };
    bindings.set(normId, record);

    record.saved = (async function () {
      try {
        var bridge = getBridge();
        if (bridge && typeof bridge.commitNew === 'function') {
          var ipcRes = await withTimeout(bridge.commitNew(id, targetMode, token), 300);
          if (ipcRes && ipcRes.ok) return true;
        }
        return await saveViaHttpFallback(fetcher, input, init, id, targetMode);
      } catch (_) {
        return false;
      }
    })();

    return record.saved;
  }

  function handleGlobalClickCapture(ev) {
    var t = ev && ev.target;
    if (menuOpen && t) {
      if (t.closest && t.closest('#agy-hud-toggle-btn, #agy-hud-topbar-btn')) {
        closeMenu();
      } else {
        var wrap = doc.getElementById('agy-new-chat-persona');
        var menu = doc.getElementById('agy-new-chat-persona-menu');
        if ((!wrap || !wrap.contains(t)) && (!menu || !menu.contains(t))) {
          closeMenu();
        }
      }
    }
  }

  function capture(ev) {
    try {
      if (ev.type === 'click') {
        handleGlobalClickCapture(ev);
      } else if (ev.type === 'keydown' && ev.key === 'Escape' && menuOpen) {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu(true);
        return;
      }

      var footer = newFooter();
      if (!footer || !ev.target) return;
      if (ev.target.closest && ev.target.closest('#agy-new-chat-persona, #agy-new-chat-persona-menu')) return;

      if (ev.type === 'keydown') {
        if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
        var tb = ev.target.closest ? ev.target.closest('[contenteditable="true"],textarea,[role="textbox"]') : null;
        if (!tb || isSubagentOrSideComposer(tb)) return;
        var box = findComposerContainer(footer);
        if (!box || !box.contains(tb)) return;
      } else if (ev.type === 'click') {
        if (!footer.contains(ev.target)) return;
        if (ev.target.closest && ev.target.closest('#agy-hud-footer-cluster, #agy-new-chat-persona, #agy-new-chat-persona-menu')) return;
        var sendMatch = ev.target.closest ? ev.target.closest('.agy-send-button,[data-testid="send-button"],button') : null;
        if (!sendMatch) return;
        var btn = (ev.target.closest && ev.target.closest('button')) || sendMatch;
        if (btn.disabled || (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true')) return;
        // Click inside composer footer: only trigger on actual send button (rightCluster itself or its last child)
        if (!ev.target.closest('.agy-send-button,[data-testid="send-button"]')) {
          var rightCluster = footer.lastElementChild;
          var isRightSendBtn = Boolean(
            rightCluster && btn && (btn === rightCluster || btn === rightCluster.lastElementChild)
          );
          if (!isRightSendBtn) return;
          var btnMeta = [
            btn.id || '',
            typeof btn.className === 'string' ? btn.className : '',
            (btn.getAttribute && btn.getAttribute('aria-label')) || '',
            (btn.getAttribute && btn.getAttribute('title')) || ''
          ].join(' ');
          if (/turbo|voice|mic|audio|attach|model|persona/i.test(btnMeta)) return;
        }
      } else {
        return;
      }

      if (menuOpen) closeMenu();
      if (pending && !pending.committed && pending.token) {
        cancelPersona(pending.token);
      }
      var tok = makeToken();
      pending = {
        mode: draftMode,
        token: tok,
        staged: true,
        committed: false,
        createdAt: Date.now(),
        knownIds: snapshotViewCascadeIds()
      };
      stagePersona(draftMode, tok);
    } catch (_) {}
  }

  function addTrackedListener(target, type, fn, capturePhase) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, capturePhase);
    cleanupFns.push(function () {
      if (typeof target.removeEventListener === 'function') {
        target.removeEventListener(type, fn, capturePhase);
      }
    });
  }

  function onThemeChange() {
    var wrap = doc.getElementById('agy-new-chat-persona');
    var menu = doc.getElementById('agy-new-chat-persona-menu');
    if (wrap) applyThemeClass(wrap);
    if (menu) applyThemeClass(menu);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (observer) {
      try { observer.disconnect(); } catch (_) {}
      observer = null;
    }
    while (cleanupFns.length > 0) {
      var fn = cleanupFns.pop();
      try { fn(); } catch (_) {}
    }
    removeMountedUi();
  }

  addTrackedListener(doc, 'keydown', capture, true);
  addTrackedListener(doc, 'click', capture, true);
  addTrackedListener(doc, 'agy-ncp-close-menu', function () {
    if (menuOpen) closeMenu();
  });
  addTrackedListener(doc, 'agy-hud-theme-change', onThemeChange);
  addTrackedListener(root, 'storage', function (ev) {
    if (ev && ev.key === 'agy_hud_theme_v2') onThemeChange();
  });
  addTrackedListener(root, 'resize', function () {
    if (menuOpen) closeMenu();
  });
  addTrackedListener(root, 'pagehide', destroy);

  async function toBytesSafe(body) {
    if (body == null) return null;
    try {
      if (typeof body === 'string') return new root.TextEncoder().encode(body);
      if (body instanceof root.ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)) {
        return new Uint8Array(body);
      }
      if (ArrayBuffer.isView(body)) {
        return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      }
      var isBlob = (typeof root.Blob === 'function' && body instanceof root.Blob) ||
                   (typeof Blob !== 'undefined' && body instanceof Blob);
      if (isBlob && typeof body.arrayBuffer === 'function') {
        return new Uint8Array(await body.arrayBuffer());
      }
    } catch (_) {}
    return null;
  }

  function parseProtobufSlice(bytes, checkForkFields) {
    var pos = 0;
    var foundId = null;
    var isFork = false;

    function readVarint() {
      var low = 0;
      var shift = 0;
      var count = 0;
      while (pos < bytes.length && count < 10) {
        var b = bytes[pos++];
        if (shift < 28) {
          low |= (b & 0x7f) << shift;
        }
        count++;
        if ((b & 0x80) === 0) return low >>> 0;
        shift += 7;
      }
      return null;
    }

    while (pos < bytes.length) {
      var tag = readVarint();
      if (tag === null || tag === 0) return null;
      var wire = tag & 7;
      var field = tag >>> 3;
      if (wire === 0) {
        if (readVarint() === null) return null;
      } else if (wire === 1) {
        if (pos + 8 > bytes.length) return null;
        pos += 8;
      } else if (wire === 5) {
        if (pos + 4 > bytes.length) return null;
        pos += 4;
      } else if (wire === 2) {
        var len = readVarint();
        if (len === null || pos + len > bytes.length) return null;
        if (checkForkFields && (field === 3 || field === 12) && len > 0) {
          // Only treat as fork if field 3 is NOT workspace_uris (uri starts with file://)
          var str3 = new root.TextDecoder().decode(bytes.subarray(pos, pos + len));
          if (!/^file:\/\//i.test(str3) && idPattern.test(str3)) {
            isFork = true;
          } else if (field === 12 && len > 0 && uuidScanPattern.test(str3)) {
            isFork = true;
          }
        }
        // Only extract cascade_id from StartCascadeResponse (!checkForkFields); StartCascadeRequest reserves cascade_id
        // and may carry unrelated 36-byte UUIDs (e.g. senderWindowId / projectId) in other fields.
        if (!checkForkFields && len === 36) {
          var candidate = new root.TextDecoder().decode(bytes.subarray(pos, pos + 36));
          if (idPattern.test(candidate)) {
            if (field === 1) {
              foundId = candidate;
            } else if (!foundId) {
              foundId = candidate;
            }
          }
        }
        pos += len;
      } else {
        return null;
      }
    }
    return { isFork: isFork, id: foundId };
  }

  function inspectPayloadBytes(bytes, checkForkFields) {
    if (!bytes || bytes.length === 0) return { isFork: false, id: null };
    try {
      var text = new root.TextDecoder().decode(bytes);
      var trimmed = text.trim();
      if (trimmed.charCodeAt(0) === 123) { // '{'
        var json = JSON.parse(trimmed);
        if (checkForkFields && (json.parentConversationId || json.baseTrajectoryIdentifier)) {
          return { isFork: true, id: null };
        }
        if (json.cascadeId && idPattern.test(json.cascadeId)) {
          return { isFork: false, id: json.cascadeId };
        }
        return { isFork: false, id: null };
      }
    } catch (_) {}

    // Check Connect 5-byte envelope ([flags:1][length:4 big-endian]) first if applicable
    if (bytes.length >= 5 && (bytes[0] === 0 || bytes[0] === 2)) {
      var frameLen = ((bytes[1] << 24) >>> 0) + ((bytes[2] << 16) >>> 0) + (bytes[3] << 8) + bytes[4];
      if (frameLen > 0 && 5 + frameLen <= bytes.length) {
        var framedRes = parseProtobufSlice(bytes.subarray(5, 5 + frameLen), checkForkFields);
        if (framedRes) return framedRes;
      }
    }

    var directRes = parseProtobufSlice(bytes, checkForkFields);
    if (directRes) return directRes;

    // Safe regex fallback for response bodies containing a cascade UUID
    if (!checkForkFields) {
      try {
        var rawTxt = new root.TextDecoder().decode(bytes);
        var m = rawTxt.match(uuidScanPattern);
        if (m && idPattern.test(m[0])) return { isFork: false, id: m[0] };
      } catch (_) {}
    }
    return { isFork: false, id: null };
  }

  async function inspectRequestSafe(input, init) {
    try {
      var body = init && init.body;
      if (body == null && input && typeof input.clone === 'function') {
        body = await input.clone().arrayBuffer();
      }
      var bytes = await toBytesSafe(body);
      return inspectPayloadBytes(bytes, true);
    } catch (_) {
      return { isFork: false, id: null };
    }
  }

  async function extractResponseIdSafe(response) {
    try {
      if (!response || typeof response.clone !== 'function') return null;
      var buf = await response.clone().arrayBuffer();
      var info = inspectPayloadBytes(new Uint8Array(buf), false);
      return info && info.id ? info.id : null;
    } catch (_) {
      return null;
    }
  }

  function wrap(fetcher) {
    if (typeof fetcher !== 'function' || fetcher.__agyPersonaWrapped) return fetcher;
    async function wrapped(input, init) {
      var raw = '';
      try {
        raw = typeof input === 'string' ? input : (input && input.url) || '';
      } catch (_) {}

      if (!raw || !/\/StartCascade(?:\?|$)/i.test(raw)) {
        return fetcher.call(root, input, init);
      }

      expireStalePending();
      var chosen = pending || (newFooter() ? { mode: draftMode, token: makeToken(), staged: false, committed: false } : null);
      if (!chosen) {
        return fetcher.call(root, input, init);
      }

      var reqInfo = await inspectRequestSafe(input, init);
      if (reqInfo.isFork) {
        return fetcher.call(root, input, init);
      }

      var boundFetcher = fetcher.bind(root);
      var token = chosen.token || makeToken();

      try {
        if (reqInfo.id) {
          // Request already carries cascadeId (e.g. legacy or mock): commit before StartCascade, never throwing
          await commitPersona(boundFetcher, input, init, reqInfo.id, chosen.mode, token);
          chosen.committed = true;
        } else if (!chosen.staged) {
          chosen.staged = true;
          await stagePersona(chosen.mode, token);
        }
      } catch (_) {}

      if (pending === chosen) pending = null;
      draftMode = defaultMode;
      userTouchedDraft = false;
      closeMenu();
      syncUiState();

      var response;
      try {
        response = await fetcher.call(root, input, init);
      } catch (netErr) {
        if (!reqInfo.id) cancelPersona(token);
        throw netErr;
      }

      // Real Antigravity returns cascade_id in StartCascadeResponse; extract & commit without blocking caller
      if (!reqInfo.id) {
        extractResponseIdSafe(response)
          .then(function (resId) {
            if (resId) {
              chosen.committed = true;
              return commitPersona(boundFetcher, input, init, resId, chosen.mode, token);
            }
          })
          .catch(function () {});
      }

      return response;
    }
    wrapped.__agyPersonaWrapped = true;
    return wrapped;
  }

  // Retain Antigravity's native loopback fetch bridge while wrapping cleanly
  try {
    var activeFetch = wrap(root.fetch);
    Object.defineProperty(root, 'fetch', {
      configurable: true,
      enumerable: true,
      get: function () { return activeFetch; },
      set: function (value) { activeFetch = wrap(value); }
    });
  } catch (_) {
    if (typeof root.fetch === 'function') {
      root.fetch = wrap(root.fetch);
    }
  }

  root.__AGY_NEW_CHAT_PERSONA__ = {
    sync: sync,
    getDraftMode: function () { return draftMode; },
    setDraftMode: function (m) {
      clearPendingTicket();
      userTouchedDraft = true;
      draftMode = m === 'normal' ? 'normal' : 'hakimi';
      syncUiState();
    },
    setMenuOpen: setMenuOpen,
    openMenu: openMenu,
    closeMenu: closeMenu,
    destroy: destroy
  };

  function start() {
    if (destroyed) return;
    syncDefaultPersona();
    sync();
    if (!doc.body || typeof root.MutationObserver !== 'function') return;
    var scheduled = false;
    observer = new root.MutationObserver(function (changes) {
      if (scheduled || destroyed) return;
      var shouldSync = false;
      for (var i = 0; i < changes.length; i++) {
        var ch = changes[i];
        var t = ch.target;
        if (ch.type === 'attributes' && ch.attributeName === 'class') {
          if (t && t.id === 'agy-hud-footer-cluster') {
            onThemeChange();
          }
          continue;
        }
        if (t && t.closest && t.closest('#agy-new-chat-persona, #agy-new-chat-persona-menu')) {
          continue;
        }
        shouldSync = true;
        break;
      }
      if (!shouldSync) return;
      scheduled = true;
      root.setTimeout(function () {
        scheduled = false;
        if (!destroyed) sync();
      }, 16);
    });
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-cascade-id', 'aria-placeholder', 'placeholder', 'data-placeholder', 'data-aux-pane-open', 'data-side-panel-open', 'class']
    });
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : null);
